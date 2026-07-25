import { describe, expect, it } from 'bun:test';
import {
  indexBy,
  normaliseCity,
  toFilm,
  toSeatAvailability,
  toSeatLayout,
  toShowtime,
  toTheatre,
  toTicketTypes,
} from '../src/services/api/mappers.js';
import type {
  RawCastMember,
  RawCensorRating,
  RawFilm,
  RawGenre,
  RawSeatLayout,
  RawShowtime,
  RawSite,
} from '../src/types/cine.js';

function localized(text: string, translations: Array<{ languageTag: string; text: string }> = []) {
  return { text, translations };
}

describe('normaliseCity', () => {
  it('drops the department from the usual "City, Department" form', () => {
    expect(normaliseCity('Bogotá, Cundinamarca')).toBe('Bogotá');
    expect(normaliseCity('Medellín, Antioquia')).toBe('Medellín');
    expect(normaliseCity('Cali, Valle del Cauca')).toBe('Cali');
  });

  it('handles the missing space seen in the live data', () => {
    expect(normaliseCity('Bogotá,Cundinamarca')).toBe('Bogotá');
  });

  it('recovers the city when the API lists it after the department', () => {
    // Theatre 6183 (LUMINA) is stored this way; taking the first segment would
    // file it under the city "Cundinamarca" and hide it from Bogotá results.
    expect(normaliseCity('Cundinamarca, Bogotá')).toBe('Bogotá');
  });

  it('tolerates unaccented department names', () => {
    expect(normaliseCity('Atlantico, Barranquilla')).toBe('Barranquilla');
  });

  it('passes through a bare city name', () => {
    expect(normaliseCity('Chía')).toBe('Chía');
  });

  it('falls back to the first segment when everything looks like a department', () => {
    expect(normaliseCity('Cundinamarca')).toBe('Cundinamarca');
  });

  it('handles empty input without throwing', () => {
    expect(normaliseCity('')).toBe('');
  });
});

describe('toTheatre', () => {
  const site: RawSite = {
    id: '6493',
    name: localized('ANDINO'),
    location: { latitude: 4.6668, longitude: -74.0536 },
    contactDetails: {
      phoneNumbers: [],
      email: '6493@cinecolombia.com',
      address: { line1: 'Carrera 12 # 82-02', line2: '', city: 'Bogotá, Cundinamarca' },
    },
    ianaTimeZoneName: 'America/Bogota',
    hasSellableItems: true,
    allowedItemDeliveryMethods: [],
  };

  it('flattens the wire format into the domain model', () => {
    const theatre = toTheatre(site);
    expect(theatre.id).toBe('6493');
    expect(theatre.name).toBe('ANDINO');
    expect(theatre.city).toBe('Bogotá');
    expect(theatre.address).toBe('Carrera 12 # 82-02');
    expect(theatre.sellsTickets).toBe(true);
  });

  it('joins both address lines when the second is populated', () => {
    const theatre = toTheatre({
      ...site,
      contactDetails: {
        ...site.contactDetails,
        address: { ...site.contactDetails.address, line2: 'Local 201' },
      },
    });
    expect(theatre.address).toBe('Carrera 12 # 82-02, Local 201');
  });

  it('treats a site without coordinates as not selling tickets', () => {
    // Top-up counters report sellable items but are not cinemas.
    const counter = toTheatre({ ...site, name: localized('PORTAL - RECARGAS'), location: null });
    expect(counter.sellsTickets).toBe(false);
  });

  it('respects an explicit hasSellableItems of false', () => {
    expect(toTheatre({ ...site, hasSellableItems: false }).sellsTickets).toBe(false);
  });
});

describe('toFilm', () => {
  const genres = indexBy<RawGenre>(
    [
      { id: 'G1', name: localized('Terror'), description: null },
      { id: 'G2', name: localized('Drama'), description: null },
    ],
    (g) => g.id
  );

  const ratings = indexBy<RawCensorRating>(
    [
      {
        id: 'R1',
        classification: localized('12'),
        classificationDescription: localized('Recomendada para Mayores de 12 años'),
        ageRestriction: { minimumAge: 12 },
      },
    ],
    (r) => r.id
  );

  const cast = indexBy<RawCastMember>(
    [
      { id: 'C1', name: { givenName: 'Matt', familyName: 'Damon', middleName: null } },
      { id: 'C2', name: { givenName: 'Anne', familyName: 'Hathaway', middleName: null } },
      { id: 'C3', name: { givenName: 'Chris', familyName: 'Nolan', middleName: null } },
    ],
    (m) => m.id
  );

  const raw: RawFilm = {
    id: 'HO00000386',
    title: localized('The Odyssey', [{ languageTag: 'en', text: 'La Odisea' }]),
    synopsis: localized('Una odisea.'),
    shortSynopsis: localized('Corta.'),
    censorRatingId: 'R1',
    censorRatingNote: null,
    releaseDate: '2026-05-14',
    runtimeInMinutes: 172,
    trailers: [{ provider: 'Moviexchange', uri: 'https://cdn/trailer' }],
    trailerUrl: null,
    displayPriority: 1,
    castAndCrew: [
      { castAndCrewMemberId: 'C1', roles: ['Actor'] },
      { castAndCrewMemberId: 'C2', roles: ['Actor'] },
      { castAndCrewMemberId: 'C3', roles: ['Director'] },
    ],
    genreIds: ['G2'],
  };

  it('resolves the Spanish title from the translation list', () => {
    const film = toFilm(raw, genres, ratings, cast);
    expect(film.title).toBe('The Odyssey');
    expect(film.localTitle).toBe('La Odisea');
  });

  it('resolves genre, rating and age from the lookup tables', () => {
    const film = toFilm(raw, genres, ratings, cast);
    expect(film.genres).toEqual(['Drama']);
    expect(film.rating).toBe('Recomendada para Mayores de 12 años');
    expect(film.minimumAge).toBe(12);
  });

  it('includes only actors in the cast, not crew', () => {
    const film = toFilm(raw, genres, ratings, cast);
    expect(film.cast).toEqual(['Matt Damon', 'Anne Hathaway']);
    expect(film.cast).not.toContain('Chris Nolan');
  });

  it('prefers the full synopsis over the short one', () => {
    expect(toFilm(raw, genres, ratings, cast).synopsis).toBe('Una odisea.');
  });

  it('falls back to the short synopsis when the full one is missing', () => {
    const film = toFilm({ ...raw, synopsis: null }, genres, ratings, cast);
    expect(film.synopsis).toBe('Corta.');
  });

  it('falls back to the first trailer when trailerUrl is null', () => {
    expect(toFilm(raw, genres, ratings, cast).trailerUrl).toBe('https://cdn/trailer');
  });

  it('survives missing lookup entries and empty collections', () => {
    const sparse: RawFilm = {
      ...raw,
      censorRatingId: 'DESCONOCIDO',
      genreIds: ['NO_EXISTE'],
      castAndCrew: [],
      trailers: [],
      runtimeInMinutes: null,
      synopsis: null,
      shortSynopsis: null,
    };
    const film = toFilm(sparse, genres, ratings, cast);
    expect(film.rating).toBeNull();
    expect(film.genres).toEqual([]);
    expect(film.cast).toEqual([]);
    expect(film.trailerUrl).toBeNull();
    expect(film.runtimeMinutes).toBeNull();
    expect(film.synopsis).toBeNull();
  });

  it('omits cast members missing from the lookup table', () => {
    const film = toFilm(
      { ...raw, castAndCrew: [{ castAndCrewMemberId: 'FANTASMA', roles: ['Actor'] }] },
      genres,
      ratings,
      cast
    );
    expect(film.cast).toEqual([]);
  });
});

describe('toShowtime', () => {
  const raw: RawShowtime = {
    id: '6461-18673',
    schedule: {
      businessDate: '2026-07-24',
      startsAt: '2026-07-24T19:30:00-05:00',
      endsAt: '2026-07-24T22:22:00-05:00',
      filmStartsAt: '2026-07-24T19:30:00-05:00',
      filmEndsAt: '2026-07-24T22:22:00-05:00',
    },
    isSoldOut: false,
    seatLayoutId: '6461-14-24',
    filmId: 'HO00000386',
    siteId: '6461',
    screenId: '6461-14',
    areaCategories: [],
    attributeIds: [],
    isAllocatedSeating: true,
    requires3dGlasses: false,
    eventId: null,
    restrictions: [],
  };

  it('renames the wire "siteId" to the domain "theatreId"', () => {
    const showtime = toShowtime(raw);
    expect(showtime.theatreId).toBe('6461');
    expect(showtime.filmId).toBe('HO00000386');
  });

  it('lifts the schedule fields to the top level', () => {
    const showtime = toShowtime(raw);
    expect(showtime.startsAt).toBe('2026-07-24T19:30:00-05:00');
    expect(showtime.businessDate).toBe('2026-07-24');
  });

  it('carries the flags the UI depends on', () => {
    const showtime = toShowtime({ ...raw, isSoldOut: true, requires3dGlasses: true });
    expect(showtime.isSoldOut).toBe(true);
    expect(showtime.requires3dGlasses).toBe(true);
    expect(showtime.hasAssignedSeating).toBe(true);
  });
});

describe('toSeatLayout', () => {
  const raw: RawSeatLayout = {
    id: '6461-14-24',
    screenId: '6461-14',
    areas: [
      {
        number: 1,
        areaCategoryId: 'AC1',
        name: localized('GENERAL'),
        columnCount: 2,
        rowCount: 1,
        rows: [
          {
            number: 1,
            label: 'H',
            seats: [
              {
                id: '1_1_1',
                position: { areaNumber: 1, columnNumber: 1, rowNumber: 1 },
                seatGroupIds: [],
                label: '1',
                rowLabel: 'H',
                areaCategoryId: 'AC1',
              },
              {
                id: '1_1_2',
                position: { areaNumber: 1, columnNumber: 2, rowNumber: 1 },
                seatGroupIds: [],
                label: '2',
                rowLabel: 'H',
                areaCategoryId: 'AC1',
              },
            ],
          },
        ],
      },
    ],
  };

  it('flattens rows into a seat list tagged with its area', () => {
    const layout = toSeatLayout(raw);
    expect(layout.areas).toHaveLength(1);
    expect(layout.areas[0]?.name).toBe('GENERAL');
    expect(layout.areas[0]?.seats).toHaveLength(2);
    expect(layout.areas[0]?.seats[0]).toMatchObject({
      row: 'H',
      number: '1',
      areaName: 'GENERAL',
    });
  });

  it('names an unnamed area by its number', () => {
    const layout = toSeatLayout({
      ...raw,
      // biome-ignore lint/suspicious/noExplicitAny: exercising a malformed payload on purpose.
      areas: [{ ...raw.areas[0], name: undefined } as any],
    });
    expect(layout.areas[0]?.name).toBe('Área 1');
  });

  it('handles a layout with no areas', () => {
    const layout = toSeatLayout({ ...raw, areas: [] });
    expect(layout.areas).toEqual([]);
  });
});

describe('indexBy', () => {
  it('builds a lookup keyed by the chosen field', () => {
    const map = indexBy([{ id: 'a' }, { id: 'b' }], (item) => item.id);
    expect(map.get('a')).toEqual({ id: 'a' });
    expect(map.size).toBe(2);
  });

  it('returns an empty map for an empty list', () => {
    expect(indexBy([], (item: { id: string }) => item.id).size).toBe(0);
  });
});

describe('toSeatAvailability', () => {
  const response = {
    seatAvailabilities: [
      { seatId: '1_1_1', status: 'Available' },
      { seatId: '1_1_2', status: 'Sold' },
      { seatId: '1_1_3', status: 'Broken' },
    ],
    summary: { totalCount: 3, availableCount: 1 },
    areaCategorySummaries: [],
    isSoldOut: false,
  };

  it('indexes statuses by seat id for O(1) lookup while rendering', () => {
    const availability = toSeatAvailability(response);
    expect(availability.statuses.get('1_1_1')).toBe('Available');
    expect(availability.statuses.get('1_1_2')).toBe('Sold');
    expect(availability.statuses.size).toBe(3);
  });

  it('uses the API summary counts', () => {
    const availability = toSeatAvailability(response);
    expect(availability.availableCount).toBe(1);
    expect(availability.totalCount).toBe(3);
  });

  it('counts seats itself when the summary is missing', () => {
    // Never report zero free seats just because a summary was absent.
    const availability = toSeatAvailability({
      ...response,
      summary: undefined,
    } as unknown as Parameters<typeof toSeatAvailability>[0]);
    expect(availability.availableCount).toBe(1);
    expect(availability.totalCount).toBe(3);
  });

  it('handles an empty response', () => {
    const availability = toSeatAvailability({
      seatAvailabilities: [],
      summary: { totalCount: 0, availableCount: 0 },
      areaCategorySummaries: [],
      isSoldOut: true,
    });
    expect(availability.statuses.size).toBe(0);
    expect(availability.isSoldOut).toBe(true);
  });
});

describe('toTicketTypes', () => {
  const response = {
    ticketPrices: [
      {
        ticketTypeId: 'T2',
        price: { valueIncludingTax: 19500, valueExcludingTax: 19500, tax: 0 },
        isDefault: true,
        bookingFee: null,
        restrictions: [],
        displayPriority: 2,
        discountId: null,
      },
      {
        ticketTypeId: 'T1',
        price: { valueIncludingTax: 15500, valueExcludingTax: 15500, tax: 0 },
        isDefault: true,
        bookingFee: { valueIncludingTax: 1600 },
        restrictions: [],
        displayPriority: 1,
        discountId: null,
      },
      {
        ticketTypeId: 'T3',
        price: { valueIncludingTax: 0, valueExcludingTax: 0, tax: 0 },
        isDefault: false,
        bookingFee: null,
        restrictions: ['LoyaltyOnly'],
        displayPriority: 3,
        discountId: null,
      },
    ],
    relatedData: {
      ticketTypes: [
        { id: 'T1', name: localized('Silla General') },
        { id: 'T2', name: localized('Silla Preferencial') },
        { id: 'T3', name: localized('2D Premio General') },
      ],
    },
  };

  it('resolves names from relatedData', () => {
    const types = toTicketTypes(response);
    expect(types.find((t) => t.id === 'T1')?.name).toBe('Silla General');
  });

  it('reads the price with tax included and the separate booking fee', () => {
    const general = toTicketTypes(response).find((t) => t.id === 'T1');
    expect(general?.price).toBe(15500);
    expect(general?.bookingFee).toBe(1600);
  });

  it('flags types that need a voucher or promotion as restricted', () => {
    const types = toTicketTypes(response);
    expect(types.find((t) => t.id === 'T3')?.isRestricted).toBe(true);
    expect(types.find((t) => t.id === 'T1')?.isRestricted).toBe(false);
  });

  it('puts unrestricted types first, then follows displayPriority', () => {
    // T2 is listed before T1 in the payload but has a later displayPriority.
    expect(toTicketTypes(response).map((t) => t.id)).toEqual(['T1', 'T2', 'T3']);
  });

  it('treats a discount as a restriction', () => {
    const discounted = toTicketTypes({
      ...response,
      ticketPrices: [{ ...response.ticketPrices[1], discountId: 'D1', restrictions: [] }],
    } as unknown as Parameters<typeof toTicketTypes>[0]);
    expect(discounted[0]?.isRestricted).toBe(true);
  });

  it('falls back to the id when no name is published', () => {
    const types = toTicketTypes({ ...response, relatedData: {} } as unknown as Parameters<
      typeof toTicketTypes
    >[0]);
    expect(types.find((t) => t.id === 'T1')?.name).toBe('T1');
  });
});
