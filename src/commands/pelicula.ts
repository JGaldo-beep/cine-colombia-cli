// `cine pelicula <búsqueda>` — full detail for one film.

import pc from 'picocolors';
import { NotFoundError } from '../lib/errors.js';
import { formatDateShort, formatRuntime, wrapText } from '../lib/format.js';
import { searchFilms } from '../lib/search.js';
import { cineApi } from '../services/api/ocapi-client.js';
import type { Film } from '../types/cine.js';

export interface PeliculaOptions {
  refrescar?: boolean;
  json?: boolean;
}

const SYNOPSIS_WIDTH = 76;

export async function pelicula(query: string, options: PeliculaOptions = {}): Promise<void> {
  const films = await cineApi.getFilms({ refresh: options.refrescar });
  const matches = searchFilms(films, query);
  const film = matches[0];

  if (!film) {
    throw new NotFoundError(
      'FILM_NOT_FOUND',
      `No se encontró ninguna película que coincida con "${query}".`,
      { query }
    );
  }

  if (options.json) {
    console.log(JSON.stringify(film, null, 2));
    return;
  }

  printFilm(film);

  // Ambiguous queries are common ("spider"), so surface the runners-up instead of
  // silently picking one.
  const others = matches.slice(1, 6);
  if (others.length > 0) {
    console.log(pc.dim('  También coinciden:'));
    for (const other of others) {
      console.log(pc.dim(`    ${other.id}  ${other.localTitle ?? other.title}`));
    }
    console.log();
  }
}

function printFilm(film: Film): void {
  const title = film.localTitle ?? film.title;

  console.log(`\n${pc.bold(pc.cyan(title))}`);
  // Only show the original title when it actually differs from what we printed.
  if (film.localTitle && film.localTitle !== film.title) {
    console.log(pc.dim(`  título original: ${film.title}`));
  }
  console.log();

  const facts: Array<[string, string]> = [
    ['ID', film.id],
    ['Duración', formatRuntime(film.runtimeMinutes)],
    ['Clasificación', film.rating ?? '—'],
    ['Géneros', film.genres.join(', ') || '—'],
    ['Estreno', formatDateShort(film.releaseDate)],
  ];

  if (film.cast.length > 0) facts.push(['Reparto', film.cast.slice(0, 6).join(', ')]);
  if (film.trailerUrl) facts.push(['Tráiler', film.trailerUrl]);

  const labelWidth = Math.max(...facts.map(([label]) => label.length));
  for (const [label, value] of facts) {
    console.log(`  ${pc.dim(label.padEnd(labelWidth))}  ${value}`);
  }

  if (film.synopsis) {
    console.log(`\n  ${pc.dim('Sinopsis')}`);
    for (const line of wrapText(film.synopsis, SYNOPSIS_WIDTH)) {
      console.log(`  ${line}`);
    }
  }

  console.log(pc.dim(`\n  Horarios: cine horarios ${film.id}\n`));
}
