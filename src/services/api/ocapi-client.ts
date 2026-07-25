// Client for Cine Colombia's Vista Open Commerce API (OCAPI).
//
// Endpoints were derived by recording the website's own network traffic. They are
// internal and unversioned in practice, so every response is treated as
// potentially incomplete and mapped into our own domain types.

import { DEFAULTS } from '../../config/constants.js';
import { ApiError, NetworkError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type {
  Film,
  FilmsResponse,
  RawCastMember,
  RawCensorRating,
  RawGenre,
  RawShowtime,
  SeatAvailability,
  SeatAvailabilityResponse,
  SeatLayout,
  SeatLayoutResponse,
  Showtime,
  ShowtimesResponse,
  SitesResponse,
  Theatre,
  TicketPricesResponse,
  TicketType,
} from '../../types/cine.js';
import type {
  ItemProfileResponse,
  Member,
  MemberOrder,
  MemberOrdersResponse,
  MemberResponse,
  MenuSection,
} from '../../types/member.js';
import {
  type MemberSessionStore,
  isSessionExpiredError,
  memberSession,
} from '../auth/member-session.js';
import { type TokenProvider, tokenProvider } from '../auth/token-provider.js';
import { type CacheManager, cache } from '../cache/cache-manager.js';
import {
  indexBy,
  toFilm,
  toSeatAvailability,
  toSeatLayout,
  toShowtime,
  toTheatre,
  toTicketTypes,
} from './mappers.js';
import { toMember, toMemberOrders, toMenuSections } from './member-mappers.js';

/**
 * Short, stable, filesystem-safe identifier for a request path.
 *
 * Showtime queries carry long repeated `siteIds` lists that would otherwise blow
 * past filename length limits, so the path is folded into a hash instead.
 */
function hashKey(value: string): string {
  return Bun.hash(value).toString(36);
}

export interface ShowtimeQuery {
  /** Restrict to specific films. Omit for every film. */
  filmIds?: string[];
  /** Restrict to specific theatres. Omit for the whole country. */
  theatreIds?: string[];
}

/** Opt out of the disk cache for a single call. */
export interface CacheOptions {
  /** Fetch fresh data and overwrite whatever is cached. */
  refresh?: boolean;
}

export class OcapiClient {
  constructor(
    private auth: TokenProvider = tokenProvider,
    private store: CacheManager = cache,
    private member: MemberSessionStore = memberSession
  ) {}

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  /**
   * The signed-in member's profile, or null when logged out.
   *
   * Doubles as the session check: the endpoint answers 401 without the member
   * cookie, so a null result means "not logged in" rather than "no data".
   */
  async getMember(): Promise<Member | null> {
    if (!this.member.isLoggedIn()) return null;

    try {
      const data = await this.request<MemberResponse>('/ocapi/v1/members/current');
      return toMember(data.member);
    } catch (error) {
      // 401 means the cookie was not accepted; the 403 below means it was accepted
      // and has since expired. Both mean "not signed in" to a caller.
      if (error instanceof ApiError && error.status === 401) return null;
      if (isSessionExpiredError(error)) {
        this.member.markExpired();
        return null;
      }
      throw error;
    }
  }

  /** Orders on the account that have not been used yet. */
  async getActiveOrders(): Promise<MemberOrder[]> {
    if (!this.member.isLoggedIn()) return [];

    try {
      const data = await this.request<MemberOrdersResponse>(
        '/ocapi/v1/members/current/completed-orders/active'
      );
      return toMemberOrders(data);
    } catch (error) {
      if (isSessionExpiredError(error)) {
        this.member.markExpired();
        return [];
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Concessions
  // -------------------------------------------------------------------------

  /**
   * The food and drink menu for a theatre, as the theatre itself organises it.
   *
   * Sections come straight from the venue ("Confiteria", "Sushi", "Cinepolitana",
   * "Juan Valdez"), which is more durable than guessing at product names.
   */
  async getMenu(theatreId: string, options: CacheOptions = {}): Promise<MenuSection[]> {
    return this.store.remember(
      'menu',
      async () => {
        const data = await this.request<ItemProfileResponse>(
          `/ocapi/v1/sites/${encodeURIComponent(theatreId)}/item-profile`
        );
        return toMenuSections(data);
      },
      { key: theatreId, force: options.refresh }
    );
  }

  // -------------------------------------------------------------------------
  // Theatres
  // -------------------------------------------------------------------------

  /**
   * Every site known to OCAPI, including a few that never sell tickets
   * (top-up counters). Check `sellsTickets` before offering one for booking.
   */
  async getTheatres(options: CacheOptions = {}): Promise<Theatre[]> {
    return this.store.remember(
      'sites',
      async () => {
        const data = await this.request<SitesResponse>('/ocapi/v1/sites');
        return (data.sites ?? []).map(toTheatre);
      },
      { force: options.refresh }
    );
  }

  // -------------------------------------------------------------------------
  // Films
  // -------------------------------------------------------------------------

  /**
   * Films currently listed on the site, with genres, ratings and cast resolved
   * from the `relatedData` lookup tables the API returns alongside them.
   */
  async getFilms(options: CacheOptions = {}): Promise<Film[]> {
    return this.store.remember(
      'films',
      async () => {
        const data = await this.request<FilmsResponse>('/ocapi/v1/films');

        const genres = indexBy(data.relatedData?.genres ?? [], (g: RawGenre) => g.id);
        const ratings = indexBy(
          data.relatedData?.censorRatings ?? [],
          (r: RawCensorRating) => r.id
        );
        const cast = indexBy(data.relatedData?.castAndCrew ?? [], (m: RawCastMember) => m.id);

        return (data.films ?? []).map((film) => toFilm(film, genres, ratings, cast));
      },
      { force: options.refresh }
    );
  }

  // -------------------------------------------------------------------------
  // Showtimes
  // -------------------------------------------------------------------------

  /**
   * Showtimes for a given business date.
   *
   * A cinema "business date" runs past midnight, so a 1:00 AM screening belongs
   * to the previous calendar day. Pass `'first'` to let the API return the next
   * date that actually has screenings, which avoids empty results when a film
   * is not showing today.
   *
   * @param date `YYYY-MM-DD`, or `'first'` for the next available date.
   */
  async getShowtimes(
    date: string | 'first' = 'first',
    query: ShowtimeQuery = {},
    options: CacheOptions = {}
  ): Promise<{ businessDate: string; showtimes: Showtime[] }> {
    const params = new URLSearchParams();
    // Sort so that logically identical queries produce one cache entry.
    for (const filmId of [...(query.filmIds ?? [])].sort()) params.append('filmIds', filmId);
    // OCAPI names theatres "sites" on the wire.
    for (const theatreId of [...(query.theatreIds ?? [])].sort()) {
      params.append('siteIds', theatreId);
    }

    const suffix = params.toString() ? `?${params}` : '';
    const path = `/ocapi/v1/showtimes/by-business-date/${encodeURIComponent(date)}${suffix}`;

    return this.store.remember(
      'showtimes',
      async () => {
        const data = await this.request<ShowtimesResponse>(path);
        return {
          businessDate: data.businessDate,
          showtimes: (data.showtimes ?? []).map(toShowtime),
        };
      },
      { key: hashKey(path), force: options.refresh }
    );
  }

  /** A single showtime by its composite id, e.g. `6461-18673`. */
  async getShowtime(showtimeId: string): Promise<Showtime> {
    const data = await this.request<RawShowtime | { showtime: RawShowtime }>(
      `/ocapi/v1/showtimes/${encodeURIComponent(showtimeId)}`
    );
    const raw = 'showtime' in data ? data.showtime : data;
    return toShowtime(raw);
  }

  /**
   * Seating chart for a showtime.
   *
   * This is the physical layout of the screen: which seats exist, their row and
   * number labels, and which pricing area they belong to. It does not include
   * live availability.
   */
  async getSeatLayout(showtimeId: string, options: CacheOptions = {}): Promise<SeatLayout> {
    return this.store.remember(
      'seatLayout',
      async () => {
        const data = await this.request<SeatLayoutResponse>(
          `/ocapi/v1/showtimes/${encodeURIComponent(showtimeId)}/seat-layout`
        );
        return toSeatLayout(data.seatLayout);
      },
      { key: showtimeId, force: options.refresh }
    );
  }

  /**
   * Live occupancy for a showtime.
   *
   * Complements `getSeatLayout`: the layout says which seats exist, this says
   * which are free. Barely cached, because showing a taken seat as available
   * sends someone to the wrong chair.
   *
   * **This endpoint is eventually consistent**, and `refresh: true` does not help
   * because the lag is on their side, not in this cache. Measured against the live
   * API around a reservation:
   *
   *   holding a seat  -> still reported free at +12ms, reported taken at ~1.8s
   *   cancelling      -> reported free again within a few seconds
   *
   * So a read taken immediately after a write will contradict the write. Do not
   * use this to confirm that an order succeeded or that a cancellation released
   * the seats; the order endpoints are the authority. Give it a couple of seconds
   * before trusting it as a fresh view.
   */
  async getSeatAvailability(
    showtimeId: string,
    options: CacheOptions = {}
  ): Promise<SeatAvailability> {
    const raw = await this.store.remember(
      'seatAvailability',
      () =>
        this.request<SeatAvailabilityResponse>(
          `/ocapi/v1/showtimes/${encodeURIComponent(showtimeId)}/seat-availability`
        ),
      { key: showtimeId, force: options.refresh }
    );

    // Mapped after caching because a Map does not survive JSON serialisation.
    return toSeatAvailability(raw);
  }

  /** Ticket categories and prices offered for a showtime, in COP. */
  async getTicketTypes(showtimeId: string, options: CacheOptions = {}): Promise<TicketType[]> {
    return this.store.remember(
      'ticketPrices',
      async () => {
        const data = await this.request<TicketPricesResponse>(
          `/ocapi/v1/showtimes/${encodeURIComponent(showtimeId)}/ticket-prices`
        );
        return toTicketTypes(data);
      },
      { key: showtimeId, force: options.refresh }
    );
  }

  /**
   * Business dates on which a film screens at the given theatres.
   *
   * Cheaper than probing `getShowtimes` date by date when all you need to know
   * is which days are worth asking about.
   */
  async getScreeningDates(
    filmId: string,
    theatreIds: string[],
    options: CacheOptions = {}
  ): Promise<string[]> {
    const params = new URLSearchParams();
    params.append('filmIds', filmId);
    for (const theatreId of [...theatreIds].sort()) params.append('siteIds', theatreId);

    const path = `/ocapi/v1/film-screening-dates?${params}`;

    return this.store.remember(
      'screeningDates',
      async () => {
        const data = await this.request<{
          filmScreeningDates?: Array<{ businessDate: string }>;
        }>(path);
        return (data.filmScreeningDates ?? []).map((entry) => entry.businessDate);
      },
      { key: hashKey(path), force: options.refresh }
    );
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /** Convenience wrapper for reads. */
  private request<T>(path: string, retryOnAuthFailure = true): Promise<T> {
    return this.send<T>('GET', path, undefined, retryOnAuthFailure);
  }

  /**
   * Perform an authenticated request against OCAPI.
   *
   * A 401 means the cached token expired earlier than its `exp` claim suggested
   * (or was revoked), so we refresh once and retry before giving up.
   *
   * Only reads are retried automatically. Replaying a write could create a second
   * order or double-charge, so a failed write surfaces to the caller instead.
   */
  async send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    retryOnAuthFailure = true
  ): Promise<T> {
    const { token, apiUrl } = await this.auth.getCredentials();
    const url = `${apiUrl}${path}`;

    let response: Response;
    try {
      logger.debug(method, url, body ? JSON.stringify(body) : '');
      // When logged in, the member cookie travels with every call. It is what turns
      // an anonymous request into one made as the account holder; the bearer token
      // itself carries no user identity.
      const cookie = this.member.cookieHeader();

      response = await fetch(url, {
        method,
        headers: {
          authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
          accept: 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULTS.timeout),
      });
    } catch (error) {
      throw new NetworkError(
        'API_UNREACHABLE',
        `No se pudo contactar la API de Cine Colombia: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    // Only replay idempotent reads; see the note on this method.
    if (response.status === 401 && retryOnAuthFailure && method === 'GET') {
      logger.debug('Token rechazado (401), renovando y reintentando');
      this.auth.invalidate();
      await this.auth.getCredentials(true);
      return this.send<T>(method, path, body, false);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => undefined);
      throw new ApiError(
        'API_ERROR',
        `La API respondió ${response.status} en ${path}`,
        response.status,
        detail
      );
    }

    // 204 and empty bodies are normal for writes such as setting the customer.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** Shared instance for command modules. */
export const cineApi = new OcapiClient();
