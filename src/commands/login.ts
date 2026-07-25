// `cine login` / `cine logout` / `cine cuenta` — account session management.
//
// Cine Colombia gates its login with reCAPTCHA, so the CLI cannot authenticate by
// posting credentials: that control exists precisely to stop it. What it can do is
// open a real browser, let the person sign in themselves, and keep the session
// cookie that results.
//
// The password never reaches this process. We read exactly one cookie once the
// browser reports it, and nothing else.
//
// The browser itself is driven by src/services/auth/session-capture.ts, which runs
// it in a Node subprocess; this file only decides what to do with the result.

import pc from 'picocolors';
import { CineError } from '../lib/errors.js';
import { formatDateShort, formatMoney, formatTime } from '../lib/format.js';
import { cineApi } from '../services/api/ocapi-client.js';
import { memberSession } from '../services/auth/member-session.js';
import { captureMemberCookie } from '../services/auth/session-capture.js';

export interface LoginOptions {
  json?: boolean;
}

export async function login(options: LoginOptions = {}): Promise<void> {
  console.log(`\n${pc.bold('Iniciando sesión en Cine Colombia')}`);
  console.log(
    pc.dim(
      '  Se abrirá una ventana de Chrome. Inicia sesión ahí; tu contraseña nunca pasa por esta CLI.\n'
    )
  );

  console.log(pc.dim('  Esperando a que completes el inicio de sesión...'));

  const captured = await captureMemberCookie();

  memberSession.save({
    cookie: captured.cookie,
    capturedAt: new Date().toISOString(),
    expiresAt: captured.expiresAt,
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
    cookie: captured.cookie,
    capturedAt: new Date().toISOString(),
    expiresAt: captured.expiresAt,
    email: member.email,
  });

  if (options.json) {
    console.log(JSON.stringify({ loggedIn: true, member }, null, 2));
    return;
  }

  console.log(`\n${pc.green('✓')} Sesión guardada para ${pc.bold(member.fullName)}`);
  if (member.email) console.log(pc.dim(`  ${member.email}`));
  console.log(pc.dim('\n  Ahora "cine comprar" usa tu cuenta y completa tus datos solo.\n'));
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
