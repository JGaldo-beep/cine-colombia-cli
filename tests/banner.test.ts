import { describe, expect, it } from 'bun:test';
import { renderBanner, shouldShowBanner } from '../src/lib/banner.js';

/** Strip colour escapes. Built with RegExp so no control char sits in a literal. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, 'g');
function plain(subtitle = 'x'): string {
  return renderBanner(subtitle).replace(ANSI, '');
}

describe('shouldShowBanner', () => {
  it('greets on a bare invocation in a terminal', () => {
    expect(shouldShowBanner([], true)).toBe(true);
  });

  it('shows on help, which is a screen for a person', () => {
    expect(shouldShowBanner(['--help'], true)).toBe(true);
    expect(shouldShowBanner(['-h'], true)).toBe(true);
    expect(shouldShowBanner(['cartelera', '--help'], true)).toBe(true);
  });

  it('never prints when stdout is not a terminal', () => {
    // The output belongs to another program: jq, a file, another shell.
    expect(shouldShowBanner([], false)).toBe(false);
    expect(shouldShowBanner(['--help'], false)).toBe(false);
  });

  it('never prints alongside --json', () => {
    // `--json` is a promise that stdout is parseable. Art would break it even on
    // a terminal, where someone may still be copying the output.
    expect(shouldShowBanner(['cartelera', '--json'], true)).toBe(false);
    expect(shouldShowBanner(['--json'], true)).toBe(false);
    expect(shouldShowBanner(['--help', '--json'], true)).toBe(false);
  });

  it('never prints for --version, which scripts parse', () => {
    expect(shouldShowBanner(['--version'], true)).toBe(false);
    expect(shouldShowBanner(['-V'], true)).toBe(false);
  });

  it('stays out of the way of real commands', () => {
    // Someone asking for showtimes wants the answer, not a screenful of art.
    expect(shouldShowBanner(['cartelera'], true)).toBe(false);
    expect(shouldShowBanner(['horarios', 'Odisea'], true)).toBe(false);
    expect(shouldShowBanner(['comprar', '6493-7850'], true)).toBe(false);
  });

  it('treats flag-only invocations as the welcome screen', () => {
    // `cine -v` names no command, so help is what commander prints.
    expect(shouldShowBanner(['-v'], true)).toBe(true);
  });
});

describe('renderBanner', () => {
  it('includes the subtitle it is given', () => {
    expect(renderBanner('un subtítulo')).toContain('un subtítulo');
  });

  it('keeps every line within 80 columns', () => {
    // Wider than the terminal and the art wraps into nonsense.
    for (const line of plain().split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('aligns the wordmark with the film strips', () => {
    const lines = plain()
      .split('\n')
      .filter((l) => l.trim());
    const strips = lines.filter((l) => l.includes('▛'));
    const art = lines.filter((l) => l.includes('█'));

    expect(strips).toHaveLength(2);
    expect(strips[0]).toBe(strips[1]);
    // The strip should be as wide as the widest line of the wordmark.
    expect(strips[0]?.length).toBe(Math.max(...art.map((l) => l.length)));
  });

  it('keeps the wordmark intact between the two strips', () => {
    // Guards against an edit dropping or duplicating a row of the art: the two
    // words are six rows each, framed by the strips.
    const lines = plain().split('\n');
    const first = lines.findIndex((l) => l.includes('▛'));
    const last = lines.findLastIndex((l) => l.includes('▛'));

    const rows = lines.slice(first + 1, last).filter((l) => l.trim());
    expect(rows).toHaveLength(12);
  });
});
