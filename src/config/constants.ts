// Application constants for Cine Colombia CLI

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Where this installation lives, derived from this file's own location.
 *
 * Anchoring to the module rather than to `process.cwd()` matters because the CLI is
 * not always launched from the project directory. An MCP client starts the server
 * with whatever working directory it happens to have, and a globally installed
 * `cine` runs wherever the person is standing. With a relative path the effect was
 * quiet and confusing rather than loud: the token cache and the session file were
 * looked up in the wrong place, so `ver_cuenta` answered "no hay sesión" while a
 * perfectly good session sat on disk, and caches were written into unrelated
 * directories.
 */
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Cache directory, absolute so it does not follow the working directory. */
export const CACHE_DIR = join(PROJECT_ROOT, 'data');

/** Token cache lives alongside other cached data but is treated as a secret. */
export const TOKEN_CACHE_FILE = '.auth-token.json';

// User config directory (for saved preferences)
export const CONFIG_DIR = '.cine-colombia-cli';
