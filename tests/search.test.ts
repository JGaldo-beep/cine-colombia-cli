import { describe, expect, it } from 'bun:test';
import {
  distanceKm,
  filterByCity,
  listCities,
  normalizeText,
  searchFilms,
  searchTheatres,
} from '../src/lib/search.js';
import { blankToUndefined } from '../src/lib/text.js';
import type { Film, Theatre } from '../src/types/cine.js';

function makeFilm(overrides: Partial<Film> & Pick<Film, 'id' | 'title'>): Film {
  return {
    localTitle: null,
    synopsis: null,
    runtimeMinutes: null,
    releaseDate: null,
    rating: null,
    minimumAge: null,
    genres: [],
    cast: [],
    trailerUrl: null,
    ...overrides,
  };
}

function makeTheatre(overrides: Partial<Theatre> & Pick<Theatre, 'id' | 'name'>): Theatre {
  return {
    city: 'Bogotá',
    address: '',
    email: null,
    location: null,
    timeZone: 'America/Bogota',
    sellsTickets: true,
    ...overrides,
  };
}

const films: Film[] = [
  makeFilm({ id: 'HO00000386', title: 'The Odyssey', localTitle: 'La Odisea' }),
  makeFilm({ id: 'HO00000496', title: 'Moana', localTitle: 'Moana' }),
  makeFilm({
    id: 'HO00000600',
    title: 'Spider-Man: Brand New Day',
    localTitle: 'Spider Man Un Nuevo Dia',
  }),
  makeFilm({ id: 'HO00000715', title: 'Habitante', localTitle: 'Habitante' }),
];

describe('normalizeText', () => {
  it('strips accents so terminal-friendly input matches', () => {
    expect(normalizeText('Bogotá')).toBe('bogota');
    expect(normalizeText('MEDELLÍN')).toBe('medellin');
    expect(normalizeText('Los futbolísimos')).toBe('los futbolisimos');
  });

  it('collapses whitespace and trims', () => {
    expect(normalizeText('  La   Odisea  ')).toBe('la odisea');
  });
});

describe('searchFilms', () => {
  it('finds a film by its Spanish title regardless of accents or case', () => {
    expect(searchFilms(films, 'odisea')[0]?.id).toBe('HO00000386');
    expect(searchFilms(films, 'LA ODÍSEA')[0]?.id).toBe('HO00000386');
  });

  it('finds a film by its original title', () => {
    expect(searchFilms(films, 'odyssey')[0]?.id).toBe('HO00000386');
  });

  it('matches an exact id and ranks it first', () => {
    expect(searchFilms(films, 'HO00000496')[0]?.id).toBe('HO00000496');
    expect(searchFilms(films, 'ho00000496')[0]?.id).toBe('HO00000496');
  });

  it('ranks an exact title above a mere substring match', () => {
    const catalogue = [
      makeFilm({ id: 'A', title: 'Moana en el mar', localTitle: 'Moana en el mar' }),
      makeFilm({ id: 'B', title: 'Moana', localTitle: 'Moana' }),
    ];
    expect(searchFilms(catalogue, 'moana')[0]?.id).toBe('B');
  });

  it('matches on a word boundary, so a mid-title word still ranks well', () => {
    expect(searchFilms(films, 'nuevo')[0]?.id).toBe('HO00000600');
  });

  it('returns every film for an empty query', () => {
    expect(searchFilms(films, '')).toHaveLength(films.length);
    expect(searchFilms(films, '   ')).toHaveLength(films.length);
  });

  it('returns nothing when there is no match', () => {
    expect(searchFilms(films, 'zzzznoexiste')).toEqual([]);
  });
});

describe('searchTheatres', () => {
  const theatres = [
    makeTheatre({ id: '6493', name: 'ANDINO' }),
    makeTheatre({ id: '6536', name: 'METRÓPOLIS' }),
    makeTheatre({ id: '6411', name: 'SANTAFE MEDELLIN', city: 'Medellín' }),
  ];

  it('matches by name, ignoring accents', () => {
    expect(searchTheatres(theatres, 'metropolis')[0]?.id).toBe('6536');
  });

  it('matches by exact id', () => {
    expect(searchTheatres(theatres, '6493')[0]?.id).toBe('6493');
  });

  it('matches by city name', () => {
    expect(searchTheatres(theatres, 'medellin')[0]?.id).toBe('6411');
  });
});

describe('filterByCity', () => {
  const theatres = [
    makeTheatre({ id: '1', name: 'ANDINO', city: 'Bogotá' }),
    makeTheatre({ id: '2', name: 'OVIEDO', city: 'Medellín' }),
    makeTheatre({ id: '3', name: 'CHIPICHAPE', city: 'Cali' }),
  ];

  it('matches without accents or case sensitivity', () => {
    expect(filterByCity(theatres, 'bogota').map((t) => t.id)).toEqual(['1']);
    expect(filterByCity(theatres, 'MEDELLÍN').map((t) => t.id)).toEqual(['2']);
  });

  it('returns everything for an empty filter', () => {
    expect(filterByCity(theatres, '')).toHaveLength(3);
  });

  it('returns nothing for an unknown city', () => {
    expect(filterByCity(theatres, 'Narnia')).toEqual([]);
  });
});

describe('listCities', () => {
  it('deduplicates and sorts', () => {
    const theatres = [
      makeTheatre({ id: '1', name: 'A', city: 'Medellín' }),
      makeTheatre({ id: '2', name: 'B', city: 'Bogotá' }),
      makeTheatre({ id: '3', name: 'C', city: 'Bogotá' }),
    ];
    expect(listCities(theatres)).toEqual(['Bogotá', 'Medellín']);
  });
});

describe('distanceKm', () => {
  it('returns zero for the same point', () => {
    const point = { latitude: 4.65, longitude: -74.08 };
    expect(distanceKm(point, point)).toBeCloseTo(0, 6);
  });

  it('matches the known length of one degree of longitude at the equator', () => {
    const km = distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    expect(km).toBeCloseTo(111.19, 1);
  });

  it('is symmetric', () => {
    const a = { latitude: 4.6533, longitude: -74.0836 };
    const b = { latitude: 6.2442, longitude: -75.5812 };
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 9);
  });

  it('approximates the real Bogotá to Medellín distance', () => {
    const km = distanceKm(
      { latitude: 4.6533, longitude: -74.0836 },
      { latitude: 6.2442, longitude: -75.5812 }
    );
    // Straight-line distance is roughly 240 km.
    expect(km).toBeGreaterThan(230);
    expect(km).toBeLessThan(250);
  });
});

describe('blankToUndefined', () => {
  it('treats blank input as no value', () => {
    // A model sends "" for a field it could not fill; that is not a request to
    // match everything.
    expect(blankToUndefined('')).toBeUndefined();
    expect(blankToUndefined('   ')).toBeUndefined();
    expect(blankToUndefined('\t\n')).toBeUndefined();
    expect(blankToUndefined(undefined)).toBeUndefined();
    expect(blankToUndefined(null)).toBeUndefined();
  });

  it('keeps real values, trimmed', () => {
    expect(blankToUndefined('Bogotá')).toBe('Bogotá');
    expect(blankToUndefined('  Andino  ')).toBe('Andino');
  });

  it('keeps values that are falsy as strings but meaningful as text', () => {
    expect(blankToUndefined('0')).toBe('0');
  });
});

describe('searchFilms with a blank query', () => {
  it('returns everything, which is why callers that resolve one film must guard', () => {
    // Documents the trap: as a list filter "no query" means "no filtering", but
    // used as a resolver an unguarded [0] would invent an answer.
    const films = [
      { id: 'A', title: 'Uno', localTitle: null, genres: [], cast: [] },
      { id: 'B', title: 'Dos', localTitle: null, genres: [], cast: [] },
    ] as unknown as Parameters<typeof searchFilms>[0];

    expect(searchFilms(films, '')).toHaveLength(2);
    expect(blankToUndefined('')).toBeUndefined();
  });
});
