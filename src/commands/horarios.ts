// `cine horarios <película>` — when and where a film is screening.

import pc from 'picocolors';
import { DEFAULTS } from '../config/constants.js';
import { NotFoundError } from '../lib/errors.js';
import { formatBusinessDate, formatTime, padVisible, parseUserDate } from '../lib/format.js';
import { filterByCity, listCities, searchFilms, searchTheatres } from '../lib/search.js';
import { cineApi } from '../services/api/ocapi-client.js';
import type { Showtime, Theatre } from '../types/cine.js';

export interface HorariosOptions {
  ciudad?: string;
  /** Restrict to a single theatre by id or name. */
  teatro?: string;
  /** `DD-MM-YYYY`. Defaults to the next date with screenings. */
  fecha?: string;
  refrescar?: boolean;
  json?: boolean;
}

export async function horarios(query: string, options: HorariosOptions = {}): Promise<void> {
  // Throws a user-facing error before any network call when the date is bad.
  const businessDateFilter = options.fecha ? parseUserDate(options.fecha) : 'first';

  const [films, allTheatres] = await Promise.all([
    cineApi.getFilms({ refresh: options.refrescar }),
    cineApi.getTheatres({ refresh: options.refrescar }),
  ]);

  const film = searchFilms(films, query)[0];
  if (!film) {
    throw new NotFoundError(
      'FILM_NOT_FOUND',
      `No se encontró ninguna película que coincida con "${query}".`,
      { query }
    );
  }

  const theatres = resolveTheatres(allTheatres, options);
  if (theatres.length === 0) return;

  const { businessDate, showtimes } = await cineApi.getShowtimes(
    businessDateFilter,
    { filmIds: [film.id], theatreIds: theatres.map((t) => t.id) },
    { refresh: options.refrescar }
  );

  if (options.json) {
    console.log(JSON.stringify({ film, businessDate, showtimes }, null, 2));
    return;
  }

  const title = film.localTitle ?? film.title;

  if (showtimes.length === 0) {
    console.log(
      pc.yellow(
        `\nNo hay funciones de "${title}"${options.fecha ? ` el ${options.fecha}` : ''} en ${describeScope(options, theatres)}.\n`
      )
    );
    console.log(
      pc.dim('  Prueba otra fecha con --fecha DD-MM-YYYY, u otra ciudad con --ciudad.\n')
    );
    return;
  }

  printShowtimes(title, businessDate, showtimes, theatres);
}

/**
 * Decide which theatres to query.
 *
 * Asking for every theatre in the country returns a wall of text, so absent an
 * explicit filter we default to one city.
 */
function resolveTheatres(all: Theatre[], options: HorariosOptions): Theatre[] {
  const sellable = all.filter((theatre) => theatre.sellsTickets);

  if (options.teatro) {
    const matches = searchTheatres(sellable, options.teatro);
    if (matches.length === 0) {
      console.log(pc.yellow(`No se encontró el teatro "${options.teatro}".`));
      console.log(pc.dim('  Lista de teatros: cine teatros'));
      return [];
    }
    // A name like "andino" should resolve to one cinema, not a whole city.
    return matches.slice(0, 1);
  }

  const city = options.ciudad ?? DEFAULTS.city;
  const inCity = filterByCity(sellable, city);
  if (inCity.length === 0) {
    console.log(pc.yellow(`No hay teatros en "${city}".`));
    console.log(pc.dim(`Ciudades disponibles: ${listCities(sellable).join(', ')}`));
    return [];
  }
  return inCity;
}

function describeScope(options: HorariosOptions, theatres: Theatre[]): string {
  if (options.teatro) return theatres[0]?.name ?? options.teatro;
  return options.ciudad ?? DEFAULTS.city;
}

function printShowtimes(
  title: string,
  businessDate: string,
  showtimes: Showtime[],
  theatres: Theatre[]
): void {
  const byId = new Map(theatres.map((theatre) => [theatre.id, theatre]));

  console.log(`\n${pc.bold(pc.cyan(title))}`);
  console.log(
    `${pc.dim(formatBusinessDate(businessDate))}  ${pc.dim(`· ${showtimes.length} función(es)`)}\n`
  );

  const grouped = new Map<string, Showtime[]>();
  for (const showtime of showtimes) {
    const list = grouped.get(showtime.theatreId);
    if (list) list.push(showtime);
    else grouped.set(showtime.theatreId, [showtime]);
  }

  const ordered = [...grouped.entries()].sort(([a], [b]) =>
    (byId.get(a)?.name ?? a).localeCompare(byId.get(b)?.name ?? b)
  );

  for (const [theatreId, list] of ordered) {
    const theatre = byId.get(theatreId);
    console.log(`  ${pc.bold(theatre?.name ?? theatreId)}  ${pc.dim(theatre?.address ?? '')}`);

    for (const showtime of [...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const time = padVisible(pc.cyan(formatTime(showtime.startsAt, theatre?.timeZone)), 9);
      const flags = [
        showtime.isSoldOut ? pc.red('AGOTADA') : null,
        showtime.requires3dGlasses ? pc.magenta('3D') : null,
      ]
        .filter(Boolean)
        .join(' ');

      console.log(`    ${time} ${pc.dim(showtime.id)}  ${flags}`);
    }
    console.log();
  }

  console.log(pc.dim('  Mapa de asientos:  cine asientos <id de función>\n'));
}
