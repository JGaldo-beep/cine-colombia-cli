import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheManager } from '../src/services/cache/cache-manager.js';

let dir: string;
let cache: CacheManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cine-cache-'));
  cache = new CacheManager(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Rewind an entry's timestamp to simulate the passage of time. */
function ageEntry(minutes: number): void {
  const file = readdirSync(dir).find((name) => name.endsWith('.cache.json'));
  if (!file) throw new Error('no se encontró ninguna entrada de caché');

  const path = join(dir, file);
  const entry = JSON.parse(readFileSync(path, 'utf-8'));
  entry.storedAt -= minutes * 60 * 1000;
  writeFileSync(path, JSON.stringify(entry));
}

describe('CacheManager', () => {
  it('returns undefined on a miss', () => {
    expect(cache.get('sites')).toBeUndefined();
  });

  it('round-trips a stored value', () => {
    cache.set('sites', [{ id: '6493' }]);
    expect(cache.get<Array<{ id: string }>>('sites')).toEqual([{ id: '6493' }]);
  });

  it('keeps entries with different keys separate', () => {
    cache.set('seatLayout', { seats: 1 }, '6461-1');
    cache.set('seatLayout', { seats: 2 }, '6461-2');
    expect(cache.get<{ seats: number }>('seatLayout', '6461-1')).toEqual({ seats: 1 });
    expect(cache.get<{ seats: number }>('seatLayout', '6461-2')).toEqual({ seats: 2 });
  });

  it('does not confuse a keyed entry with an unkeyed one', () => {
    cache.set('seatLayout', { seats: 1 }, 'abc');
    expect(cache.get('seatLayout')).toBeUndefined();
  });

  it('treats an entry past its TTL as a miss', () => {
    cache.set('showtimes', ['algo']);
    // Showtimes are configured with a 30 minute TTL.
    ageEntry(31);
    expect(cache.get('showtimes')).toBeUndefined();
  });

  it('still serves an entry within its TTL', () => {
    cache.set('showtimes', ['algo']);
    ageEntry(5);
    expect(cache.get<string[]>('showtimes')).toEqual(['algo']);
  });

  it('treats a corrupt file as a miss instead of throwing', () => {
    cache.set('films', ['x']);
    const file = readdirSync(dir).find((name) => name.endsWith('.cache.json'));
    writeFileSync(join(dir, file as string), 'esto no es json');
    expect(cache.get('films')).toBeUndefined();
  });

  it('sanitises keys so ids cannot escape the cache directory', () => {
    cache.set('seatLayout', { ok: true }, '../../evadido');
    // The value must still be retrievable under the same key...
    expect(cache.get<{ ok: boolean }>('seatLayout', '../../evadido')).toEqual({ ok: true });
    // ...and every file must live inside the cache directory.
    expect(readdirSync(dir).every((name) => name.endsWith('.cache.json'))).toBe(true);
    expect(existsSync(join(dir, '..', '..', 'evadido.cache.json'))).toBe(false);
  });

  describe('remember', () => {
    it('invokes the loader on a miss and caches the result', async () => {
      let calls = 0;
      const load = async () => {
        calls += 1;
        return ['fresco'];
      };

      expect(await cache.remember('films', load)).toEqual(['fresco']);
      expect(await cache.remember('films', load)).toEqual(['fresco']);
      expect(calls).toBe(1);
    });

    it('skips the cache but refreshes it when forced', async () => {
      await cache.remember('films', async () => ['viejo']);
      const result = await cache.remember('films', async () => ['nuevo'], { force: true });

      expect(result).toEqual(['nuevo']);
      // The forced result must replace what was stored, not just bypass it.
      expect(cache.get<string[]>('films')).toEqual(['nuevo']);
    });

    it('propagates loader failures rather than caching them', async () => {
      const boom = async () => {
        throw new Error('falló la red');
      };

      await expect(cache.remember('films', boom)).rejects.toThrow('falló la red');
      expect(cache.get('films')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes every cached kind when called without arguments', () => {
      cache.set('films', ['a']);
      cache.set('sites', ['b']);
      cache.clear();
      expect(cache.get('films')).toBeUndefined();
      expect(cache.get('sites')).toBeUndefined();
    });

    it('removes only the requested kind', () => {
      cache.set('films', ['a']);
      cache.set('sites', ['b']);
      cache.clear('films');
      expect(cache.get('films')).toBeUndefined();
      expect(cache.get<string[]>('sites')).toEqual(['b']);
    });

    it('leaves the auth token alone, since it is a credential and not cache', () => {
      cache.set('films', ['a']);
      const tokenPath = join(dir, '.auth-token.json');
      writeFileSync(tokenPath, JSON.stringify({ token: 'secreto' }));

      cache.clear();

      expect(existsSync(tokenPath)).toBe(true);
    });

    it('does nothing when the directory does not exist', () => {
      const missing = new CacheManager(join(dir, 'no-existe'));
      expect(() => missing.clear()).not.toThrow();
    });
  });
});
