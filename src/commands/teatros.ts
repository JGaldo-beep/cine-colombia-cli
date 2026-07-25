// `cine teatros` — where the cinemas are.

import pc from 'picocolors';
import { ValidationError } from '../lib/errors.js';
import { padVisible, truncate } from '../lib/format.js';
import { distanceKm, filterByCity, listCities, searchTheatres } from '../lib/search.js';
import { cineApi } from '../services/api/ocapi-client.js';
import type { Theatre } from '../types/cine.js';

export interface TeatrosOptions {
  ciudad?: string;
  /** Free-text name filter. */
  buscar?: string;
  /** `"lat,lng"` — sort by proximity to this point. */
  cerca?: string;
  /** Include entries that exist in the API but never sell tickets. */
  todos?: boolean;
  refrescar?: boolean;
  json?: boolean;
}

export async function teatros(options: TeatrosOptions = {}): Promise<void> {
  const all = await cineApi.getTheatres({ refresh: options.refrescar });

  // By default hide non-cinemas (top-up counters), which are noise for anyone
  // looking for a place to watch a film.
  let selected = options.todos ? all : all.filter((theatre) => theatre.sellsTickets);

  if (options.ciudad) {
    const inCity = filterByCity(selected, options.ciudad);
    if (inCity.length === 0) {
      console.log(pc.yellow(`No hay teatros en "${options.ciudad}".`));
      console.log(pc.dim(`Ciudades disponibles: ${listCities(selected).join(', ')}`));
      return;
    }
    selected = inCity;
  }

  if (options.buscar) selected = searchTheatres(selected, options.buscar);

  let distances: Map<string, number> | undefined;
  if (options.cerca) {
    const origin = parseCoordinates(options.cerca);
    distances = new Map();
    for (const theatre of selected) {
      if (theatre.location) distances.set(theatre.id, distanceKm(origin, theatre.location));
    }
    // Theatres without coordinates cannot be ranked, so they sink to the bottom.
    selected = [...selected].sort(
      (a, b) =>
        (distances?.get(a.id) ?? Number.POSITIVE_INFINITY) -
        (distances?.get(b.id) ?? Number.POSITIVE_INFINITY)
    );
  }

  if (options.json) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  if (selected.length === 0) {
    console.log(pc.yellow('No hay teatros que coincidan con esos filtros.'));
    return;
  }

  printTheatres(selected, distances);
}

/** Parse `"4.65,-74.05"`, rejecting anything that is not a usable coordinate. */
function parseCoordinates(raw: string): { latitude: number; longitude: number } {
  const parts = raw.split(',').map((part) => Number.parseFloat(part.trim()));
  const [latitude, longitude] = parts;

  if (
    parts.length !== 2 ||
    latitude === undefined ||
    longitude === undefined ||
    Number.isNaN(latitude) ||
    Number.isNaN(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new ValidationError(
      'INVALID_COORDINATES',
      `"${raw}" no es una coordenada válida. Usa el formato "lat,lng", por ejemplo "4.6533,-74.0836".`,
      { raw }
    );
  }

  return { latitude, longitude };
}

function printTheatres(theatres: Theatre[], distances?: Map<string, number>): void {
  const grouped = distances ? null : groupByCity(theatres);
  console.log(`\n${pc.bold('Teatros Cine Colombia')}  ${pc.dim(`(${theatres.length})`)}\n`);

  if (grouped) {
    for (const [city, list] of grouped) {
      console.log(`  ${pc.bold(pc.cyan(city))}  ${pc.dim(`(${list.length})`)}`);
      for (const theatre of list) printRow(theatre);
      console.log();
    }
  } else {
    for (const theatre of theatres) printRow(theatre, distances?.get(theatre.id));
    console.log();
  }

  console.log(pc.dim('  Horarios de un teatro:  cine horarios <película> --teatro <id>\n'));
}

function printRow(theatre: Theatre, distance?: number): void {
  const name = padVisible(pc.bold(truncate(theatre.name, 26)), 26);
  const address = pc.dim(truncate(theatre.address || '—', 38));
  const proximity = distance !== undefined ? pc.green(` ${distance.toFixed(1)} km`) : '';
  console.log(`    ${pc.dim(theatre.id)}  ${name}  ${address}${proximity}`);
}

function groupByCity(theatres: Theatre[]): Map<string, Theatre[]> {
  const grouped = new Map<string, Theatre[]>();
  for (const theatre of theatres) {
    const list = grouped.get(theatre.city);
    if (list) list.push(theatre);
    else grouped.set(theatre.city, [theatre]);
  }

  return new Map(
    [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([city, list]) => [city, list.sort((a, b) => a.name.localeCompare(b.name))])
  );
}
