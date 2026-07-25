// Application constants for Cine Colombia CLI

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Carpeta del usuario donde viven caché y credenciales. */
const CONFIG_DIR_NAME = '.cine-colombia-cli';

export const APP_NAME = 'cine-colombia-cli';
export const APP_VERSION = '0.1.0';
export const APP_DESCRIPTION = 'Consulta cartelera, teatros y horarios de Cine Colombia';

/**
 * Cine Colombia runs on Vista Cinema's Open Commerce API (OCAPI).
 *
 * The public website embeds a short-lived JWT in its server-rendered HTML as
 * `{"api":{"apiUrl":"...","authToken":"..."}}`. That token is what authorises
 * every OCAPI call, so the CLI scrapes it once and caches it until it expires.
 *
 * Note: `WEB_BASE_URL` sits behind Cloudflare, while `API_BASE_URL` does not.
 * Only token acquisition can be challenged; all data calls go straight through.
 */
export const WEB_BASE_URL = 'https://www.cinecolombia.com';
export const API_BASE_URL = 'https://digital-api.cinecolombia.com';

/** Path used to harvest the auth token. Any server-rendered page carries it. */
export const TOKEN_SOURCE_PATH = '/';

/**
 * Headers sent when scraping the token page.
 *
 * The capitalisation of these keys is load-bearing. Cloudflare inspects the raw
 * HTTP/1.1 header names, and real browsers send them title-cased. Measured
 * against the live site, repeatably:
 *
 *   - `User-Agent: <chrome>` ................. 200 + token
 *   - `user-agent: <chrome>` ................. 403 challenge
 *   - no user agent at all ................... 403 challenge
 *   - `Accept: text/html,...` added .......... 403 challenge
 *
 * Two consequences:
 *
 *  1. Never lowercase these keys. This is also why the runtime's `fetch` cannot
 *     reach this page: the `Headers` spec normalises every name to lowercase, so
 *     `fetch` is structurally incapable of sending `User-Agent`.
 *  2. Do not add an `Accept` header. A browser-style `Accept` from a non-browser
 *     client is treated as a contradiction and challenged. Leave the HTTP
 *     client's default alone.
 */
export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
} as const;

// Cache TTL configuration (in minutes)
export const CACHE_TTL = {
  sites: 24 * 60, // Theatres barely change
  films: 6 * 60, // Cartelera rotates weekly, refresh a few times a day
  showtimes: 30, // Sold-out state matters, keep it fresh
  seatLayout: 24 * 60, // Physical layout is static per screen
  // Seat occupancy changes minute to minute. Cached only long enough to avoid
  // hammering the API when a command reads it twice in one run; showing a stale
  // seat as free would send someone to a taken seat.
  seatAvailability: 1,
  ticketPrices: 12 * 60, // Price lists are stable within a day
  screeningDates: 60, // Which dates a film screens
  menu: 6 * 60, // Concessions menu and prices
} as const;

// Default values
export const DEFAULTS = {
  timeout: 30000, // Request timeout in ms
  retries: 2, // Retry attempts for transient failures
  city: 'Bogotá', // Default city filter
} as const;

/**
 * Refresh the token this many minutes before it actually expires, so a long
 * running command never dies mid-flight on a boundary.
 */
export const TOKEN_REFRESH_BUFFER_MINUTES = 10;

/**
 * Where this installation's own files live.
 *
 * Found by walking up from this module until a directory contains the login helper,
 * rather than assuming a fixed number of levels. The bundled build collapses
 * `src/config/constants.ts` into a single file at a different depth, so counting
 * `../..` works in the repo and breaks once published.
 */
export const PROJECT_ROOT = findInstallRoot();

function findInstallRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'scripts', 'capture-session.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Nothing found: fall back to two levels up, which is right in the repo layout.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Where the token cache and the account session are kept.
 *
 * In the user's home directory, not inside the package. Two reasons, and both bite
 * only once installed: `npx` unpacks the package into a throwaway cache, so anything
 * written there is lost between runs; and a globally installed CLI writing into
 * `node_modules` is both surprising and often not writable.
 *
 * Anchoring to `process.cwd()` was worse still — it scattered caches into whatever
 * directory the person happened to be standing in, and made `ver_cuenta` answer "no
 * hay sesión" with a perfectly good session on disk.
 */
export const CACHE_DIR = join(homedir(), CONFIG_DIR_NAME);

/** Token cache lives alongside other cached data but is treated as a secret. */
export const TOKEN_CACHE_FILE = '.auth-token.json';

// Kept for callers that only want the folder name.
export const CONFIG_DIR = CONFIG_DIR_NAME;
