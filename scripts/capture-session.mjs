// Opens a real browser so a person can sign in, then reports the session cookie.
//
// Why this is a separate Node script instead of part of the CLI:
//
//   Playwright's `launch()` never returns under Bun on Windows. Playwright spawns
//   its driver and speaks to it over stdio pipes, and Bun's Windows child_process
//   implementation does not complete that handshake — the promise simply hangs, no
//   error, no browser window. Measured on Bun 1.3.3 / Playwright 1.40 / Windows:
//
//     bun  tmp.ts  -> hangs indefinitely at chromium.launch()
//     node tmp.mjs -> launches Chrome 150 and closes cleanly
//
//   So the browser step runs in Node and the result crosses back as a file. Node
//   is already implied by having Playwright installed at all.
//
// The password is never read by this script. It polls for exactly one cookie and
// writes only that. The value is never printed: stdout/stderr carry progress text
// only, because those streams end up in the user's terminal and in logs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tickRememberMe } from './remember-me.mjs';

/** Exit codes, mirrored by src/services/auth/session-capture.ts. */
const EXIT = {
  ok: 0,
  usage: 2,
  playwrightMissing: 3,
  timeout: 4,
  browserClosed: 5,
  launchFailed: 6,
};

const args = parseArgs(process.argv.slice(2));
if (!args.out || !args.url || !args.cookie) {
  process.stderr.write('uso: capture-session.mjs --out <file> --url <url> --cookie <name>\n');
  process.exit(EXIT.usage);
}

const timeoutMs = Number(args.timeout ?? 5 * 60 * 1000);
const pollMs = 1000;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  process.exit(EXIT.playwrightMissing);
}

// A persistent profile matters beyond convenience: Cloudflare and reCAPTCHA both
// weigh browser history, and a profile that has been used before is challenged
// far less than a pristine one. `channel: 'chrome'` uses the installed Chrome
// rather than Playwright's bundled Chromium, which bot protection flags.
if (args.profile) mkdirSync(args.profile, { recursive: true });

let context;
try {
  context = await chromium.launchPersistentContext(args.profile, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
} catch (error) {
  // Fall back to bundled Chromium: worse odds against bot protection, but a
  // machine without Chrome should still get a shot at signing in.
  try {
    context = await chromium.launchPersistentContext(args.profile, {
      headless: false,
      viewport: null,
    });
  } catch {
    process.stderr.write(`No se pudo abrir el navegador: ${describe(error)}\n`);
    process.exit(EXIT.launchFailed);
  }
}

// If the person closes the window, stop waiting instead of stalling for minutes.
let closed = false;
context.on('close', () => {
  closed = true;
});

// Never call process.exit() before the context is closed. process.exit() does not
// unwind, so a `finally` would be skipped, and Chrome would die without flushing
// its cookie jar to the profile — the captured login would be lost for the next
// run. Decide the code, close, then exit.
let exitCode = EXIT.ok;

try {
  // Start from a signed-out browser on purpose.
  //
  // The profile persists the session cookie, so without this the sign-in page
  // would open already authenticated: the form would never appear, "Mantenerme
  // registrado" could not be ticked, and the run would silently re-adopt the old
  // cookie — including a short-lived one, forever. Clearing also means a person
  // can sign in as somebody else.
  if (args.fresh !== 'false') await context.clearCookies().catch(() => undefined);

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(args.url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

  if (args.remember !== 'false') {
    await tickRememberMe(page, { log: (text) => process.stderr.write(text) });
  }

  const found = await waitForCookie(context, args.cookie, timeoutMs);

  if (found) {
    mkdirSync(dirname(args.out), { recursive: true });
    // 0600: this cookie is enough to act as the account holder.
    writeFileSync(
      args.out,
      JSON.stringify({
        cookie: found.value,
        // Playwright reports -1 for a cookie that dies with the browser.
        expiresAt: found.expires && found.expires > 0 ? Math.round(found.expires * 1000) : null,
      }),
      { mode: 0o600 }
    );
  } else {
    exitCode = closed ? EXIT.browserClosed : EXIT.timeout;
  }
} finally {
  await context.close().catch(() => undefined);
}

process.exit(exitCode);

async function waitForCookie(ctx, name, budgetMs) {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    if (closed) return null;
    const cookies = await ctx.cookies().catch(() => []);
    const hit = cookies.find((c) => c.name === name && c.value);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key) out[key] = argv[i + 1];
  }
  return out;
}

function describe(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0];
}
