import { describe, expect, it } from 'bun:test';
import { ValidationError } from '../src/lib/errors.js';
import {
  formatBusinessDate,
  formatDateShort,
  formatMoney,
  formatRuntime,
  formatTime,
  padVisible,
  parseUserDate,
  truncate,
  visibleLength,
  wrapText,
} from '../src/lib/format.js';

describe('formatRuntime', () => {
  it('splits minutes into hours and minutes', () => {
    expect(formatRuntime(172)).toBe('2h 52m');
    expect(formatRuntime(108)).toBe('1h 48m');
  });

  it('omits the empty component on exact boundaries', () => {
    expect(formatRuntime(120)).toBe('2h');
    expect(formatRuntime(45)).toBe('45m');
  });

  it('renders a dash when the runtime is unknown or nonsensical', () => {
    expect(formatRuntime(null)).toBe('—');
    expect(formatRuntime(undefined)).toBe('—');
    expect(formatRuntime(0)).toBe('—');
    expect(formatRuntime(-30)).toBe('—');
  });
});

describe('formatTime', () => {
  it('renders the theatre wall-clock time, not the local one', () => {
    // Explicit -05:00 offset: this is 7:30 PM in Bogotá regardless of where the
    // CLI runs, which is what the ticket says.
    expect(formatTime('2026-07-24T19:30:00-05:00')).toBe('7:30 PM');
    expect(formatTime('2026-07-25T10:15:00-05:00')).toBe('10:15 AM');
  });

  it('compacts the Spanish meridiem so columns align', () => {
    expect(formatTime('2026-07-24T19:30:00-05:00')).not.toContain('p. m.');
  });

  it('degrades gracefully on unparseable input', () => {
    expect(formatTime('no es una fecha')).toBe('—');
  });
});

describe('parseUserDate', () => {
  it('accepts DD-MM-YYYY, the documented format', () => {
    expect(parseUserDate('24-07-2026')).toBe('2026-07-24');
    expect(parseUserDate('01-01-2027')).toBe('2027-01-01');
  });

  it('accepts single-digit days and months', () => {
    expect(parseUserDate('4-7-2026')).toBe('2026-07-04');
  });

  it('accepts slashes and dots as separators', () => {
    expect(parseUserDate('24/07/2026')).toBe('2026-07-24');
    expect(parseUserDate('24.07.2026')).toBe('2026-07-24');
  });

  it('still accepts ISO input, which is unambiguous by shape', () => {
    expect(parseUserDate('2026-07-24')).toBe('2026-07-24');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseUserDate('  24-07-2026 ')).toBe('2026-07-24');
  });

  it('rejects dates that do not exist rather than rolling them over', () => {
    // Plain `new Date` would silently turn this into 3 March.
    expect(() => parseUserDate('31-02-2026')).toThrow(ValidationError);
    expect(() => parseUserDate('32-01-2026')).toThrow(ValidationError);
    expect(() => parseUserDate('24-13-2026')).toThrow(ValidationError);
  });

  it('rejects malformed input', () => {
    expect(() => parseUserDate('hoy')).toThrow(ValidationError);
    expect(() => parseUserDate('24-07')).toThrow(ValidationError);
    expect(() => parseUserDate('24-07-26')).toThrow(ValidationError);
    expect(() => parseUserDate('')).toThrow(ValidationError);
  });

  it('names the expected format in the error message', () => {
    expect(() => parseUserDate('hoy')).toThrow(/DD-MM-YYYY/);
  });
});

describe('formatDateShort', () => {
  it('converts API dates to the readable local order', () => {
    expect(formatDateShort('2026-07-09')).toBe('09-07-2026');
  });

  it('renders a dash for missing values', () => {
    expect(formatDateShort(null)).toBe('—');
    expect(formatDateShort(undefined)).toBe('—');
  });

  it('passes through anything it does not recognise', () => {
    expect(formatDateShort('proximamente')).toBe('proximamente');
  });
});

describe('formatBusinessDate', () => {
  it('spells out the weekday and month in Spanish', () => {
    const formatted = formatBusinessDate('2026-07-24');
    expect(formatted).toContain('viernes');
    expect(formatted).toContain('24');
    expect(formatted).toContain('julio');
  });

  it('does not drift to the adjacent day across timezones', () => {
    // Parsed at UTC noon precisely so no offset can shift the calendar day.
    expect(formatBusinessDate('2026-01-01')).toContain('1');
    expect(formatBusinessDate('2026-01-01')).toContain('enero');
  });

  it('passes through unparseable values', () => {
    expect(formatBusinessDate('nope')).toBe('nope');
  });
});

describe('visibleLength and padVisible', () => {
  const styled = '\u001B[1mHola\u001B[22m';

  it('ignores ANSI escapes when measuring', () => {
    expect(visibleLength(styled)).toBe(4);
    expect(visibleLength('Hola')).toBe(4);
  });

  it('pads based on visible width so colour does not skew columns', () => {
    expect(visibleLength(padVisible(styled, 10))).toBe(10);
    expect(visibleLength(padVisible('Hola', 10))).toBe(10);
  });

  it('never truncates when the text already exceeds the width', () => {
    expect(padVisible('abcdefgh', 3)).toBe('abcdefgh');
  });
});

describe('truncate', () => {
  it('leaves short text untouched', () => {
    expect(truncate('Moana', 10)).toBe('Moana');
  });

  it('marks cut text with an ellipsis and respects the limit', () => {
    const result = truncate('Los futbolísimos 2', 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('wrapText', () => {
  it('breaks on word boundaries within the width', () => {
    const lines = wrapText('uno dos tres cuatro cinco', 9);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(9);
    expect(lines.join(' ')).toBe('uno dos tres cuatro cinco');
  });

  it('returns nothing for empty or blank input', () => {
    expect(wrapText('', 10)).toEqual([]);
    expect(wrapText('    ', 10)).toEqual([]);
  });

  it('keeps a word longer than the width on its own line rather than splitting it', () => {
    expect(wrapText('corto superlargapalabra', 5)).toEqual(['corto', 'superlargapalabra']);
  });
});

describe('formatMoney', () => {
  it('formats Colombian pesos with dot thousands separators and no decimals', () => {
    expect(formatMoney(15500)).toBe('$15.500');
    expect(formatMoney(19500)).toBe('$19.500');
    expect(formatMoney(1600)).toBe('$1.600');
  });

  it('formats large amounts', () => {
    expect(formatMoney(1234567)).toBe('$1.234.567');
  });

  it('formats zero, which is what free promotional tickets cost', () => {
    expect(formatMoney(0)).toBe('$0');
  });

  it('rounds away the fractional pesos the API sends as floats', () => {
    // OCAPI returns 15500.0; cinema prices are never fractional.
    expect(formatMoney(15500.0)).toBe('$15.500');
  });

  it('renders a dash for missing or invalid amounts', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
  });

  it('never leaves a currency code or stray space in the output', () => {
    expect(formatMoney(15500)).not.toContain('COP');
    expect(formatMoney(15500)).not.toMatch(/\$\s/);
  });
});
