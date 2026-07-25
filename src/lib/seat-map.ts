// Renders a screen's seating chart as terminal art.
//
// Two pieces of data are needed and they are deliberately separate in the API:
// the layout says which seats physically exist, the availability says which are
// free. Seats are positioned by their grid coordinates rather than by their
// printed labels, because the two do not correspond: seat "A16" at Andino sits at
// column 18. Using coordinates is what makes aisles show up as real gaps instead
// of the map silently closing them.

import pc from 'picocolors';
import type { Seat, SeatAvailability, SeatLayout, SeatStatus } from '../types/cine.js';

/** Symbols chosen to stay legible in a monospace terminal without a Nerd Font. */
const GLYPH = {
  available: '○',
  sold: '●',
  broken: '×',
  unknown: '?',
  gap: ' ',
} as const;

export interface SeatMapOptions {
  /** Render without ANSI colour, for pipes and dumb terminals. */
  plain?: boolean;
}

/** A seat the user could actually book. */
export interface AvailableSeat {
  seat: Seat;
  areaName: string;
}

/**
 * Build the seat map as lines of text.
 *
 * Rows are ordered by their grid index, which in Vista layouts runs from the
 * screen towards the back of the room, so the first line printed is the front row.
 */
export function renderSeatMap(
  layout: SeatLayout,
  availability: SeatAvailability,
  options: SeatMapOptions = {}
): string[] {
  const paint = options.plain ? plainPalette : colourPalette;

  const columnCount = Math.max(
    1,
    ...layout.areas.flatMap((area) => area.seats.map((seat) => seat.columnIndex))
  );

  const lines: string[] = [];
  const width = columnCount * 2 - 1;

  lines.push('');
  lines.push(centre(paint.screen('P A N T A L L A'), width, 'P A N T A L L A'.length));
  lines.push(paint.screen('─'.repeat(width)));
  lines.push('');

  const labelWidth = Math.max(
    2,
    ...layout.areas.flatMap((area) => area.seats.map((seat) => seat.row.length))
  );

  for (const area of layout.areas) {
    if (area.seats.length === 0) continue;

    const areaFree = area.seats.filter(
      (seat) => availability.statuses.get(seat.id) === 'Available'
    ).length;

    lines.push(
      `${' '.repeat(labelWidth + 2)}${paint.area(area.name)} ${paint.dim(`(${areaFree} libres)`)}`
    );

    for (const row of groupRows(area.seats)) {
      const cells: string[] = new Array(columnCount).fill(GLYPH.gap);

      for (const seat of row.seats) {
        // The horizontal axis is mirrored on purpose.
        //
        // In the API, `columnIndex` grows with the printed seat number: column 1 is
        // seat 1. Cine Colombia's own seating chart puts seat 1 on the **right** and
        // counts leftwards, so row A reads 16…9 | 8…1. Drawing columns left to right
        // therefore produced a mirror image of the room, and someone told "H10" would
        // look for it on the wrong side.
        //
        // Verified against showtime 6493-7806 (Andino, sala 1) by comparing with the
        // website: the unavailable seats matched exactly in every row (C: 6 and 7;
        // D: 7, 8, 9, 10, 12; E: only seat 3 free), while appearing on the opposite
        // side. Checked in four screens that the number always grows with
        // `columnIndex`, so one global mirror is correct rather than per-room luck.
        const index = columnCount - seat.columnIndex;
        if (index < 0 || index >= columnCount) continue;
        cells[index] = paint.seat(availability.statuses.get(seat.id));
      }

      lines.push(`  ${paint.dim(row.label.padStart(labelWidth))} ${cells.join(' ')}`);
    }

    lines.push('');
  }

  lines.push(
    `  ${paint.seat('Available')} libre   ${paint.seat('Sold')} ocupada   ${paint.seat('Broken')} fuera de servicio`
  );

  return lines;
}

/**
 * Seats that can be booked, ordered the way a person reads the room.
 *
 * Anything whose status is not exactly `Available` is excluded, including states
 * this CLI has never seen, so an unrecognised status can never be sold.
 */
export function listAvailableSeats(
  layout: SeatLayout,
  availability: SeatAvailability
): AvailableSeat[] {
  const result: AvailableSeat[] = [];

  // Walk areas and rows in the same order the map draws them, so the list reads
  // front-to-back. Sorting the flat list by rowIndex would interleave areas,
  // because each area numbers its rows from 1 independently.
  for (const area of layout.areas) {
    for (const row of groupRows(area.seats)) {
      const seats = [...row.seats].sort((a, b) => a.columnIndex - b.columnIndex);
      for (const seat of seats) {
        if (availability.statuses.get(seat.id) === 'Available') {
          result.push({ seat, areaName: area.name });
        }
      }
    }
  }

  return result;
}

/**
 * Summarise free seats as one line per row, e.g. `A: 3, 4, 5, 12`.
 *
 * The map conveys the shape of the room; this is what someone reads to actually
 * choose a seat, since seat labels are not legible in the grid.
 */
export function summariseAvailableSeats(seats: AvailableSeat[]): Array<{
  row: string;
  area: string;
  numbers: string[];
}> {
  // Insertion order is already front-to-back because `listAvailableSeats` walks
  // the room in display order, so a Map preserves it without re-sorting.
  const byRow = new Map<string, { area: string; numbers: string[] }>();

  for (const { seat, areaName } of seats) {
    const entry = byRow.get(seat.row);
    if (entry) entry.numbers.push(seat.number);
    else byRow.set(seat.row, { area: areaName, numbers: [seat.number] });
  }

  return [...byRow.entries()].map(([row, entry]) => ({
    row,
    area: entry.area,
    // Seat labels are numeric strings; compare numerically so 2 precedes 10.
    numbers: entry.numbers.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
  }));
}

/**
 * Group a flat seat list into rows, ordered from the screen backwards.
 *
 * Row numbers count *away* from the screen in reverse: at Andino screen 6, row
 * number 5 is labelled "A" (the front row) and number 1 is "E". Sorting by
 * descending number therefore puts the front row first. See `toSeatLayout` for
 * the evidence behind this.
 */
export function groupRows(seats: Seat[]): Array<{ label: string; index: number; seats: Seat[] }> {
  const rows = new Map<number, { label: string; index: number; seats: Seat[] }>();

  for (const seat of seats) {
    const row = rows.get(seat.rowIndex);
    if (row) row.seats.push(seat);
    else rows.set(seat.rowIndex, { label: seat.row, index: seat.rowIndex, seats: [seat] });
  }

  return [...rows.values()].sort((a, b) => b.index - a.index);
}

/** Centre text within a width, measuring the undecorated string. */
function centre(decorated: string, width: number, visibleWidth: number): string {
  const padding = Math.max(0, Math.floor((width - visibleWidth) / 2));
  return ' '.repeat(padding) + decorated;
}

interface Palette {
  seat(status: SeatStatus | undefined): string;
  area(text: string): string;
  screen(text: string): string;
  dim(text: string): string;
}

const colourPalette: Palette = {
  seat(status) {
    switch (status) {
      case 'Available':
        return pc.green(GLYPH.available);
      case 'Sold':
        return pc.gray(GLYPH.sold);
      case 'Broken':
        return pc.yellow(GLYPH.broken);
      case undefined:
        return pc.gray(GLYPH.gap);
      default:
        // An unrecognised state is shown, not hidden, so it is obvious something
        // needs looking at rather than being quietly treated as free.
        return pc.magenta(GLYPH.unknown);
    }
  },
  area: (text) => pc.bold(pc.cyan(text)),
  screen: (text) => pc.dim(pc.cyan(text)),
  dim: (text) => pc.dim(text),
};

const plainPalette: Palette = {
  seat(status) {
    switch (status) {
      case 'Available':
        return GLYPH.available;
      case 'Sold':
        return GLYPH.sold;
      case 'Broken':
        return GLYPH.broken;
      case undefined:
        return GLYPH.gap;
      default:
        return GLYPH.unknown;
    }
  },
  area: (text) => text,
  screen: (text) => text,
  dim: (text) => text,
};
