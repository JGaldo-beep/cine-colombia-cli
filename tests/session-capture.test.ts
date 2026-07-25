import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CineError } from '../src/lib/errors.js';
import {
  CAPTURE_EXIT,
  clearLoginProfile,
  describeCaptureFailure,
  loginProfilePath,
  parseCaptureResult,
} from '../src/services/auth/session-capture.js';

describe('describeCaptureFailure', () => {
  it('tells the person how to install Playwright when it is missing', () => {
    const error = describeCaptureFailure(CAPTURE_EXIT.playwrightMissing);
    expect(error.code).toBe('PLAYWRIGHT_MISSING');
    expect(error.message).toContain('bun add playwright');
  });

  it('distinguishes a timeout from a browser the person closed', () => {
    // These need different wording: one means "you ran out of time", the other
    // means "you changed your mind". Telling someone they timed out when they
    // deliberately closed the window is confusing.
    expect(describeCaptureFailure(CAPTURE_EXIT.timeout).code).toBe('LOGIN_TIMEOUT');
    expect(describeCaptureFailure(CAPTURE_EXIT.browserClosed).code).toBe('LOGIN_CANCELLED');
  });

  it('points at Chrome when the browser could not start', () => {
    const error = describeCaptureFailure(CAPTURE_EXIT.launchFailed);
    expect(error.code).toBe('LOGIN_BROWSER_FAILED');
    expect(error.message).toContain('Chrome');
  });

  it('reports a usage error as internal rather than blaming the person', () => {
    expect(describeCaptureFailure(CAPTURE_EXIT.usage).code).toBe('LOGIN_HELPER_USAGE');
  });

  it('still produces an actionable error for unknown exit codes', () => {
    // A crash or a signal must not surface as "undefined".
    const error = describeCaptureFailure(99);
    expect(error.code).toBe('LOGIN_FAILED');
    expect(error.message).toContain('99');
    expect(error.message).toContain('cine login');
  });

  it('handles a null exit code, which is what a killed process reports', () => {
    const error = describeCaptureFailure(null);
    expect(error.code).toBe('LOGIN_FAILED');
    expect(error.message).toContain('desconocido');
  });

  it('always returns a CineError so the CLI can render it uniformly', () => {
    for (const code of [...Object.values(CAPTURE_EXIT), null, 42]) {
      expect(describeCaptureFailure(code)).toBeInstanceOf(CineError);
    }
  });
});

describe('parseCaptureResult', () => {
  it('reads the cookie and its expiry', () => {
    const result = parseCaptureResult(
      JSON.stringify({ cookie: 'abc123', expiresAt: 1800000000000 })
    );
    expect(result).toEqual({ cookie: 'abc123', expiresAt: 1800000000000 });
  });

  it('treats a session cookie with no expiry as null', () => {
    // The helper normalises Playwright's -1 to null; anything non-numeric that
    // still reaches here must not become NaN.
    expect(
      parseCaptureResult(JSON.stringify({ cookie: 'abc', expiresAt: null })).expiresAt
    ).toBeNull();
    expect(parseCaptureResult(JSON.stringify({ cookie: 'abc' })).expiresAt).toBeNull();
    expect(
      parseCaptureResult(JSON.stringify({ cookie: 'abc', expiresAt: 'pronto' })).expiresAt
    ).toBeNull();
  });

  it('rejects a result with no usable cookie', () => {
    // Saving an empty cookie would produce a session that looks valid and then
    // fails with an opaque 401 on the next command.
    for (const payload of ['{}', JSON.stringify({ cookie: '' }), JSON.stringify({ cookie: 7 })]) {
      expect(() => parseCaptureResult(payload)).toThrow(CineError);
    }
    expect(() => parseCaptureResult('{}')).toThrow(/no devolvió una sesión válida/);
  });

  it('rejects contents that are not JSON', () => {
    expect(() => parseCaptureResult('no-es-json')).toThrow(/No se pudo leer/);
    expect(() => parseCaptureResult('')).toThrow(CineError);
  });
});

describe('clearLoginProfile', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A cache dir holding a login profile with something inside it. */
  function cacheDirWithProfile(): string {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cine-profile-'));
    dirs.push(cacheDir);
    const profile = loginProfilePath(cacheDir);
    mkdirSync(join(profile, 'Default', 'Network'), { recursive: true });
    writeFileSync(join(profile, 'Default', 'Network', 'Cookies'), 'jar simulado');
    return cacheDir;
  }

  it('removes the profile and everything in it', () => {
    // Chrome persists the member cookie here, so a logout that left this behind
    // would leave a usable credential on disk.
    const cacheDir = cacheDirWithProfile();
    expect(existsSync(loginProfilePath(cacheDir))).toBe(true);

    expect(clearLoginProfile(cacheDir)).toBe(true);
    expect(existsSync(loginProfilePath(cacheDir))).toBe(false);
  });

  it('reports that there was nothing to remove', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cine-profile-'));
    dirs.push(cacheDir);
    expect(clearLoginProfile(cacheDir)).toBe(false);
  });

  it('is safe to call twice', () => {
    const cacheDir = cacheDirWithProfile();
    expect(clearLoginProfile(cacheDir)).toBe(true);
    expect(clearLoginProfile(cacheDir)).toBe(false);
  });

  it('keeps the profile inside the cache directory', () => {
    // The path is deleted recursively, so it must never escape the cache dir.
    const path = loginProfilePath('data');
    expect(path.startsWith('data')).toBe(true);
    expect(path).not.toContain('..');
  });
});
