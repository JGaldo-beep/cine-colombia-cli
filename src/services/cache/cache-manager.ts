// TTL-based disk cache for API responses.
//
// The CLI is invoked as one-shot commands, so an in-memory cache would never be
// reused. Persisting to disk is what makes `cine cartelera` feel instant on the
// second run. TTLs are per data kind: theatre lists are near-static, showtimes go
// stale quickly because sold-out state matters.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, CACHE_TTL } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

/** Data kinds with a configured TTL. */
export type CacheKind = keyof typeof CACHE_TTL;

interface CacheEntry<T> {
  data: T;
  /** Epoch milliseconds when this entry was written. */
  storedAt: number;
  /** Lifetime in milliseconds. */
  ttl: number;
}

export class CacheManager {
  constructor(private cacheDir: string = CACHE_DIR) {}

  /**
   * Return a cached value, or undefined when absent, expired or unreadable.
   *
   * A corrupt or unparseable file is treated as a miss rather than an error: the
   * cache is an optimisation and must never be able to break a command.
   */
  get<T>(kind: CacheKind, key?: string): T | undefined {
    const path = this.pathFor(kind, key);

    try {
      if (!existsSync(path)) return undefined;

      const entry = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry<T>;
      if (typeof entry?.storedAt !== 'number' || typeof entry?.ttl !== 'number') return undefined;

      const age = Date.now() - entry.storedAt;
      if (age > entry.ttl) {
        logger.debug(`Caché expirada: ${kind}${key ? `/${key}` : ''} (${Math.round(age / 1000)}s)`);
        return undefined;
      }

      logger.debug(`Caché usada: ${kind}${key ? `/${key}` : ''}`);
      return entry.data;
    } catch (error) {
      logger.debug(`Caché ilegible para ${kind}, se ignora:`, error);
      return undefined;
    }
  }

  /** Store a value under the TTL configured for its kind. */
  set<T>(kind: CacheKind, data: T, key?: string): void {
    const entry: CacheEntry<T> = {
      data,
      storedAt: Date.now(),
      ttl: CACHE_TTL[kind] * 60 * 1000,
    };

    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(this.pathFor(kind, key), JSON.stringify(entry));
    } catch (error) {
      // A read-only or full disk should degrade performance, not fail the command.
      logger.debug(`No se pudo escribir la caché de ${kind}:`, error);
    }
  }

  /**
   * Resolve from cache or compute and store.
   *
   * @param force Skip the read but still refresh the stored value, which is what
   *   a `--no-cache` style flag needs.
   */
  async remember<T>(
    kind: CacheKind,
    loader: () => Promise<T>,
    options: { key?: string; force?: boolean } = {}
  ): Promise<T> {
    if (!options.force) {
      const hit = this.get<T>(kind, options.key);
      if (hit !== undefined) return hit;
    }

    const fresh = await loader();
    this.set(kind, fresh, options.key);
    return fresh;
  }

  /** Delete cached data. Leaves the auth token alone; that is not cache. */
  clear(kind?: CacheKind): void {
    try {
      if (!existsSync(this.cacheDir)) return;

      for (const file of readdirSync(this.cacheDir)) {
        if (!file.endsWith('.cache.json')) continue;
        if (kind && !file.startsWith(`${kind}`)) continue;
        unlinkSync(join(this.cacheDir, file));
      }
    } catch (error) {
      logger.debug('No se pudo limpiar la caché:', error);
    }
  }

  /**
   * Build a filesystem-safe path for an entry.
   *
   * Keys come from API ids that can contain characters the filesystem dislikes,
   * so anything outside a conservative set is replaced.
   */
  private pathFor(kind: CacheKind, key?: string): string {
    const suffix = key ? `-${key.replace(/[^a-zA-Z0-9._-]/g, '_')}` : '';
    return join(this.cacheDir, `${kind}${suffix}.cache.json`);
  }
}

export const cache = new CacheManager();
