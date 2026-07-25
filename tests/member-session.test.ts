import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../src/lib/errors.js';
import { formatTimeRemaining } from '../src/lib/format.js';
import {
  type MemberSessionStatus,
  MemberSessionStore,
  isSessionExpiredError,
  sessionNotice,
} from '../src/services/auth/member-session.js';

const dirs: string[] = [];

/** A store backed by a throwaway directory, so tests never touch real data. */
function storeWith(session: unknown): MemberSessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'cine-session-'));
  dirs.push(dir);
  if (session !== undefined) {
    writeFileSync(join(dir, '.member-session.json'), JSON.stringify(session));
  }
  return new MemberSessionStore(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOUR = 3600_000;

describe('MemberSessionStore.status', () => {
  it('reports an unexpired session as active', () => {
    const store = storeWith({ cookie: 'abc', expiresAt: Date.now() + HOUR });
    expect(store.status()).toBe('active');
  });

  it('treats a session with no expiry as active', () => {
    // Absent expiry means "unknown", not "already dead".
    const store = storeWith({ cookie: 'abc', expiresAt: null });
    expect(store.status()).toBe('active');
  });

  it('distinguishes an expired session from never having signed in', () => {
    // This distinction is the whole point: it decides which message the person
    // sees when the CLI stops acting as their account.
    expect(storeWith({ cookie: 'abc', expiresAt: Date.now() - 1000 }).status()).toBe('expired');
    expect(storeWith(undefined).status()).toBe('anonymous');
  });

  it('treats a file with no usable cookie as anonymous, not expired', () => {
    expect(storeWith({ cookie: '' }).status()).toBe('anonymous');
    expect(storeWith({}).status()).toBe('anonymous');
  });

  it('stops reporting expiry after a deliberate logout', () => {
    // Clearing is a choice, not a timeout; saying "your session expired" would
    // misdescribe what the person just did.
    const store = storeWith({ cookie: 'abc', expiresAt: Date.now() - 1000 });
    expect(store.status()).toBe('expired');
    store.clear();
    expect(store.status()).toBe('anonymous');
  });

  it('reports active again after saving a fresh session over an expired one', () => {
    const store = storeWith({ cookie: 'viejo', expiresAt: Date.now() - 1000 });
    expect(store.status()).toBe('expired');
    store.save({
      cookie: 'nuevo',
      capturedAt: new Date().toISOString(),
      expiresAt: Date.now() + HOUR,
      email: null,
    });
    expect(store.status()).toBe('active');
  });

  it('withholds the cookie header once the session has expired', () => {
    // Sending a dead cookie would produce an opaque 401 instead of a clear
    // "log in again".
    expect(storeWith({ cookie: 'abc', expiresAt: Date.now() - 1000 }).cookieHeader()).toBeNull();
    expect(storeWith({ cookie: 'abc', expiresAt: Date.now() + HOUR }).cookieHeader()).toContain(
      'abc'
    );
  });
});

describe('MemberSessionStore.timeToExpiry', () => {
  it('reports the remaining milliseconds', () => {
    const store = storeWith({ cookie: 'abc', expiresAt: Date.now() + HOUR });
    const remaining = store.timeToExpiry();
    expect(remaining).not.toBeNull();
    expect(remaining as number).toBeGreaterThan(HOUR - 5000);
    expect(remaining as number).toBeLessThanOrEqual(HOUR);
  });

  it('returns null when there is no session or no known expiry', () => {
    expect(storeWith(undefined).timeToExpiry()).toBeNull();
    expect(storeWith({ cookie: 'abc', expiresAt: null }).timeToExpiry()).toBeNull();
  });
});

describe('sessionNotice', () => {
  it('tells an expired session apart from an anonymous one', () => {
    expect(sessionNotice('expired').title).toContain('expiró');
    expect(sessionNotice('anonymous').title).toContain('No has iniciado');
  });

  it('always points at the command that fixes it', () => {
    for (const status of ['expired', 'anonymous'] as MemberSessionStatus[]) {
      expect(sessionNotice(status).hint).toContain('cine login');
    }
  });
});

describe('formatTimeRemaining', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatTimeRemaining(25 * 60_000)).toBe('en 25 minutos');
    expect(formatTimeRemaining(3 * HOUR)).toBe('en 3 horas');
    expect(formatTimeRemaining(5 * 24 * HOUR)).toBe('en 5 días');
  });

  it('uses the singular where Spanish needs it', () => {
    expect(formatTimeRemaining(60_000)).toBe('en 1 minuto');
    expect(formatTimeRemaining(HOUR)).toBe('en 1 hora');
    expect(formatTimeRemaining(24 * HOUR)).toBe('en 1 día');
  });

  it('describes a session that is already gone', () => {
    expect(formatTimeRemaining(0)).toBe('vencida');
    expect(formatTimeRemaining(-5000)).toBe('vencida');
  });

  it('admits when there is no known expiry instead of inventing one', () => {
    expect(formatTimeRemaining(null)).toBe('sin vencimiento conocido');
  });
});

describe('MemberSessionStore.markExpired', () => {
  it('removes the credential but remembers why', () => {
    // The cookie is proven useless, so it must not stay on disk; but the reason has
    // to survive, or the next command would say "you never signed in".
    const store = storeWith({
      cookie: 'muerta',
      capturedAt: '2026-07-25T02:19:26.248Z',
      expiresAt: Date.now() + 30 * 24 * HOUR,
      email: 'alguien@ejemplo.com',
    });
    expect(store.status()).toBe('active');

    store.markExpired();

    expect(store.status()).toBe('expired');
    expect(store.cookieHeader()).toBeNull();
    expect(store.isLoggedIn()).toBe(false);
  });

  it('keeps reporting expiry in a later process', () => {
    // A fresh store over the same directory is what the next command sees.
    const dir = mkdtempSync(join(tmpdir(), 'cine-session-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, '.member-session.json'),
      JSON.stringify({ cookie: 'viva', expiresAt: Date.now() + HOUR, email: null })
    );

    new MemberSessionStore(dir).markExpired();

    const next = new MemberSessionStore(dir);
    expect(next.status()).toBe('expired');
    expect(next.cookieHeader()).toBeNull();
  });

  it('does not leave the cookie value on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cine-session-'));
    dirs.push(dir);
    const file = join(dir, '.member-session.json');
    writeFileSync(file, JSON.stringify({ cookie: 'secreto-largo', expiresAt: null, email: null }));

    new MemberSessionStore(dir).markExpired();

    expect(readFileSync(file, 'utf-8')).not.toContain('secreto-largo');
  });

  it('is undone by a fresh login', () => {
    const store = storeWith({ cookie: 'vieja', expiresAt: Date.now() + HOUR });
    store.markExpired();
    expect(store.status()).toBe('expired');

    store.save({
      cookie: 'nueva',
      capturedAt: new Date().toISOString(),
      expiresAt: Date.now() + HOUR,
      email: null,
    });
    expect(store.status()).toBe('active');
  });

  it('is undone by an explicit logout', () => {
    // Logging out is a choice; it must not keep saying "expired" afterwards.
    const store = storeWith({ cookie: 'vieja', expiresAt: Date.now() + HOUR });
    store.markExpired();
    store.clear();
    expect(store.status()).toBe('anonymous');
  });
});

describe('isSessionExpiredError', () => {
  it('recognises the 403 Cine Colombia sends for a dead session', () => {
    // It is 403, not 401, which is why it slipped past the retry path.
    const body = JSON.stringify({
      status: 403,
      title: 'Loyalty Member Authentication Token Expired',
      detail: 'Loyalty member authentication token is expired.',
    });
    expect(
      isSessionExpiredError(
        new ApiError('API_ERROR', 'La API respondió 403 en /ocapi/v1/members/current', 403, body)
      )
    ).toBe(true);
  });

  it('ignores a 403 that means something else', () => {
    // Not every refusal is an expired session.
    expect(
      isSessionExpiredError(new ApiError('API_ERROR', 'La API respondió 403', 403, 'Forbidden'))
    ).toBe(false);
  });

  it('ignores other statuses and non-API errors', () => {
    const body = 'Loyalty member authentication token is expired.';
    expect(isSessionExpiredError(new ApiError('API_ERROR', 'x', 401, body))).toBe(false);
    expect(isSessionExpiredError(new ApiError('API_ERROR', 'x', 500, body))).toBe(false);
    expect(isSessionExpiredError(new Error('cualquier cosa'))).toBe(false);
    expect(isSessionExpiredError(null)).toBe(false);
  });
});
