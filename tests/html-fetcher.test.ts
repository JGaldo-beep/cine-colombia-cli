import { describe, expect, it } from 'bun:test';
import { BROWSER_HEADERS } from '../src/config/constants.js';
import { buildCurlArgs } from '../src/services/auth/html-fetcher.js';

/** Read the value curl would send for a given header name, preserving its case. */
function headerArg(args: string[], name: string): string | undefined {
  const prefix = `${name}: `;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

describe('buildCurlArgs', () => {
  it('pins HTTP/1.1', () => {
    // Load-bearing. HTTP/2 mandates lowercase field names (RFC 9113 §8.2.1), so
    // negotiating h2 rewrites `User-Agent` to `user-agent` and Cloudflare answers
    // with a challenge. Measured live, same host and headers, minutes apart:
    // --http1.1 -> 200 + token, --http2 -> 403.
    expect(buildCurlArgs('https://example.com')).toContain('--http1.1');
  });

  it('never asks for HTTP/2', () => {
    const args = buildCurlArgs('https://example.com');
    for (const forbidden of ['--http2', '--http2-prior-knowledge', '--http3']) {
      expect(args).not.toContain(forbidden);
    }
  });

  it('sends User-Agent title-cased, not lowercased', () => {
    // `user-agent` in lowercase is challenged; the capitalisation is the rule.
    const args = buildCurlArgs('https://example.com');
    expect(headerArg(args, 'User-Agent')).toBe(BROWSER_HEADERS['User-Agent']);
    expect(headerArg(args, 'user-agent')).toBeUndefined();
  });

  it('sends every configured browser header verbatim', () => {
    const args = buildCurlArgs('https://example.com');
    for (const [name, value] of Object.entries(BROWSER_HEADERS)) {
      expect(headerArg(args, name)).toBe(value);
    }
  });

  it('puts the url last so it is never parsed as a flag argument', () => {
    const args = buildCurlArgs('https://www.cinecolombia.com/');
    expect(args[args.length - 1]).toBe('https://www.cinecolombia.com/');
  });

  it('derives the timeout in whole seconds', () => {
    const args = buildCurlArgs('https://example.com');
    const value = args[args.indexOf('--max-time') + 1];
    expect(Number.isInteger(Number(value))).toBe(true);
    expect(Number(value)).toBeGreaterThan(0);
  });
});
