// `cine asientos <función>` — the seating chart for one showtime.

import pc from 'picocolors';
import { ApiError, NotFoundError, ValidationError } from '../lib/errors.js';
import { formatBusinessDate, formatMoney, formatTime } from '../lib/format.js';
import { listAvailableSeats, renderSeatMap, summariseAvailableSeats } from '../lib/seat-map.js';
import { cineApi } from '../services/api/ocapi-client.js';

export interface AsientosOptions {
  /** Skip the map and only list bookable seats. */
  lista?: boolean;
  /** Also print ticket types and prices. */
  precios?: boolean;
  refrescar?: boolean;
  json?: boolean;
  plain?: boolean;
}

/** Showtime ids look like `6493-7850`: theatre id, then screening number. */
const SHOWTIME_ID_PATTERN = /^\d+-\d+$/;

export async function asientos(showtimeId: string, options: AsientosOptions = {}): Promise<void> {
  const id = showtimeId.trim();

  if (!SHOWTIME_ID_PATTERN.test(id)) {
    throw new ValidationError(
      'INVALID_SHOWTIME_ID',
      `"${showtimeId}" no parece un ID de función. Deben verse como 6493-7850; los obtienes con "cine horarios <película>".`,
      { showtimeId }
    );
  }

  // A 404 from any of these means the showtime is gone or never existed. Surfacing
  // the raw API path would leak an internal endpoint and tell the user nothing.
  const [showtime, layout, availability] = await notFoundAsMissingShowtime(id, () =>
    Promise.all([
      cineApi.getShowtime(id),
      cineApi.getSeatLayout(id, { refresh: options.refrescar }),
      cineApi.getSeatAvailability(id, { refresh: options.refrescar }),
    ])
  );

  if (!showtime.hasAssignedSeating) {
    console.log(
      pc.yellow(
        '\nEsta función no tiene asiento asignado: la silla se elige al entrar a la sala.\n'
      )
    );
    return;
  }

  const free = listAvailableSeats(layout, availability);
  const ticketTypes = options.precios || options.json ? await cineApi.getTicketTypes(id) : [];

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          showtime,
          availability: {
            availableCount: availability.availableCount,
            totalCount: availability.totalCount,
            isSoldOut: availability.isSoldOut,
          },
          availableSeats: free.map(({ seat, areaName }) => ({
            id: seat.id,
            row: seat.row,
            number: seat.number,
            area: areaName,
          })),
          ticketTypes,
        },
        null,
        2
      )
    );
    return;
  }

  await printHeader(
    id,
    showtime.filmId,
    showtime.theatreId,
    showtime.startsAt,
    showtime.businessDate
  );

  if (availability.isSoldOut || free.length === 0) {
    console.log(pc.red('  Función agotada: no quedan sillas disponibles.\n'));
    return;
  }

  if (!options.lista) {
    for (const line of renderSeatMap(layout, availability, { plain: options.plain })) {
      console.log(line);
    }
    console.log();
  }

  console.log(
    `  ${pc.bold('Sillas libres')} ${pc.dim(`(${availability.availableCount} de ${availability.totalCount})`)}`
  );

  const rows = summariseAvailableSeats(free);
  let lastArea: string | null = null;
  for (const { row, area, numbers } of rows) {
    // Only label the area when it changes, so the block reads as a grouping.
    if (area !== lastArea) {
      console.log(`    ${pc.dim(area)}`);
      lastArea = area;
    }
    console.log(`      ${pc.cyan(row.padStart(2))}  ${numbers.join(', ')}`);
  }

  if (options.precios && ticketTypes.length > 0) {
    console.log(`\n  ${pc.bold('Boletas')}`);
    for (const type of ticketTypes.filter((t) => !t.isRestricted)) {
      const fee = type.bookingFee ? pc.dim(` + ${formatMoney(type.bookingFee)} servicio`) : '';
      console.log(`    ${pc.cyan(formatMoney(type.price).padStart(10))}  ${type.name}${fee}`);
    }
  }

  console.log(pc.dim(`\n  Comprar: cine comprar ${id}\n`));
}

/**
 * Translate a 404 from the showtime endpoints into a message about the showtime.
 *
 * Any other failure is left untouched, so genuine outages are not disguised as
 * "not found".
 */
async function notFoundAsMissingShowtime<T>(showtimeId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new NotFoundError(
        'SHOWTIME_NOT_FOUND',
        `No se encontró la función "${showtimeId}". Puede que ya haya terminado o que el ID esté mal. Consulta "cine horarios <película>".`,
        { showtimeId }
      );
    }
    throw error;
  }
}

/** Resolve ids to names for a readable header, degrading if a lookup fails. */
async function printHeader(
  showtimeId: string,
  filmId: string,
  theatreId: string,
  startsAt: string,
  businessDate: string
): Promise<void> {
  const [films, theatres] = await Promise.all([
    cineApi.getFilms().catch(() => []),
    cineApi.getTheatres().catch(() => []),
  ]);

  const film = films.find((candidate) => candidate.id === filmId);
  const theatre = theatres.find((candidate) => candidate.id === theatreId);
  const title = film ? (film.localTitle ?? film.title) : filmId;

  console.log(`\n${pc.bold(pc.cyan(title))}`);
  console.log(
    `${pc.dim(`${theatre?.name ?? theatreId} · ${formatBusinessDate(businessDate)} · ${formatTime(startsAt, theatre?.timeZone)}`)}  ${pc.dim(`[${showtimeId}]`)}`
  );
}
