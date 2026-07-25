import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTimeRemaining } from '../src/lib/format.js';
import {
  type MemberSessionStatus,
  MemberSessionStore,
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
