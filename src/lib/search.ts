// Text matching for user-supplied film, theatre and city names.
//
// Nobody types "Spider Man Un Nuevo Dia" exactly, and nobody types accents on a
// terminal. Matching is therefore accent- and case-insensitive, and ranked: an
// exact hit must always beat a substring hit, so `cine pelicula moana` resolves
// to "Moana" and not to some film whose synopsis mentions it.

import type { Film, Theatre } from '../types/cine.js';
import { normalizeText } from './text.js';

export { normalizeText };

/** Higher score means a better match. Zero means no match at all. */
const SCORE = {
  exactId: 100,
  exactTitle: 90,
  startsWith: 70,
  wordBoundary: 50,
  substring: 30,
} as const;

function scoreCandidate(candidates: string[], query: string): number {
  const needle = normalizeText(query);
  if (!needle) return 0;

  let best = 0;
  for (const candidate of candidates) {
    const hay = normalizeText(candidate);
    if (!hay) continue;

    if (hay === needle) best = Math.max(best, SCORE.exactTitle);
    else if (hay.startsWith(needle)) best = Math.max(best, SCORE.startsWith);
    // Match at a word start so "odisea" hits "La Odisea" strongly.
    else if (new RegExp(`\\b${escapeRegex(needle)}`).test(hay)) {
      best = Math.max(best, SCORE.wordBoundary);
    } else if (hay.includes(needle)) best = Math.max(best, SCORE.substring);
  }
  return best;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rank films against a query, best first.
 *
 * Film ids (`HO00000386`) are matched exactly and win outright, which makes ids
 * copied from other output unambiguous.
 */
export function searchFilms(films: Film[], query: string): Film[] {
  const needle = normalizeText(query);
  if (!needle) return films;

  return films
    .map((film) => {
      const score =
        normalizeText(film.id) === needle
          ? SCORE.exactId
          : scoreCandidate([film.localTitle ?? '', film.title], query);
      return { film, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.film.title.localeCompare(b.film.title))
    .map((entry) => entry.film);
}

/** Rank theatres by name, city or id. */
export function searchTheatres(theatres: Theatre[], query: string): Theatre[] {
  const needle = normalizeText(query);
  if (!needle) return theatres;

  return theatres
    .map((theatre) => {
      const score =
        normalizeText(theatre.id) === needle
          ? SCORE.exactId
          : scoreCandidate([theatre.name, theatre.city], query);
      return { theatre, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.theatre.name.localeCompare(b.theatre.name))
    .map((entry) => entry.theatre);
}

/** Theatres in a city, tolerant of accents and casing ("bogota" → "Bogotá"). */
export function filterByCity(theatres: Theatre[], city: string): Theatre[] {
  const needle = normalizeText(city);
  if (!needle) return theatres;
  return theatres.filter((theatre) => normalizeText(theatre.city).includes(needle));
}

/** Distinct city names, alphabetically. */
export function listCities(theatres: Theatre[]): string[] {
  return [...new Set(theatres.map((theatre) => theatre.city))].sort((a, b) => a.localeCompare(b));
}

/**
 * Great-circle distance in kilometres.
 *
 * Used to sort theatres by proximity. The haversine formula is well within the
 * accuracy needed to rank cinemas inside one city.
 */
export function distanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
): number {
  const EARTH_RADIUS_KM = 6371;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}
