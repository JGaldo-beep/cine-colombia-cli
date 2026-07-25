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
import { formatDateShort, formatMoney, formatTime, formatTimeRemaining } from '../lib/format.js';
import { cineApi } from '../services/api/ocapi-client.js';
import { memberSession, sessionNotice } from '../services/auth/member-session.js';
import { captureMemberCookie, clearLoginProfile } from '../services/auth/session-capture.js';

export interface LoginOptions {
  json?: boolean;
  /** Keep the session alive beyond 30 minutes. On by default; see below. */
  recordar?: boolean;
}

export async function login(options: LoginOptions = {}): Promise<void> {
  console.log(`\n${pc.bold('Iniciando sesión en Cine Colombia')}`);
  console.log(
    pc.dim(
      '  Se abrirá una ventana de Chrome. Inicia sesión ahí; tu contraseña nunca pasa por esta CLI.\n'
    )
  );

  console.log(pc.dim('  Esperando a que completes el inicio de sesión...'));

  // Persistence is the default because the alternative is a 30-minute session,
  // which expires mid-task. `--no-recordar` exists for a shared machine, where a
  // long-lived cookie on disk is the bigger risk.
  const captured = await captureMemberCookie({ remember: options.recordar ?? true });

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
  // Chrome persists the same session cookie in the login profile, so dropping only
  // the CLI's copy would leave a usable credential on disk.
  const hadProfile = clearLoginProfile();

  console.log(
    had || hadProfile
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
    // A cookie that is still within its expiry but rejected by the API was
    // revoked server-side; that is neither "expired" nor "never signed in".
    const status = memberSession.status() === 'active' ? 'expired' : memberSession.status();
    const notice = sessionNotice(status);

    if (options.json) {
      console.log(JSON.stringify({ loggedIn: false, reason: status }, null, 2));
      return;
    }
    console.log(`\n${pc.yellow(notice.title)}`);
    console.log(pc.dim(`  ${notice.hint}\n`));
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
  // Surfaced so a short session is visible before it bites, rather than after.
  facts.push(['Sesión', `vence ${formatTimeRemaining(memberSession.timeToExpiry())}`]);

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
