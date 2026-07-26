// HTML retrieval strategies for the Cloudflare-protected token page.
//
// Cloudflare here discriminates on the raw HTTP/1.1 header names: `User-Agent`
// gets through, `user-agent` gets a 403 challenge. Two consequences, both
// measured against the live site rather than reasoned about:
//
//  1. The request must be HTTP/1.1. HTTP/2 mandates lowercase field names
//     (RFC 9113 §8.2.1), so h2 rewrites `User-Agent` to `user-agent` and trips
//     the very rule these headers exist to satisfy. `buildCurlArgs` pins
//     `--http1.1` for that reason; without it the outcome depends on whether the
//     local curl happens to negotiate h2 via ALPN.
//
//  2. `fetch` is challenged here regardless of headers — but *not* because of
//     casing. Undici transmits the header name as supplied (verified by
//     capturing the raw request bytes), so `User-Agent` does survive. What fails
//     is below the header layer: the TLS fingerprint. Every header combination
//     tried returned 403 under both Node and Bun, including the exact set curl
//     succeeds with. A curl subprocess is load-bearing, not merely convenient,
//     which is why curl leads the order.
//
// `fetch` is kept as a fallback purely for environments without curl, and for the
// day Cloudflare's configuration changes.
//
// See `BROWSER_HEADERS` for the exact rules, including which headers must *not*
// be sent.

import { spawn } from 'node:child_process';
import { BROWSER_HEADERS, DEFAULTS } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

export interface FetchResult {
  status: number;
  body: string;
  /** Which strategy produced this result, for diagnostics. */
  via: StrategyName;
}

export type StrategyName = 'fetch' | 'curl';

/** Decides whether a result is good enough to stop trying further strategies. */
export type ResultValidator = (result: Omit<FetchResult, 'via'>) => boolean;

const DEFAULT_ORDER: StrategyName[] = ['curl', 'fetch'];

/**
 * Fetch a URL, trying each strategy until one returns an acceptable result.
 *
 * @param isAcceptable Returns true when the response actually contains what we
 *   need. Cloudflare answers challenges with HTTP 403 *and* HTTP 200 bodies, so
 *   status alone is not a reliable signal.
 * @throws The last result is returned rather than thrown; callers inspect it.
 */
export async function fetchHtml(
  url: string,
  isAcceptable: ResultValidator,
  order: StrategyName[] = resolveOrder()
): Promise<FetchResult> {
  let last: FetchResult | null = null;

  for (const name of order) {
    const strategy = STRATEGIES[name];
    if (!(await strategy.isAvailable())) {
      logger.debug(`Estrategia "${name}" no disponible, se omite`);
      continue;
    }

    try {
      const result = await strategy.run(url);
      logger.debug(`Estrategia "${name}": HTTP ${result.status}, ${result.body.length} bytes`);
      last = { ...result, via: name };
      if (isAcceptable(result)) return last;
    } catch (error) {
      logger.debug(`Estrategia "${name}" falló:`, error);
    }
  }

  if (last) return last;
  throw new Error(`Ninguna estrategia de descarga pudo obtener ${url}`);
}

/** Allow overriding the order, e.g. `CINE_FETCH_STRATEGY=fetch`. */
function resolveOrder(): StrategyName[] {
  const override = process.env.CINE_FETCH_STRATEGY?.trim();
  if (!override) return DEFAULT_ORDER;

  const requested = override
    .split(',')
    .map((name) => name.trim())
    .filter((name): name is StrategyName => name === 'curl' || name === 'fetch');

  return requested.length > 0 ? requested : DEFAULT_ORDER;
}

interface Strategy {
  isAvailable(): Promise<boolean>;
  run(url: string): Promise<Omit<FetchResult, 'via'>>;
}

const STRATEGIES: Record<StrategyName, Strategy> = {
  /**
   * Subprocess curl. Preferred because its TLS fingerprint is currently accepted
   * by Cloudflare, and it ships with Windows 10+, macOS and most Linux distros.
   */
  curl: {
    isAvailable: async () => curlAvailable(),
    run: async (url) => {
      const { stdout } = await run('curl', buildCurlArgs(url));

      const index = stdout.lastIndexOf(STATUS_SENTINEL);
      if (index === -1) return { status: 0, body: stdout };

      return {
        status: Number.parseInt(stdout.slice(index + STATUS_SENTINEL.length).trim(), 10) || 0,
        body: stdout.slice(0, index),
      };
    },
  },

  /**
   * Runtime `fetch`. Zero cost and works on networks where Cloudflare is not
   * challenging, but its TLS fingerprint is frequently rejected by this site.
   */
  fetch: {
    isAvailable: async () => true,
    run: async (url) => {
      const response = await fetch(url, {
        headers: { ...BROWSER_HEADERS },
        signal: AbortSignal.timeout(DEFAULTS.timeout),
      });
      return { status: response.status, body: await response.text() };
    },
  },
};

const STATUS_SENTINEL = '__CINE_HTTP_STATUS__';

/**
 * Build the curl argument list for the token page.
 *
 * Exported so the invariants below can be asserted in a test rather than trusted.
 *
 * `--http1.1` is load-bearing and must not be removed. Cloudflare's rule keys on
 * the raw header name `User-Agent` being title-cased, but **HTTP/2 requires every
 * field name to be lowercase** (RFC 9113 §8.2.1), so the protocol itself rewrites
 * `User-Agent` to `user-agent` before it reaches the wire. Negotiating h2 trips
 * the rule these headers exist to satisfy.
 *
 * curl selects h2 via ALPN by default against Cloudflare whenever it is built
 * with nghttp2, which most current builds are. Measured against the live site,
 * same host, same IP, same headers, minutes apart:
 *
 *   curl --http1.1 ... -> 200 + token
 *   curl --http2   ... -> 403 challenge
 *   curl (default) ... -> negotiates h2 -> 403 challenge
 *
 * So without this flag the CLI works or fails purely on how the local curl was
 * compiled. See tests/html-fetcher.test.ts.
 */
export function buildCurlArgs(url: string): string[] {
  const headerArgs = Object.entries(BROWSER_HEADERS).flatMap(([key, value]) => [
    '-H',
    `${key}: ${value}`,
  ]);

  return [
    '--silent',
    '--location',
    '--compressed',
    // Pin HTTP/1.1: h2 would lowercase the header names and get us challenged.
    '--http1.1',
    '--max-time',
    String(Math.ceil(DEFAULTS.timeout / 1000)),
    ...headerArgs,
    // Emit the status code after the body so we can read both from stdout
    // without juggling temp files.
    '--write-out',
    `\n${STATUS_SENTINEL}%{http_code}`,
    url,
  ];
}

/**
 * Run a command and collect its output.
 *
 * Uses `node:child_process` rather than `Bun.spawn` on purpose: the published build
 * runs under plain Node, where `Bun` does not exist. With `Bun.spawn` the curl
 * strategy silently reported itself unavailable, only `fetch` was left, and every
 * request came back as a Cloudflare challenge — the CLI looked broken for anyone who
 * installed it instead of cloning it.
 */
function run(command: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // Draining stderr keeps the pipe from filling and stalling the child.
    child.stderr?.resume();

    child.on('error', () => resolve({ stdout: '', code: -1 }));
    child.on('close', (code: number | null) => resolve({ stdout, code: code ?? -1 }));
  });
}

let curlProbe: Promise<boolean> | null = null;

/** Probe once per process; the answer cannot change while we run. */
function curlAvailable(): Promise<boolean> {
  curlProbe ??= (async () => {
    try {
      const { code } = await run('curl', ['--version']);
      return code === 0;
    } catch {
      return false;
    }
  })();
  return curlProbe;
}
