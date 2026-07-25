// Auth token acquisition for the Vista OCAPI backend.
//
// Cine Colombia's website is a single-page app that receives its API credentials
// from the server inside the initial HTML:
//
//   {"api":{"apiUrl":"https://digital-api.cinecolombia.com/","authToken":"eyJ..."}}
//
// That JWT is an organisation-scoped browsing token valid for roughly 12 hours.
// We scrape it once, cache it on disk, and reuse it until shortly before it
// expires. The API host itself is not behind Cloudflare, so this single HTML
// fetch is the only step that can ever be challenged — see `html-fetcher.ts` for
// how that is handled.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  API_BASE_URL,
  CACHE_DIR,
  TOKEN_CACHE_FILE,
  TOKEN_REFRESH_BUFFER_MINUTES,
  TOKEN_SOURCE_PATH,
  WEB_BASE_URL,
} from '../../config/constants.js';
import { AuthError, NetworkError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { fetchHtml } from './html-fetcher.js';

export interface ApiCredentials {
  token: string;
  apiUrl: string;
  /** Unix epoch milliseconds when the token stops being valid. */
  expiresAt: number;
}

/** Matches the embedded config block, tolerating key order and whitespace. */
const AUTH_TOKEN_PATTERN = /"authToken"\s*:\s*"([^"]+)"/;
const API_URL_PATTERN = /"apiUrl"\s*:\s*"([^"]+)"/;

/** Cloudflare's interstitial always carries this title. */
const CHALLENGE_MARKERS = [
  'Just a moment...',
  'cf-browser-verification',
  'challenges.cloudflare.com',
];

export class TokenProvider {
  private cachePath: string;
  private memo: ApiCredentials | null = null;

  constructor(cacheDir: string = CACHE_DIR) {
    this.cachePath = join(cacheDir, TOKEN_CACHE_FILE);
  }

  /**
   * Return valid credentials, reusing the cache when possible.
   *
   * @param forceRefresh Bypass both the in-memory and on-disk cache. Use this
   *   after the API rejects a token that we believed was still good.
   */
  async getCredentials(forceRefresh = false): Promise<ApiCredentials> {
    if (!forceRefresh) {
      const cached = this.memo ?? this.readCache();
      if (cached && this.isUsable(cached)) {
        this.memo = cached;
        return cached;
      }
    }

    const fresh = await this.fetchCredentials();
    this.memo = fresh;
    this.writeCache(fresh);
    return fresh;
  }

  /** Drop cached credentials so the next call re-scrapes. */
  invalidate(): void {
    this.memo = null;
    try {
      if (existsSync(this.cachePath)) unlinkSync(this.cachePath);
    } catch (error) {
      logger.debug('No se pudo borrar el token en caché:', error);
    }
  }

  /** True while the token still has more than the refresh buffer left. */
  private isUsable(creds: ApiCredentials): boolean {
    const bufferMs = TOKEN_REFRESH_BUFFER_MINUTES * 60 * 1000;
    return creds.expiresAt - Date.now() > bufferMs;
  }

  private async fetchCredentials(): Promise<ApiCredentials> {
    const url = `${WEB_BASE_URL}${TOKEN_SOURCE_PATH}`;
    logger.debug('Obteniendo token desde', url);

    let result: Awaited<ReturnType<typeof fetchHtml>>;
    try {
      // The only thing that matters is whether the body carries a token: the site
      // serves its 404 page with valid credentials, and Cloudflare serves
      // challenges under both 403 and 200. Status alone proves nothing.
      result = await fetchHtml(url, ({ body }) => AUTH_TOKEN_PATTERN.test(body));
    } catch (error) {
      throw new NetworkError(
        'TOKEN_FETCH_UNREACHABLE',
        `No se pudo contactar cinecolombia.com: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    const html = result.body;
    const token = html.match(AUTH_TOKEN_PATTERN)?.[1];

    if (!token && this.looksLikeChallenge(html)) throw this.challengeError();

    if (!token) {
      throw new AuthError(
        'TOKEN_NOT_FOUND',
        'La página cargó pero no contiene "authToken". Es probable que Cine Colombia haya cambiado cómo entrega sus credenciales.',
        { bodyLength: html.length, status: result.status, via: result.via }
      );
    }

    // Trust the site's own apiUrl so a backend migration doesn't break the CLI.
    const apiUrl = (html.match(API_URL_PATTERN)?.[1] ?? API_BASE_URL).replace(/\/+$/, '');

    const credentials: ApiCredentials = {
      token,
      apiUrl,
      expiresAt: readJwtExpiry(token) ?? Date.now() + 60 * 60 * 1000,
    };

    logger.debug(
      `Token obtenido vía "${result.via}", expira ${new Date(credentials.expiresAt).toISOString()} (api: ${apiUrl})`
    );
    return credentials;
  }

  private looksLikeChallenge(html: string): boolean {
    return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
  }

  private challengeError(): AuthError {
    return new AuthError(
      'CLOUDFLARE_CHALLENGE',
      'Cloudflare interpuso una verificación humana en todas las estrategias de descarga. ' +
        'Verifica que "curl" esté instalado y disponible en el PATH; si lo está, ' +
        'abre https://www.cinecolombia.com en tu navegador, completa la verificación y reintenta.',
      { url: `${WEB_BASE_URL}${TOKEN_SOURCE_PATH}` }
    );
  }

  private readCache(): ApiCredentials | null {
    try {
      if (!existsSync(this.cachePath)) return null;
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf-8')) as Partial<ApiCredentials>;
      if (
        typeof parsed.token !== 'string' ||
        typeof parsed.apiUrl !== 'string' ||
        typeof parsed.expiresAt !== 'number'
      ) {
        return null;
      }
      return { token: parsed.token, apiUrl: parsed.apiUrl, expiresAt: parsed.expiresAt };
    } catch (error) {
      logger.debug('Token en caché ilegible, se descarta:', error);
      return null;
    }
  }

  private writeCache(creds: ApiCredentials): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
    } catch (error) {
      // A read-only filesystem should slow us down, not stop us.
      logger.debug('No se pudo guardar el token en caché:', error);
    }
  }
}

/**
 * Read the `exp` claim without verifying the signature.
 *
 * We are not authenticating the token, only scheduling its refresh, so decoding
 * the payload is enough. Returns null when the token is not a readable JWT.
 */
export function readJwtExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;

  try {
    const normalised = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=');
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as {
      exp?: number;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Shared instance; the token is process-wide state. */
export const tokenProvider = new TokenProvider();
