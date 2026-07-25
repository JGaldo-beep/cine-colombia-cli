// Turning what a person types into what the booking API expects.

import type { TicketType } from '../types/cine.js';
import type { AvailableSeat } from './seat-map.js';
import { normalizeText } from './text.js';

export interface SeatCodeResolution {
  /** Seats matched, in the order the user listed them. */
  matched: AvailableSeat[];
  /** Codes that matched nothing available. */
  unmatched: string[];
  /** Codes given more than once. */
  duplicates: string[];
}

/**
 * Resolve seat codes like `"A5, A6"` against the seats that are actually free.
 *
 * Matching is done on the printed row and number rather than the API's internal
 * seat id, because "A5" is what the ticket says and what a person reads off the
 * map. Codes that are taken, broken or nonexistent all come back as unmatched:
 * from the buyer's point of view the distinction does not change what to do next.
 *
 * @param input comma or space separated, e.g. `"A5,A6"` or `"a5 a6"`.
 */
export function resolveSeatCodes(input: string, available: AvailableSeat[]): SeatCodeResolution {
  const codes = input
    .split(/[,;\s]+/)
    .map((code) => code.trim())
    .filter(Boolean);

  const index = new Map<string, AvailableSeat>();
  for (const entry of available) {
    index.set(seatCodeKey(`${entry.seat.row}${entry.seat.number}`), entry);
  }

  const matched: AvailableSeat[] = [];
  const unmatched: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const code of codes) {
    const key = seatCodeKey(code);

    if (seen.has(key)) {
      duplicates.push(code);
      continue;
    }

    const seat = index.get(key);
    if (!seat) {
      unmatched.push(code);
      continue;
    }

    seen.add(key);
    matched.push(seat);
  }

  return { matched, unmatched, duplicates };
}

/**
 * Normalise a seat code for comparison.
 *
 * Strips accents, case, spaces and separators, and drops leading zeros from the
 * number so "A05", "a-5" and "A5" are the same seat.
 */
function seatCodeKey(code: string): string {
  const compact = normalizeText(code).replace(/[\s._-]/g, '');
  return compact.replace(/^([a-z]+)0*(\d+)$/, '$1$2');
}

/**
 * Guess the ticket type that belongs to a seating area.
 *
 * OCAPI does not publish the area-to-ticket-type mapping: `ticketPrices` carries
 * no `areaCategoryId`, and several types report `isDefault` at once because the
 * flag is per area. What it does do is reject a mismatch with HTTP 400, verified
 * against the live API.
 *
 * So this is only a convenience: it matches on the area name appearing in the
 * ticket type name ("GENERAL" in "Silla General"). The API remains the authority,
 * and callers must surface its rejection rather than trusting this result.
 *
 * @returns the single best match, or null when it is absent or ambiguous.
 */
export function matchTicketTypeForArea(areaName: string, types: TicketType[]): TicketType | null {
  const area = normalizeText(areaName);
  if (!area) return null;

  const selectable = types.filter((type) => !type.isRestricted);

  const matches = selectable.filter((type) => normalizeText(type.name).includes(area));

  // Ambiguity must not be resolved by guessing; the caller should ask instead.
  if (matches.length === 1) return matches[0] ?? null;

  // A single selectable type needs no disambiguation.
  if (selectable.length === 1) return selectable[0] ?? null;

  return null;
}

/** Human-readable seat code, e.g. `A5`. */
export function seatCode(seat: { row: string; number: string }): string {
  return `${seat.row}${seat.number}`;
}
