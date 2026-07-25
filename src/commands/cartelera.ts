// `cine cartelera` — what is showing.

import pc from 'picocolors';
import { formatBusinessDate, formatRuntime, padVisible, truncate } from '../lib/format.js';
import { filterByCity, listCities, normalizeText, searchFilms } from '../lib/search.js';
import { cineApi } from '../services/api/ocapi-client.js';
import type { Film } from '../types/cine.js';

export interface CarteleraOptions {
  /** Only films actually screening in this city. */
  ciudad?: string;
  /** Filter by genre name, accent-insensitive. */
  genero?: string;
  /** Free-text title filter. */
  buscar?: string;
  /** Ignore cached data. */
  refrescar?: boolean;
  json?: boolean;
}

export async function cartelera(options: CarteleraOptions = {}): Promise<void> {
  const films = await cineApi.getFilms({ refresh: options.refrescar });

  let selected = films;
  let heading = 'Cartelera';
  // Maps film id -> number of screenings, only when narrowed to a city.
  let screeningCounts: Map<string, number> | undefined;

  if (options.ciudad) {
    const theatres = await cineApi.getTheatres({ refresh: options.refrescar });
    const inCity = filterByCity(
      theatres.filter((t) => t.sellsTickets),
      options.ciudad
    );

    if (inCity.length === 0) {
      console.log(pc.yellow(`No hay teatros en "${options.ciudad}".`));
      console.log(pc.dim(`Ciudades disponibles: ${listCities(theatres).join(', ')}`));
      return;
    }

    const { businessDate, showtimes } = await cineApi.getShowtimes(
      'first',
      { theatreIds: inCity.map((t) => t.id) },
      { refresh: options.refrescar }
    );

    screeningCounts = new Map();
    for (const showtime of showtimes) {
      screeningCounts.set(showtime.filmId, (screeningCounts.get(showtime.filmId) ?? 0) + 1);
    }

    // The API returns everything it lists, including titles on pre-sale that are
    // not screening yet. Intersecting with real showtimes is what makes this
    // answer "what can I watch today" instead of "what exists".
    selected = films.filter((film) => screeningCounts?.has(film.id));
    const cityLabel = inCity[0]?.city ?? options.ciudad;
    heading = `Cartelera en ${cityLabel} · ${formatBusinessDate(businessDate)}`;
  }

  if (options.genero) {
    const needle = normalizeText(options.genero);
    selected = selected.filter((film) =>
      film.genres.some((genre) => normalizeText(genre).includes(needle))
    );
  }

  if (options.buscar) selected = searchFilms(selected, options.buscar);

  if (options.json) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  if (selected.length === 0) {
    console.log(pc.yellow('No hay películas que coincidan con esos filtros.'));
    return;
  }

  printFilmTable(selected, heading, screeningCounts);
}

function printFilmTable(
  films: Film[],
  heading: string,
  screeningCounts?: Map<string, number>
): void {
  console.log(`\n${pc.bold(heading)}  ${pc.dim(`(${films.length})`)}\n`);

  const titles = films.map((film) => displayTitle(film));
  const titleWidth = Math.min(44, Math.max(...titles.map((t) => t.length)));

  films.forEach((film, index) => {
    const title = truncate(titles[index] ?? film.title, titleWidth);
    const runtime = formatRuntime(film.runtimeMinutes).padStart(6);
    const genres = truncate(film.genres.join(', ') || '—', 24);
    const count = screeningCounts?.get(film.id);

    console.log(
      `  ${pc.dim(film.id)}  ${padVisible(pc.bold(title), titleWidth)}  ${pc.cyan(runtime)}  ${padVisible(pc.dim(genres), 24)}${
        count ? pc.green(`  ${count} func.`) : ''
      }`
    );
  });

  console.log(pc.dim('\n  Detalle:  cine pelicula <id|título>'));
  console.log(pc.dim('  Horarios: cine horarios <id|título>\n'));
}

/** Prefer the Spanish release title, which is how the film is marketed here. */
function displayTitle(film: Film): string {
  return film.localTitle ?? film.title;
}
