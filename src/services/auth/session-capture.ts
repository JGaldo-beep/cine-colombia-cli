// Drives the browser step of `cine login` and brings back the session cookie.
//
// The actual browser work lives in scripts/capture-session.mjs and runs under
// Node, because Playwright's `launch()` hangs forever under Bun on Windows (see
// that file for the measurements). This module is the boundary: it spawns the
// helper, interprets how it ended, and reads the one value it produced.
//
// The cookie crosses process boundaries through a 0600 file rather than stdout,
// so it cannot end up in a shell log or a terminal scrollback.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from '../../config/constants.js';
import { CineError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { MEMBER_COOKIE_NAME } from './member-session.js';

/** Where the person signs in. */
export const SIGN_IN_URL = 'https://multiplex.cinecolombia.com/sign-in';

/** Long enough to find a password and solve a reCAPTCHA without rushing. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const HELPER_PATH = 'scripts/capture-session.mjs';
const RESULT_FILE = '.session-capture.json';

/**
 * Browser profile for logins, kept between runs.
 *
 * Reusing a profile is not just a convenience: bot protection treats a browser
 * with history as far less suspicious than a pristine one, so the second login
 * is challenged less than the first.
 */
const PROFILE_DIR = 'chrome-profile';

/** Exit codes of the helper script. Must stay in sync with it. */
export const CAPTURE_EXIT = {
  ok: 0,
  usage: 2,
  playwrightMissing: 3,
  timeout: 4,
  browserClosed: 5,
  launchFailed: 6,
} as const;

export interface CapturedCookie {
  cookie: string;
  expiresAt: number | null;
}

/**
 * Turn a helper exit code into an error the person can act on.
 *
 * Pure, so every branch is testable without launching a browser.
 */
export function describeCaptureFailure(code: number | null): CineError {
  switch (code) {
    case CAPTURE_EXIT.playwrightMissing:
      return new CineError(
        'PLAYWRIGHT_MISSING',
        'Para iniciar sesión hace falta Playwright. Instálalo con "bun add playwright" y vuelve a intentar.'
      );
    case CAPTURE_EXIT.timeout:
      return new CineError(
        'LOGIN_TIMEOUT',
        // Derived from the constant so the number quoted here cannot drift away
        // from the budget the helper was actually given.
        `No se detectó una sesión en ${Math.round(LOGIN_TIMEOUT_MS / 60000)} minutos. Vuelve a intentar con "cine login".`
      );
    case CAPTURE_EXIT.browserClosed:
      return new CineError(
        'LOGIN_CANCELLED',
        'Cerraste el navegador antes de iniciar sesión. Vuelve a intentar con "cine login".'
      );
    case CAPTURE_EXIT.launchFailed:
      return new CineError(
        'LOGIN_BROWSER_FAILED',
        'No se pudo abrir el navegador. Verifica que Chrome esté instalado y vuelve a intentar.'
      );
    case CAPTURE_EXIT.usage:
      return new CineError(
        'LOGIN_HELPER_USAGE',
        'Error interno al invocar el navegador. Reporta este fallo si persiste.'
      );
    default:
      return new CineError(
        'LOGIN_FAILED',
        `El navegador terminó de forma inesperada (código ${code ?? 'desconocido'}). Vuelve a intentar con "cine login".`
      );
  }
}

/** Read and validate what the helper wrote. Pure given the file contents. */
export function parseCaptureResult(contents: string): CapturedCookie {
  let parsed: Partial<CapturedCookie>;
  try {
    parsed = JSON.parse(contents) as Partial<CapturedCookie>;
  } catch {
    throw new CineError('LOGIN_RESULT_UNREADABLE', 'No se pudo leer la sesión capturada.');
  }

  if (typeof parsed.cookie !== 'string' || !parsed.cookie) {
    throw new CineError('LOGIN_RESULT_EMPTY', 'El navegador no devolvió una sesión válida.');
  }

  return {
    cookie: parsed.cookie,
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
  };
}

/**
 * Open a browser, wait for the person to sign in, and return the cookie.
 *
 * Their password never reaches this process.
 */
export async function captureMemberCookie(
  options: { timeoutMs?: number; cacheDir?: string } = {}
): Promise<CapturedCookie> {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const resultPath = join(cacheDir, RESULT_FILE);
  const profilePath = join(cacheDir, PROFILE_DIR);

  if (!existsSync(HELPER_PATH)) {
    throw new CineError(
      'LOGIN_HELPER_MISSING',
      `No se encontró ${HELPER_PATH}. Reinstala la CLI para restaurarlo.`
    );
  }

  mkdirSync(cacheDir, { recursive: true });
  // A stale file from a previous run must never be mistaken for a fresh capture.
  rmSync(resultPath, { force: true });

  const code = await runHelper([
    HELPER_PATH,
    '--out',
    resultPath,
    '--url',
    SIGN_IN_URL,
    '--cookie',
    MEMBER_COOKIE_NAME,
    '--profile',
    profilePath,
    '--timeout',
    String(options.timeoutMs ?? LOGIN_TIMEOUT_MS),
  ]);

  try {
    if (code !== CAPTURE_EXIT.ok) throw describeCaptureFailure(code);
    if (!existsSync(resultPath)) {
      throw new CineError('LOGIN_RESULT_MISSING', 'El navegador no devolvió ninguna sesión.');
    }
    return parseCaptureResult(readFileSync(resultPath, 'utf-8'));
  } finally {
    // The cookie lives in the session store from here on; this hand-off file is
    // a credential with no further purpose.
    rmSync(resultPath, { force: true });
  }
}

/** Spawn the Node helper, letting its progress text reach the terminal. */
function runHelper(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, {
      // stdin is unused; stdout/stderr are progress text the person should see.
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    child.on('error', (error) => {
      logger.debug('No se pudo ejecutar node:', error);
      reject(
        new CineError(
          'NODE_MISSING',
          'Para iniciar sesión hace falta Node.js instalado y disponible en el PATH.'
        )
      );
    });

    child.on('close', (code) => resolve(code));
  });
}
