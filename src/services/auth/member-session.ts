// Member (account) session for Cine Colombia.
//
// Cine Colombia's login is protected by reCAPTCHA, so no CLI can authenticate over
// plain HTTP — that is exactly what reCAPTCHA is for. Instead `cine login` opens a
// real browser, the person signs in themselves, and we keep only the resulting
// session cookie.
//
// What was established against the live API:
//
//   - Identity lives in the `vista-loyalty-member-authentication-token` cookie.
//     Sending it turns `GET /ocapi/v1/members/current` from 401 into 200.
//   - The bearer token is *not* member-specific: the checkout app's token carries
//     no user claims. So the ordinary public token plus this cookie is enough, and
//     nothing extra needs capturing.
//
// The password is never seen, stored or transmitted by this CLI.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CACHE_DIR } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

/** Cookie that carries the member's identity. */
export const MEMBER_COOKIE_NAME = 'vista-loyalty-member-authentication-token';

/** Companion flag cookie the web app sets; sent alongside for fidelity. */
export const MEMBER_FLAG_COOKIE_NAME = 'vista-loyalty-member-is-authenticated';

const SESSION_FILE = '.member-session.json';

export interface MemberSession {
  /** Value of the member cookie. Treat as a credential. */
  cookie: string;
  /** When it was captured, as an ISO timestamp, for display only. */
  capturedAt: string;
  /** Cookie expiry in epoch milliseconds, when the browser reported one. */
  expiresAt: number | null;
  /** Email the session belongs to, so `cine cuenta` can name it without a call. */
  email: string | null;
}

export class MemberSessionStore {
  private path: string;
  private memo: MemberSession | null | undefined;

  constructor(cacheDir: string = CACHE_DIR) {
    this.path = join(cacheDir, SESSION_FILE);
  }

  /** The stored session, or null when not logged in or it has expired. */
  load(): MemberSession | null {
    if (this.memo !== undefined) return this.memo;

    try {
      if (!existsSync(this.path)) {
        this.memo = null;
        return null;
      }

      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<MemberSession>;
      if (typeof parsed.cookie !== 'string' || !parsed.cookie) {
        this.memo = null;
        return null;
      }

      // A cookie past its expiry is dead weight; treat it as logged out so the
      // user is told to log in again instead of seeing a confusing 401.
      if (typeof parsed.expiresAt === 'number' && parsed.expiresAt <= Date.now()) {
        logger.debug('La sesión de miembro guardada ya expiró');
        this.memo = null;
        return null;
      }

      this.memo = {
        cookie: parsed.cookie,
        capturedAt: parsed.capturedAt ?? new Date(0).toISOString(),
        expiresAt: parsed.expiresAt ?? null,
        email: parsed.email ?? null,
      };
      return this.memo;
    } catch (error) {
      logger.debug('Sesión de miembro ilegible, se ignora:', error);
      this.memo = null;
      return null;
    }
  }

  save(session: MemberSession): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // 0600: this cookie is enough to act as the account holder.
    writeFileSync(this.path, JSON.stringify(session, null, 2), { mode: 0o600 });
    this.memo = session;
  }

  /** Forget the session. Returns false when there was nothing to forget. */
  clear(): boolean {
    this.memo = null;
    try {
      if (!existsSync(this.path)) return false;
      unlinkSync(this.path);
      return true;
    } catch (error) {
      logger.debug('No se pudo borrar la sesión de miembro:', error);
      return false;
    }
  }

  isLoggedIn(): boolean {
    return this.load() !== null;
  }

  /** `Cookie` header value for authenticated requests, or null when logged out. */
  cookieHeader(): string | null {
    const session = this.load();
    if (!session) return null;
    return `${MEMBER_COOKIE_NAME}=${session.cookie}; ${MEMBER_FLAG_COOKIE_NAME}=true`;
  }
}

export const memberSession = new MemberSessionStore();
