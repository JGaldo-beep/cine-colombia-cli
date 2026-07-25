// Presentation helpers for terminal output.
//
// All times are rendered in the theatre's own timezone rather than the user's.
// A showtime is a physical event at a place: someone checking Bogotá listings
// from abroad wants "7:30 PM", the time printed on the ticket, not their local
// equivalent.

import { ValidationError } from './errors.js';

const COLOMBIA_TIME_ZONE = 'America/Bogota';

/** Turn 172 into "2h 52m". Returns a dash when the runtime is unknown. */
export function formatRuntime(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '—';

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/**
 * Render an ISO timestamp as a wall-clock time, e.g. "7:30 PM".
 *
 * `Intl` renders Spanish meridiems as "p. m."; we compact that to "PM" so
 * columns line up predictably.
 */
export function formatTime(iso: string, timeZone: string = COLOMBIA_TIME_ZONE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('es-CO', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(date)
    .replace(/\u00A0/g, ' ')
    .replace(/\s*a\.\s*m\.\s*$/i, ' AM')
    .replace(/\s*p\.\s*m\.\s*$/i, ' PM')
    .trim();
}

/**
 * Convert a user-supplied date into the `YYYY-MM-DD` the API expects.
 *
 * The CLI speaks DD-MM-YYYY because that is how dates are written in Colombia.
 * The ISO form is also accepted since a four-digit leading group is unambiguous,
 * but it is not advertised.
 *
 * Rejects dates that look well-formed but do not exist, such as 31-02-2026.
 *
 * @param input e.g. `"24-07-2026"`, `"24/7/2026"`.
 * @returns the same day as `"2026-07-24"`.
 */
export function parseUserDate(input: string): string {
  const value = input.trim();

  const dmy = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  const ymd = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);

  const parts = dmy
    ? { day: dmy[1], month: dmy[2], year: dmy[3] }
    : ymd
      ? { year: ymd[1], month: ymd[2], day: ymd[3] }
      : null;

  if (!parts?.day || !parts.month || !parts.year) {
    throw new ValidationError(
      'INVALID_DATE',
      `"${input}" no es una fecha válida. Usa el formato DD-MM-YYYY, por ejemplo 24-07-2026.`,
      { input }
    );
  }

  const year = Number.parseInt(parts.year, 10);
  const month = Number.parseInt(parts.month, 10);
  const day = Number.parseInt(parts.day, 10);

  // Round-tripping through Date catches impossible days: JS would silently roll
  // 31 February over into March, so a mismatch means the input was invalid.
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new ValidationError('INVALID_DATE', `La fecha "${input}" no existe en el calendario.`, {
      input,
    });
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Render an API `YYYY-MM-DD` date as `DD-MM-YYYY` for display. */
export function formatDateShort(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';

  const match = isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;

  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}

/** Render a `YYYY-MM-DD` business date as "viernes 24 de julio". */
export function formatBusinessDate(businessDate: string): string {
  // Parse as UTC noon so no timezone shift can move it to the adjacent day.
  const date = new Date(`${businessDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return businessDate;

  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
}

/** Today's date in Colombia as `YYYY-MM-DD`. */
export function todayInColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: COLOMBIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Format an amount in Colombian pesos, e.g. `$15.500`.
 *
 * Cinema prices are always whole pesos, and COP conventionally uses a dot as the
 * thousands separator, so decimals are dropped rather than shown as `,00`.
 */
export function formatMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';

  return (
    new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
      .format(amount)
      // Intl renders "COP 15.500" or "$ 15.500" depending on the runtime's ICU
      // build; normalise both to a bare "$15.500".
      .replace(/^COP\s*/, '$')
      .replace(/^\$\s+/, '$')
      .replace(/\u00A0/g, ' ')
  );
}

/** Strip ANSI escapes so styled text can be measured for alignment. */
export function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires ESC.
  return text.replace(/\u001B\[[0-9;]*m/g, '').length;
}

/** Pad to `width` using the visible length, so colour codes don't skew columns. */
export function padVisible(text: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(text));
  return text + ' '.repeat(padding);
}

/** Shorten to `max` characters, ending with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, max);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Wrap text at word boundaries.
 *
 * Used for synopses, where breaking mid-word is noticeably uglier than an
 * uneven right margin.
 */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  return lines;
}
