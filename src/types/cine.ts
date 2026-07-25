// Domain types for Cine Colombia, derived from live Vista OCAPI responses.
//
// OCAPI wraps almost every human-readable string in a `LocalizedText` object and
// returns lookup tables (genres, ratings, cast) separately under `relatedData`,
// referenced by id. The `Raw*` types mirror the wire format faithfully; the
// domain types below are the flattened, resolved shapes the CLI actually works
// with.

// ---------------------------------------------------------------------------
// Wire format (raw OCAPI)
// ---------------------------------------------------------------------------

export interface LocalizedText {
  text: string;
  translations: Array<{ languageTag: string; text: string }>;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
}

export interface RawSite {
  id: string;
  name: LocalizedText;
  /** Null for a handful of non-theatre entries such as top-up counters. */
  location: GeoLocation | null;
  contactDetails: {
    phoneNumbers: string[];
    email: string | null;
    address: { line1: string; line2: string; city: string };
  };
  ianaTimeZoneName: string;
  hasSellableItems: boolean;
  allowedItemDeliveryMethods: string[];
}

export interface RawFilm {
  id: string;
  title: LocalizedText;
  synopsis: LocalizedText | null;
  shortSynopsis: LocalizedText | null;
  censorRatingId: string | null;
  censorRatingNote: string | null;
  releaseDate: string | null;
  runtimeInMinutes: number | null;
  trailers: Array<{ provider: string; uri: string }>;
  trailerUrl: string | null;
  displayPriority: number | null;
  castAndCrew: Array<{ castAndCrewMemberId: string; roles: string[] }>;
  genreIds?: string[];
}

export interface RawGenre {
  id: string;
  name: LocalizedText;
  description: LocalizedText | null;
}

export interface RawCensorRating {
  id: string;
  classification: LocalizedText;
  classificationDescription: LocalizedText | null;
  ageRestriction: { minimumAge: number } | null;
}

export interface RawCastMember {
  id: string;
  name: { givenName: string | null; familyName: string | null; middleName: string | null };
}

export interface RawShowtime {
  id: string;
  schedule: {
    businessDate: string;
    startsAt: string;
    endsAt: string;
    filmStartsAt: string;
    filmEndsAt: string;
  };
  isSoldOut: boolean;
  seatLayoutId: string | null;
  filmId: string;
  siteId: string;
  screenId: string;
  areaCategories: Array<{ areaCategoryId: string; isAllocatedSeating: boolean }>;
  attributeIds: string[];
  isAllocatedSeating: boolean;
  requires3dGlasses: boolean;
  eventId: string | null;
  restrictions: string[];
}

export interface RawSeat {
  id: string;
  position: { areaNumber: number; columnNumber: number; rowNumber: number };
  seatGroupIds: string[];
  label: string;
  rowLabel: string;
  areaCategoryId: string;
}

export interface RawSeatLayoutArea {
  number: number;
  areaCategoryId: string;
  name: LocalizedText;
  columnCount: number;
  rowCount: number;
  /**
   * Position of the area on the layout canvas.
   *
   * `top` is the minimum y of the area. Larger y means closer to the screen —
   * see `toSeatLayout` for how this was established.
   */
  boundary?: { left: number; top: number; right: number; bottom: number };
  rows: Array<{ number: number; label: string; seats: RawSeat[] }>;
}

export interface RawSeatLayout {
  id: string;
  screenId: string;
  areas: RawSeatLayoutArea[];
}

/**
 * Occupancy of a single seat.
 *
 * Observed values are `Available`, `Sold` and `Broken`. The union stays open
 * because Vista deployments also emit states such as social-distancing blocks,
 * and an unknown state must never be rendered as bookable.
 */
export type SeatStatus = 'Available' | 'Sold' | 'Broken' | (string & {});

export interface RawSeatAvailability {
  seatId: string;
  status: SeatStatus;
}

export interface RawTicketPrice {
  ticketTypeId: string;
  price: { valueIncludingTax: number; valueExcludingTax: number; tax: number };
  isDefault: boolean;
  bookingFee: { valueIncludingTax: number } | null;
  restrictions: string[];
  displayPriority: number | null;
  discountId: string | null;
}

export interface RawTicketType {
  id: string;
  name?: LocalizedText;
  description?: LocalizedText;
}

// Envelope shapes returned by each endpoint.
export interface SitesResponse {
  sites: RawSite[];
}

export interface FilmsResponse {
  films: RawFilm[];
  relatedData?: {
    genres?: RawGenre[];
    censorRatings?: RawCensorRating[];
    castAndCrew?: RawCastMember[];
  };
}

export interface ShowtimesResponse {
  businessDate: string;
  showtimes: RawShowtime[];
  relatedData?: Record<string, unknown>;
}

export interface SeatLayoutResponse {
  seatLayout: RawSeatLayout;
  relatedData?: Record<string, unknown>;
}

export interface SeatAvailabilityResponse {
  seatAvailabilities: RawSeatAvailability[];
  summary: { totalCount: number; availableCount: number };
  areaCategorySummaries: Array<{
    areaCategoryId: string;
    totalCount: number;
    availableCount: number;
  }>;
  isSoldOut: boolean;
}

export interface TicketPricesResponse {
  ticketPrices: RawTicketPrice[];
  relatedData?: { ticketTypes?: RawTicketType[] };
}

// ---------------------------------------------------------------------------
// Domain model (flattened, what commands consume)
// ---------------------------------------------------------------------------

/** A physical cinema. */
export interface Theatre {
  id: string;
  name: string;
  city: string;
  address: string;
  email: string | null;
  location: GeoLocation | null;
  timeZone: string;
  /** False for entries that exist in OCAPI but never sell tickets. */
  sellsTickets: boolean;
}

/** A film currently listed, with lookup ids already resolved to names. */
export interface Film {
  id: string;
  /** Original title as distributed. */
  title: string;
  /** Spanish release title when the API provides a translation. */
  localTitle: string | null;
  synopsis: string | null;
  runtimeMinutes: number | null;
  releaseDate: string | null;
  /** e.g. "Recomendada para Mayores de 12 años". */
  rating: string | null;
  minimumAge: number | null;
  genres: string[];
  cast: string[];
  trailerUrl: string | null;
}

/** A single screening at a given theatre. */
export interface Showtime {
  id: string;
  filmId: string;
  theatreId: string;
  screenId: string;
  /** Local start time as an ISO string with the theatre's offset. */
  startsAt: string;
  endsAt: string;
  businessDate: string;
  isSoldOut: boolean;
  requires3dGlasses: boolean;
  hasAssignedSeating: boolean;
  seatLayoutId: string | null;
}

/** One seat in a screen's layout. */
export interface Seat {
  id: string;
  /** Row label as printed on the ticket, e.g. "H". */
  row: string;
  /** Seat number within the row, e.g. "12". */
  number: string;
  areaName: string;
  rowIndex: number;
  columnIndex: number;
}

/** A screen's seating chart, grouped by pricing/comfort area. */
export interface SeatLayout {
  id: string;
  screenId: string;
  /** Ordered from closest to the screen to furthest away. */
  areas: Array<{
    name: string;
    rowCount: number;
    columnCount: number;
    seats: Seat[];
  }>;
}

/** Live occupancy for a showtime, keyed by seat id. */
export interface SeatAvailability {
  /** Seat id (`"1_5_18"`) to its current status. */
  statuses: Map<string, SeatStatus>;
  availableCount: number;
  totalCount: number;
  isSoldOut: boolean;
}

/** A purchasable ticket category with its price in COP. */
export interface TicketType {
  id: string;
  name: string;
  /** Price per ticket, tax included, in Colombian pesos. */
  price: number;
  /** Booking fee charged on top, when the API reports one separately. */
  bookingFee: number | null;
  /**
   * The default for its seating area.
   *
   * Several types can report this at once, one per area, so it does not identify
   * a single default for the showtime.
   */
  isDefault: boolean;
  /** True when the type needs a voucher, membership or promotion to be used. */
  isRestricted: boolean;
  /** Ordering hint from the API; lower comes first. */
  displayPriority: number;
}
