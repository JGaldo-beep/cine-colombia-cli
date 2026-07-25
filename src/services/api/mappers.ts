// Translation layer between OCAPI's wire format and our domain model.
//
// Kept separate from the HTTP client so the shape handling can be tested against
// fixtures without touching the network. Every mapper is defensive: OCAPI is an
// internal, unversioned API, so missing or null fields are expected rather than
// exceptional.

import { normalizeText } from '../../lib/text.js';
import type {
  Film,
  RawCastMember,
  RawCensorRating,
  RawFilm,
  RawGenre,
  RawSeatLayout,
  RawShowtime,
  RawSite,
  SeatAvailability,
  SeatAvailabilityResponse,
  SeatLayout,
  Showtime,
  Theatre,
  TicketPricesResponse,
  TicketType,
} from '../../types/cine.js';

export function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [key(item), item]));
}

export function toTheatre(site: RawSite): Theatre {
  const address = [site.contactDetails?.address?.line1, site.contactDetails?.address?.line2]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(', ');

  return {
    id: site.id,
    name: site.name?.text ?? site.id,
    city: normaliseCity(site.contactDetails?.address?.city ?? ''),
    address,
    email: site.contactDetails?.email ?? null,
    location: site.location,
    timeZone: site.ianaTimeZoneName,
    // OCAPI lists non-theatre entries such as top-up counters. They report
    // sellable items but have no coordinates and no screens, so requiring a
    // location is what separates real cinemas from them.
    sellsTickets: site.hasSellableItems && site.location !== null,
  };
}

/**
 * Colombian departments, used to tell a city apart from a region.
 *
 * Normalised (lowercase, unaccented) for direct comparison.
 */
const DEPARTMENTS = new Set(
  [
    'Amazonas',
    'Antioquia',
    'Arauca',
    'Atlántico',
    'Bolívar',
    'Boyacá',
    'Caldas',
    'Caquetá',
    'Casanare',
    'Cauca',
    'Cesar',
    'Chocó',
    'Córdoba',
    'Cundinamarca',
    'Guainía',
    'Guaviare',
    'Huila',
    'La Guajira',
    'Magdalena',
    'Meta',
    'Nariño',
    'Norte de Santander',
    'Putumayo',
    'Quindío',
    'Risaralda',
    'San Andrés y Providencia',
    'Santander',
    'Sucre',
    'Tolima',
    'Valle del Cauca',
    'Vaupés',
    'Vichada',
  ].map(normalizeText)
);

/**
 * Reduce OCAPI's irregular "City, Department" strings to just the city.
 *
 * The live data is inconsistent: "Bogotá, Cundinamarca", "Bogotá,Cundinamarca"
 * and "Cundinamarca, Bogotá" all appear. Taking the first segment blindly would
 * file the LUMINA theatre under the city "Cundinamarca" and drop it from Bogotá
 * results, so we pick the first segment that is not a department name.
 */
export function normaliseCity(raw: string): string {
  const segments = raw
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const city = segments.find((segment) => !DEPARTMENTS.has(normalizeText(segment)));
  return city ?? segments[0] ?? raw.trim();
}

export function toFilm(
  film: RawFilm,
  genres: Map<string, RawGenre>,
  ratings: Map<string, RawCensorRating>,
  cast: Map<string, RawCastMember>
): Film {
  const rating = film.censorRatingId ? ratings.get(film.censorRatingId) : undefined;

  return {
    id: film.id,
    title: film.title?.text ?? film.id,
    // Spanish release titles arrive as a translation of the original title.
    localTitle: film.title?.translations?.[0]?.text ?? null,
    synopsis: film.synopsis?.text ?? film.shortSynopsis?.text ?? null,
    runtimeMinutes: film.runtimeInMinutes ?? null,
    releaseDate: film.releaseDate ?? null,
    // Prefer the wordy description ("Recomendada para Mayores de 12 años") over
    // the terse classification code, since that is what audiences recognise.
    rating: rating?.classificationDescription?.text ?? rating?.classification?.text ?? null,
    minimumAge: rating?.ageRestriction?.minimumAge ?? null,
    genres: (film.genreIds ?? [])
      .map((id) => genres.get(id)?.name?.text)
      .filter((name): name is string => Boolean(name)),
    cast: (film.castAndCrew ?? [])
      .filter((member) => member.roles?.includes('Actor'))
      .map((member) => formatPersonName(cast.get(member.castAndCrewMemberId)))
      .filter((name): name is string => Boolean(name)),
    trailerUrl: film.trailerUrl ?? film.trailers?.[0]?.uri ?? null,
  };
}

export function formatPersonName(member: RawCastMember | undefined): string | null {
  if (!member) return null;
  const name = [member.name?.givenName, member.name?.middleName, member.name?.familyName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ');
  return name || null;
}

export function toShowtime(raw: RawShowtime): Showtime {
  return {
    id: raw.id,
    filmId: raw.filmId,
    theatreId: raw.siteId,
    screenId: raw.screenId,
    startsAt: raw.schedule?.startsAt,
    endsAt: raw.schedule?.endsAt,
    businessDate: raw.schedule?.businessDate,
    isSoldOut: raw.isSoldOut,
    requires3dGlasses: raw.requires3dGlasses,
    hasAssignedSeating: raw.isAllocatedSeating,
    seatLayoutId: raw.seatLayoutId,
  };
}

export function toSeatAvailability(response: SeatAvailabilityResponse): SeatAvailability {
  const entries = response.seatAvailabilities ?? [];

  return {
    statuses: new Map(entries.map((entry) => [entry.seatId, entry.status])),
    // Prefer the API's own counts, but fall back to counting so a missing summary
    // does not silently report zero seats free.
    availableCount:
      response.summary?.availableCount ??
      entries.filter((entry) => entry.status === 'Available').length,
    totalCount: response.summary?.totalCount ?? entries.length,
    isSoldOut: response.isSoldOut ?? false,
  };
}

export function toTicketTypes(response: TicketPricesResponse): TicketType[] {
  const names = indexBy(response.relatedData?.ticketTypes ?? [], (type) => type.id);

  return (response.ticketPrices ?? [])
    .map((price) => {
      const type = names.get(price.ticketTypeId);
      return {
        id: price.ticketTypeId,
        name: type?.name?.text ?? type?.description?.text ?? price.ticketTypeId,
        price: price.price?.valueIncludingTax ?? 0,
        bookingFee: price.bookingFee?.valueIncludingTax ?? null,
        // Note: several types report isDefault simultaneously, because the flag is
        // the default *per seating area* rather than for the showtime as a whole.
        // It is kept as data but must not be presented as "the" default.
        isDefault: price.isDefault ?? false,
        displayPriority: price.displayPriority ?? Number.MAX_SAFE_INTEGER,
        // Restricted types need a voucher, loyalty card or promo we cannot supply,
        // so they must not be offered as if they were freely selectable.
        isRestricted: (price.restrictions?.length ?? 0) > 0 || price.discountId !== null,
      };
    })
    .sort(
      (a, b) =>
        // Unrestricted types first: those are the ones anyone can actually buy.
        Number(a.isRestricted) - Number(b.isRestricted) ||
        a.displayPriority - b.displayPriority ||
        a.price - b.price
    );
}

/**
 * Flatten a seat layout, ordering areas from the screen backwards.
 *
 * OCAPI does not state which end of the room the screen is on, so the ordering
 * was derived from two independent signals that agree. At Andino screen 6:
 *
 *   - GENERAL sits at y 92.0–99.83 with rows numbered 1..5 labelled E..A
 *   - PREFERENCIAL sits at y 85.83–91.66 with rows numbered 1..3 labelled H..F
 *
 * Row A is conventionally the front row, and A lives in the area with the *larger*
 * y, so larger y means closer to the screen. Sorting areas by descending y and
 * rows by descending number yields A,B,C,D,E,F,G,H — the alphabetical front-to-back
 * order every cinema uses. Two unrelated signals agreeing is the reason to trust it.
 *
 * Row ordering itself is applied at render time; here we only order the areas.
 */
export function toSeatLayout(layout: RawSeatLayout): SeatLayout {
  const areas = [...(layout.areas ?? [])].sort(
    (a, b) => (b.boundary?.top ?? 0) - (a.boundary?.top ?? 0)
  );

  return {
    id: layout.id,
    screenId: layout.screenId,
    areas: areas.map((area) => {
      const areaName = area.name?.text ?? `Área ${area.number}`;
      return {
        name: areaName,
        rowCount: area.rowCount,
        columnCount: area.columnCount,
        seats: (area.rows ?? []).flatMap((row) =>
          (row.seats ?? []).map((seat) => ({
            id: seat.id,
            row: seat.rowLabel ?? row.label,
            number: seat.label,
            areaName,
            rowIndex: seat.position?.rowNumber ?? row.number,
            columnIndex: seat.position?.columnNumber ?? 0,
          }))
        ),
      };
    }),
  };
}
