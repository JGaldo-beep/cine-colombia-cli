import { describe, expect, it } from 'bun:test';
import { readJwtExpiry } from '../src/services/auth/token-provider.js';

/** Build a token whose payload decodes to the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      // JWTs use base64url and strip padding.
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.firma-irrelevante`;
}

describe('readJwtExpiry', () => {
  it('converts the exp claim from seconds to milliseconds', () => {
    // The signature is never verified: we only need exp to schedule a refresh.
    expect(readJwtExpiry(makeJwt({ exp: 1784978364 }))).toBe(1784978364 * 1000);
  });

  it('decodes payloads that need base64url padding restored', () => {
    // Vary the claim length so the payload lands on each padding remainder.
    for (const subject of ['a', 'ab', 'abc', 'abcd']) {
      expect(readJwtExpiry(makeJwt({ sub: subject, exp: 1700000000 }))).toBe(1700000000 * 1000);
    }
  });

  it('handles the base64url alphabet', () => {
    // "?>?>" encodes to bytes that produce both '-' and '_' in base64url.
    const token = makeJwt({ sub: '???>>>???', exp: 1700000000 });
    expect(readJwtExpiry(token)).toBe(1700000000 * 1000);
  });

  it('returns null when exp is absent', () => {
    expect(readJwtExpiry(makeJwt({ sub: 'sin-exp' }))).toBeNull();
  });

  it('returns null when exp is not a number', () => {
    expect(readJwtExpiry(makeJwt({ exp: 'pronto' }))).toBeNull();
  });

  it('returns null for values that are not JWTs', () => {
    expect(readJwtExpiry('')).toBeNull();
    expect(readJwtExpiry('no-es-un-jwt')).toBeNull();
    expect(readJwtExpiry('a.b')).toBeNull();
    expect(readJwtExpiry('cabecera.{no-es-base64}.firma')).toBeNull();
  });
});
