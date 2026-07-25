// The welcome banner.
//
// Two rules shape this file.
//
// First, the art is hard-coded rather than generated with figlet at startup. It
// never changes, so generating it would only add a dependency, font file I/O on
// every run, and a way for the output to drift between versions.
//
// Second, and more important: **a banner must never reach a pipe.** Every command
// here supports `--json`, and this project keeps stdout clean so output can be fed
// to `jq` (see logger.ts). A banner printed unconditionally would corrupt that. So
// it is shown only for the welcome and help screens, only on a terminal, and never
// alongside `--json`.

import pc from 'picocolors';

/**
 * "CINE" centred over "COLOMBIA" in the ANSI Shadow figlet font, 64 columns wide
 * so it fits an 80-column terminal with margin.
 */
const WORDMARK = [
  '                  ██████╗██╗███╗   ██╗███████╗',
  '                 ██╔════╝██║████╗  ██║██╔════╝',
  '                 ██║     ██║██╔██╗ ██║█████╗',
  '                 ██║     ██║██║╚██╗██║██╔══╝',
  '                 ╚██████╗██║██║ ╚████║███████╗',
  '                  ╚═════╝╚═╝╚═╝  ╚═══╝╚══════╝',
  ' ██████╗ ██████╗ ██╗      ██████╗ ███╗   ███╗██████╗ ██╗ █████╗',
  '██╔════╝██╔═══██╗██║     ██╔═══██╗████╗ ████║██╔══██╗██║██╔══██╗',
  '██║     ██║   ██║██║     ██║   ██║██╔████╔██║██████╔╝██║███████║',
  '██║     ██║   ██║██║     ██║   ██║██║╚██╔╝██║██╔══██╗██║██╔══██║',
  '╚██████╗╚██████╔╝███████╗╚██████╔╝██║ ╚═╝ ██║██████╔╝██║██║  ██║',
  ' ╚═════╝ ╚═════╝ ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝',
];

const WORDMARK_WIDTH = 64;
const INDENT = '  ';

/** A strip of film perforations, sized to the wordmark. */
const FILM_STRIP = '▛▀▀▜ '.repeat(Math.ceil(WORDMARK_WIDTH / 5)).slice(0, WORDMARK_WIDTH);

/** Cine Colombia's red, fading to a darker shade down the wordmark. */
const RED: Rgb = [206, 17, 18];
const DEEP_RED: Rgb = [122, 12, 22];
const STRIP_GREY: Rgb = [95, 95, 100];

type Rgb = [number, number, number];

/**
 * Wrap text in a 24-bit colour escape.
 *
 * Hand-rolled because picocolors has no truecolor support and pulling in a
 * gradient library for eleven lines of art is not a trade worth making. Colour is
 * skipped entirely when picocolors reports it is unsupported, which is what honours
 * `NO_COLOR` and non-terminal output.
 */
function rgb(text: string, [r, g, b]: Rgb): string {
  if (!pc.isColorSupported) return text;
  return `\u001B[38;2;${r};${g};${b}m${text}\u001B[39m`;
}

/** Interpolate between two colours; `t` runs 0 → 1. */
function blend(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

/** The banner as a string, so it can be tested without capturing stdout. */
export function renderBanner(subtitle: string): string {
  const body = WORDMARK.map((line, i) =>
    rgb(`${INDENT}${line}`, blend(RED, DEEP_RED, i / (WORDMARK.length - 1)))
  );

  return [
    '',
    rgb(`${INDENT}${FILM_STRIP}`, STRIP_GREY),
    ...body,
    rgb(`${INDENT}${FILM_STRIP}`, STRIP_GREY),
    '',
    `${INDENT}${pc.dim(subtitle)}`,
    '',
  ].join('\n');
}

/**
 * Whether this invocation should show the banner.
 *
 * Pure, so every rule is testable: decoration must not be the reason a script
 * breaks.
 *
 * @param argv the arguments after the program name.
 * @param isTty whether stdout is a terminal.
 */
export function shouldShowBanner(argv: string[], isTty: boolean): boolean {
  // Piped or redirected output belongs to another program, not to a human.
  if (!isTty) return false;

  // `--json` promises machine-readable output on stdout.
  if (argv.includes('--json')) return false;

  // Anything asking for a version wants one line it can parse.
  if (argv.includes('-V') || argv.includes('--version')) return false;

  // Otherwise: only the welcome screen and help. Running an actual command should
  // get to the answer without a screenful of decoration first.
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  return positional.length === 0 || argv.includes('-h') || argv.includes('--help');
}

export function showBanner(subtitle: string): void {
  console.log(renderBanner(subtitle));
}
