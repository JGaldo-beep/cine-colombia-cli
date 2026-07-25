// `cine login` / `cine logout` / `cine cuenta` — account session management.
//
// Cine Colombia gates its login with reCAPTCHA, so the CLI cannot authenticate by
// posting credentials: that control exists precisely to stop it. What it can do is
// open a real browser, let the person sign in themselves, and keep the session
// cookie that results.
//
// The password never reaches this process. We read exactly one cookie once the
// browser reports it, and nothing else.

import pc from 'picocolors';
import { CineError } from '../lib/errors.js';
import { formatDateShort, formatMoney, formatTime } from '../lib/format.js';
import { logger } from '../lib/logger.js';
import { cineApi } from '../services/api/ocapi-client.js';
import { MEMBER_COOKIE_NAME, memberSession } from '../services/auth/member-session.js';

const SIGN_IN_URL = 'https://multiplex.cinecolombia.com/sign-in';
/** Long enough to find the password and solve a reCAPTCHA without rushing. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;

export interface LoginOptions {
  json?: boolean;
}

export async function login(options: LoginOptions = {}): Promise<void> {
  const chromium = await loadChromium();

  console.log(`\n${pc.bold('Iniciando sesión en Cine Colombia')}`);
  console.log(
    pc.dim(
      '  Se abrirá una ventana de Chrome. Inicia sesión ahí; tu contraseña nunca pasa por esta CLI.\n'
    )
  );

  // The system Chrome is used on purpose: the bundled Chromium gets flagged by the
  // site's bot protection, and a real profile passes reCAPTCHA like any visitor.
  const browser = await chromium
    .launch({ headless: false, channel: 'chrome' })
    .catch(async () => chromium.launch({ headless: false }));

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(SIGN_IN_URL);

    console.log(pc.dim('  Esperando a que completes el inicio de sesión...'));

    const cookie = await waitForMemberCookie(context);
    if (!cookie) {
      throw new CineError(
        'LOGIN_TIMEOUT',
        'No se detectó una sesión en 5 minutos. Vuelve a intentar con "cine login".'
      );
    }

    memberSession.save({
      cookie: cookie.value,
      capturedAt: new Date().toISOString(),
      // Playwright reports -1 for a session cookie that dies with the browser.
      expiresAt: cookie.expires && cookie.expires > 0 ? Math.round(cookie.expires * 1000) : null,
      email: null,
    });

    // Confirm the captured cookie really works before claiming success.
    const member = await cineApi.getMember();
    if (!member) {
      memberSession.clear();
      throw new CineError(
        'LOGIN_NOT_VERIFIED',
        'Se capturó una sesión pero la API no la aceptó. Vuelve a intentar con "cine login".'
      );
    }

    memberSession.save({
      cookie: cookie.value,
      capturedAt: new Date().toISOString(),
      expiresAt: cookie.expires && cookie.expires > 0 ? Math.round(cookie.expires * 1000) : null,
      email: member.email,
    });

    if (options.json) {
      console.log(JSON.stringify({ loggedIn: true, member }, null, 2));
      return;
    }

    console.log(`\n${pc.green('✓')} Sesión guardada para ${pc.bold(member.fullName)}`);
    if (member.email) console.log(pc.dim(`  ${member.email}`));
    console.log(pc.dim('\n  Ahora "cine comprar" usa tu cuenta y completa tus datos solo.\n'));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function logout(): void {
  const had = memberSession.clear();
  console.log(
    had
      ? `\n${pc.green('✓')} Sesión cerrada.\n`
      : `\n${pc.dim('No había ninguna sesión guardada.')}\n`
  );
}

export interface CuentaOptions {
  json?: boolean;
}

/** `cine cuenta` — who is signed in, and what tickets they hold. */
export async function cuenta(options: CuentaOptions = {}): Promise<void> {
  const member = await cineApi.getMember();

  if (!member) {
    if (options.json) {
      console.log(JSON.stringify({ loggedIn: false }, null, 2));
      return;
    }
    console.log(`\n${pc.yellow('No has iniciado sesión.')}`);
    console.log(pc.dim('  Ejecuta "cine login" para vincular tu cuenta.\n'));
    return;
  }

  const orders = await cineApi.getActiveOrders().catch(() => []);

  if (options.json) {
    console.log(JSON.stringify({ loggedIn: true, member, activeOrders: orders }, null, 2));
    return;
  }

  console.log(`\n${pc.bold(pc.cyan(member.fullName))}`);
  const facts: Array<[string, string]> = [
    ['Correo', member.email ?? '—'],
    ['Miembro', member.id],
    ['Desde', formatDateShort(member.memberSince)],
  ];
  if (member.clubLevelId !== null) facts.push(['Nivel', String(member.clubLevelId)]);

  const width = Math.max(...facts.map(([label]) => label.length));
  for (const [label, value] of facts) {
    console.log(`  ${pc.dim(label.padEnd(width))}  ${value}`);
  }

  console.log(`\n  ${pc.bold('Boletas activas')} ${pc.dim(`(${orders.length})`)}`);
  if (orders.length === 0) {
    console.log(pc.dim('    No tienes boletas sin usar.'));
  } else {
    for (const order of orders) {
      const when = order.startsAt ? formatTime(order.startsAt) : '—';
      console.log(
        `    ${pc.cyan(order.filmTitle ?? order.id)} ${pc.dim(`· ${order.theatreName ?? '—'} · ${when} · ${order.ticketCount} boleta(s) · ${formatMoney(order.total)}`)}`
      );
    }
  }
  console.log();
}

/** Wait for the browser to acquire the member cookie. */
async function waitForMemberCookie(context: {
  cookies: () => Promise<Array<{ name: string; value: string; expires?: number }>>;
}): Promise<{ value: string; expires?: number } | null> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const cookies = await context.cookies().catch(() => []);
    const found = cookies.find((cookie) => cookie.name === MEMBER_COOKIE_NAME && cookie.value);
    if (found) return { value: found.value, expires: found.expires };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return null;
}

/**
 * Load Playwright lazily.
 *
 * Only `cine login` needs a browser, so its absence must not break the rest of the
 * CLI, and the error has to say what to install.
 */
async function loadChromium() {
  try {
    const playwright = await import('playwright');
    return playwright.chromium;
  } catch (error) {
    logger.debug('Playwright no está disponible:', error);
    throw new CineError(
      'PLAYWRIGHT_MISSING',
      'Para iniciar sesión hace falta Playwright. Instálalo con "bun add playwright" y vuelve a intentar.'
    );
  }
}
