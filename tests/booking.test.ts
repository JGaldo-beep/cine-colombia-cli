import { describe, expect, it } from 'bun:test';
import { matchTicketTypeForArea, resolveSeatCodes, seatCode } from '../src/lib/booking.js';
import type { AvailableSeat } from '../src/lib/seat-map.js';
import type { TicketType } from '../src/types/cine.js';

function makeSeat(row: string, number: string, areaName = 'GENERAL'): AvailableSeat {
  return {
    seat: {
      id: `1_${row.charCodeAt(0)}_${number}`,
      row,
      number,
      areaName,
      rowIndex: row.charCodeAt(0),
      columnIndex: Number(number),
    },
    areaName,
  };
}

const available: AvailableSeat[] = [
  makeSeat('A', '5'),
  makeSeat('A', '6'),
  makeSeat('A', '10'),
  makeSeat('F', '1', 'PREFERENCIAL'),
];

function makeType(overrides: Partial<TicketType> & Pick<TicketType, 'id' | 'name'>): TicketType {
  return {
    price: 15500,
    bookingFee: null,
    isDefault: false,
    isRestricted: false,
    displayPriority: 1,
    ...overrides,
  };
}

describe('resolveSeatCodes', () => {
  it('matches comma separated codes in the order given', () => {
    const { matched, unmatched } = resolveSeatCodes('A5,A6', available);
    expect(matched.map(({ seat }) => seatCode(seat))).toEqual(['A5', 'A6']);
    expect(unmatched).toEqual([]);
  });

  it('accepts spaces and semicolons as separators', () => {
    expect(resolveSeatCodes('A5 A6', available).matched).toHaveLength(2);
    expect(resolveSeatCodes('A5; A6', available).matched).toHaveLength(2);
  });

  it('is case insensitive', () => {
    expect(resolveSeatCodes('a5', available).matched.map(({ seat }) => seatCode(seat))).toEqual([
      'A5',
    ]);
  });

  it('ignores separators and leading zeros inside a code', () => {
    // "A-05" and "A05" are how people actually type a seat printed as A5.
    expect(resolveSeatCodes('A-5', available).matched).toHaveLength(1);
    expect(resolveSeatCodes('A05', available).matched).toHaveLength(1);
  });

  it('does not confuse A1 with A10', () => {
    // Stripping zeros must not make "A1" match the seat labelled "10".
    const { matched, unmatched } = resolveSeatCodes('A1', available);
    expect(matched).toEqual([]);
    expect(unmatched).toEqual(['A1']);
    expect(resolveSeatCodes('A10', available).matched.map(({ seat }) => seatCode(seat))).toEqual([
      'A10',
    ]);
  });

  it('reports codes that are not available', () => {
    const { matched, unmatched } = resolveSeatCodes('A5,Z99', available);
    expect(matched.map(({ seat }) => seatCode(seat))).toEqual(['A5']);
    expect(unmatched).toEqual(['Z99']);
  });

  it('reports repeated codes instead of booking a seat twice', () => {
    const { matched, duplicates } = resolveSeatCodes('A5,A5', available);
    expect(matched).toHaveLength(1);
    expect(duplicates).toEqual(['A5']);
  });

  it('detects duplicates written in different styles', () => {
    expect(resolveSeatCodes('A5,a-05', available).duplicates).toHaveLength(1);
  });

  it('resolves seats across different areas', () => {
    const { matched } = resolveSeatCodes('A5,F1', available);
    expect(matched.map(({ areaName }) => areaName)).toEqual(['GENERAL', 'PREFERENCIAL']);
  });

  it('returns nothing for blank input', () => {
    expect(resolveSeatCodes('', available).matched).toEqual([]);
    expect(resolveSeatCodes('   ', available).matched).toEqual([]);
  });
});

describe('matchTicketTypeForArea', () => {
  const types = [
    makeType({ id: 'T1', name: 'Silla General', price: 15500 }),
    makeType({ id: 'T2', name: 'Silla Preferencial', price: 19500 }),
    makeType({ id: 'T3', name: '2D Premio General', price: 0, isRestricted: true }),
  ];

  it('matches the area name inside the ticket type name', () => {
    expect(matchTicketTypeForArea('GENERAL', types)?.id).toBe('T1');
    expect(matchTicketTypeForArea('PREFERENCIAL', types)?.id).toBe('T2');
  });

  it('ignores accents and case', () => {
    expect(matchTicketTypeForArea('preferencial', types)?.id).toBe('T2');
  });

  it('never returns a restricted type, which cannot be bought outright', () => {
    const restrictedOnly = [makeType({ id: 'R', name: 'Silla General', isRestricted: true })];
    expect(matchTicketTypeForArea('GENERAL', restrictedOnly)).toBeNull();
  });

  it('returns null when the match is ambiguous rather than guessing', () => {
    const ambiguous = [
      makeType({ id: 'A', name: 'Silla General Cineco' }),
      makeType({ id: 'B', name: 'Silla General Platino' }),
    ];
    expect(matchTicketTypeForArea('GENERAL', ambiguous)).toBeNull();
  });

  it('uses the only selectable type when there is exactly one', () => {
    const single = [makeType({ id: 'ONLY', name: 'Boleta única' })];
    expect(matchTicketTypeForArea('ALGO RARO', single)?.id).toBe('ONLY');
  });

  it('returns null when nothing matches and there are several options', () => {
    expect(matchTicketTypeForArea('VIP', types)).toBeNull();
  });

  it('returns null for an empty area name', () => {
    expect(matchTicketTypeForArea('', types)).toBeNull();
  });
});

describe('seatCode', () => {
  it('joins row and number the way the ticket prints it', () => {
    expect(seatCode({ row: 'A', number: '5' })).toBe('A5');
  });
});
