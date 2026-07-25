import { describe, expect, it } from 'bun:test';
import {
  groupRows,
  listAvailableSeats,
  renderSeatMap,
  summariseAvailableSeats,
} from '../src/lib/seat-map.js';
import { toSeatAvailability, toSeatLayout } from '../src/services/api/mappers.js';
import type { RawSeatLayout, SeatAvailability, SeatLayout } from '../src/types/cine.js';

function localized(text: string) {
  return { text, translations: [] };
}

/**
 * Mirrors the real Andino screen 6 layout: GENERAL nearer the screen (larger y)
 * with rows numbered 1..3 labelled C,B,A, and PREFERENCIAL behind it with rows
 * numbered 1..2 labelled E,D.
 */
function makeRawLayout(): RawSeatLayout {
  const seat = (area: number, row: number, column: number, label: string, rowLabel: string) => ({
    id: `${area}_${row}_${column}`,
    position: { areaNumber: area, columnNumber: column, rowNumber: row },
    seatGroupIds: [],
    label,
    rowLabel,
    areaCategoryId: `AC${area}`,
  });

  return {
    id: 'L1',
    screenId: 'S1',
    areas: [
      // Deliberately listed with PREFERENCIAL first to prove the mapper reorders.
      {
        number: 2,
        areaCategoryId: 'AC2',
        name: localized('PREFERENCIAL'),
        columnCount: 2,
        rowCount: 2,
        boundary: { left: 0, top: 85.83, right: 10, bottom: 91.66 },
        rows: [
          { number: 1, label: 'E', seats: [seat(2, 1, 1, '1', 'E'), seat(2, 1, 2, '2', 'E')] },
          { number: 2, label: 'D', seats: [seat(2, 2, 1, '1', 'D'), seat(2, 2, 2, '2', 'D')] },
        ],
      },
      {
        number: 1,
        areaCategoryId: 'AC1',
        name: localized('GENERAL'),
        columnCount: 3,
        rowCount: 3,
        boundary: { left: 0, top: 92.0, right: 10, bottom: 99.83 },
        rows: [
          { number: 1, label: 'C', seats: [seat(1, 1, 1, '1', 'C'), seat(1, 1, 3, '2', 'C')] },
          { number: 2, label: 'B', seats: [seat(1, 2, 1, '1', 'B'), seat(1, 2, 3, '2', 'B')] },
          { number: 3, label: 'A', seats: [seat(1, 3, 1, '1', 'A'), seat(1, 3, 3, '2', 'A')] },
        ],
      },
    ],
  };
}

const layout: SeatLayout = toSeatLayout(makeRawLayout());

function availabilityOf(overrides: Record<string, string> = {}): SeatAvailability {
  const all = layout.areas.flatMap((area) => area.seats);
  return toSeatAvailability({
    seatAvailabilities: all.map((seat) => ({
      seatId: seat.id,
      status: overrides[seat.id] ?? 'Available',
    })),
    summary: {
      totalCount: all.length,
      availableCount: all.filter((seat) => (overrides[seat.id] ?? 'Available') === 'Available')
        .length,
    },
    areaCategorySummaries: [],
    isSoldOut: false,
  });
}

describe('toSeatLayout area ordering', () => {
  it('orders areas from the screen backwards using layout geometry', () => {
    // GENERAL has the larger y, which is the end row A sits at, so it comes first.
    expect(layout.areas.map((area) => area.name)).toEqual(['GENERAL', 'PREFERENCIAL']);
  });
});

describe('groupRows', () => {
  it('puts the front row first even though it has the highest row number', () => {
    const general = layout.areas[0];
    expect(groupRows(general?.seats ?? []).map((row) => row.label)).toEqual(['A', 'B', 'C']);
  });

  it('produces a continuous front-to-back alphabet across areas', () => {
    // The real data confirms the alphabet does not restart per area: at Andino
    // GENERAL runs A..L and PREFERENCIAL continues M..R.
    const labels = layout.areas.flatMap((area) => groupRows(area.seats).map((row) => row.label));
    expect(labels).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('listAvailableSeats', () => {
  it('lists seats front to back and left to right', () => {
    const seats = listAvailableSeats(layout, availabilityOf());
    expect(seats.map(({ seat }) => `${seat.row}${seat.number}`)).toEqual([
      'A1',
      'A2',
      'B1',
      'B2',
      'C1',
      'C2',
      'D1',
      'D2',
      'E1',
      'E2',
    ]);
  });

  it('excludes sold and broken seats', () => {
    const seats = listAvailableSeats(
      layout,
      availabilityOf({ '1_3_1': 'Sold', '1_3_3': 'Broken' })
    );
    expect(seats.map(({ seat }) => `${seat.row}${seat.number}`)).not.toContain('A1');
    expect(seats.map(({ seat }) => `${seat.row}${seat.number}`)).not.toContain('A2');
  });

  it('excludes statuses it does not recognise, so nothing unknown is sold', () => {
    const seats = listAvailableSeats(layout, availabilityOf({ '1_3_1': 'SocialDistancing' }));
    expect(seats.map(({ seat }) => seat.id)).not.toContain('1_3_1');
  });

  it('returns nothing when the room is full', () => {
    const allSold = Object.fromEntries(
      layout.areas.flatMap((area) => area.seats.map((seat) => [seat.id, 'Sold']))
    );
    expect(listAvailableSeats(layout, availabilityOf(allSold))).toEqual([]);
  });
});

describe('summariseAvailableSeats', () => {
  it('groups by row, preserving front-to-back order and tagging the area', () => {
    const summary = summariseAvailableSeats(listAvailableSeats(layout, availabilityOf()));
    expect(summary.map((entry) => entry.row)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(summary[0]?.area).toBe('GENERAL');
    expect(summary[4]?.area).toBe('PREFERENCIAL');
  });

  it('sorts seat numbers numerically, not as strings', () => {
    const summary = summariseAvailableSeats([
      {
        seat: { id: 'x', row: 'A', number: '10', areaName: 'G', rowIndex: 1, columnIndex: 10 },
        areaName: 'G',
      },
      {
        seat: { id: 'y', row: 'A', number: '2', areaName: 'G', rowIndex: 1, columnIndex: 2 },
        areaName: 'G',
      },
    ]);
    expect(summary[0]?.numbers).toEqual(['2', '10']);
  });
});

describe('renderSeatMap', () => {
  const lines = renderSeatMap(layout, availabilityOf({ '1_2_1': 'Sold', '1_1_1': 'Broken' }), {
    plain: true,
  });
  const text = lines.join('\n');

  it('draws the screen at the top', () => {
    expect(text).toContain('P A N T A L L A');
    const screenLine = lines.findIndex((line) => line.includes('P A N T A L L A'));
    const frontRow = lines.findIndex((line) => line.trimStart().startsWith('A '));
    expect(screenLine).toBeLessThan(frontRow);
  });

  it('renders each status with its own glyph', () => {
    expect(text).toContain('○'); // available
    expect(text).toContain('●'); // sold
    expect(text).toContain('×'); // broken
  });

  it('renders aisles as gaps by positioning seats on their grid column', () => {
    // GENERAL seats occupy columns 1 and 3, so column 2 must be blank.
    const rowA = lines.find((line) => line.trimStart().startsWith('A '));
    expect(rowA).toBe('   A ○   ○');
  });

  it('labels every row and both areas', () => {
    expect(text).toContain('GENERAL');
    expect(text).toContain('PREFERENCIAL');
    for (const label of ['A', 'B', 'C', 'D', 'E']) {
      expect(lines.some((line) => line.trimStart().startsWith(`${label} `))).toBe(true);
    }
  });

  it('emits no ANSI escapes in plain mode', () => {
    expect(text).not.toContain('\u001B[');
  });

  it('reports free seats per area', () => {
    expect(text).toContain('(4 libres)'); // GENERAL: 6 seats, 1 sold, 1 broken
    expect(text).toContain('(4 libres)'); // PREFERENCIAL: all 4 free
  });
});
