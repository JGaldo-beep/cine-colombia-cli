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

/**
 * Why the CLI is acting anonymously, which decides what to tell the person.
 *
 * "Never signed in" and "your session ran out" need different words: someone who
 * did log in and is suddenly asked to type their details again deserves to know
 * why, otherwise the CLI looks broken.
 */
export type MemberSessionStatus = 'active' | 'expired' | 'anonymous';

/**
 * What to tell someone the CLI is not acting as their account.
 *
 * Pure and shared, so `cine cuenta` and `cine comprar` cannot drift into
 * explaining the same situation differently.
 */
export function sessionNotice(status: MemberSessionStatus): { title: string; hint: string } {
  if (status === 'expired') {
    return {
      title: 'Tu sesión expiró.',
      hint: 'Ejecuta "cine login" para volver a vincular tu cuenta.',
    };
  }

  return {
    title: 'No has iniciado sesión.',
    hint: 'Ejecuta "cine login" para vincular tu cuenta.',
  };
}

export class MemberSessionStore {
  private path: string;
  private memo: MemberSession | null | undefined;
  private expired = false;

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
        this.expired = true;
        this.memo = null;
        return null;
      }

      this.expired = false;
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
    this.expired = false;
    this.memo = session;
  }

  /** Forget the session. Returns false when there was nothing to forget. */
  clear(): boolean {
    this.memo = null;
    // A deliberate logout is not an expiry; it must not produce "your session
    // ran out" on the next command.
    this.expired = false;
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

  /** Whether there is a usable session, and if not, why not. */
  status(): MemberSessionStatus {
    if (this.load()) return 'active';
    return this.expired ? 'expired' : 'anonymous';
  }

  /** Milliseconds until the session expires, or null when it has no known expiry. */
  timeToExpiry(): number | null {
    const session = this.load();
    if (!session || session.expiresAt === null) return null;
    return session.expiresAt - Date.now();
  }

  /** `Cookie` header value for authenticated requests, or null when logged out. */
  cookieHeader(): string | null {
    const session = this.load();
    if (!session) return null;
    return `${MEMBER_COOKIE_NAME}=${session.cookie}; ${MEMBER_FLAG_COOKIE_NAME}=true`;
  }
}

export const memberSession = new MemberSessionStore();
