type DiscoveryMetadata = { readonly id: string; readonly [k: string]: unknown };
type CacheEntry =
  | { readonly valid: true; readonly value: DiscoveryMetadata; readonly expiresAt: number }
  | { readonly valid: false; readonly expiresAt: number };
export type DiscoveryMetadataLoader = (
  seedIDs: readonly string[],
  knownIDs: ReadonlySet<string>,
  shouldContinue?: () => boolean,
) => Promise<Map<string, Record<string, unknown>>>;

const BATCH = 8;
const MAX_REMOTE = 32;
const MAX_EXAMINED = 512;
const TTL_MS = 60_000;
const CACHE_CAP = 512;
const SES_PREFIX = "ses_";

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createDiscoveryMetadataLoader(
  readCached: (id: string) => unknown,
  readRemote: (id: string) => Promise<unknown>,
  now: () => number = Date.now,
): DiscoveryMetadataLoader {
  const cache = new Map<string, CacheEntry>();
  const lookup = (id: string): CacheEntry | undefined => {
    const e = cache.get(id);
    if (!e) return undefined;
    if (e.expiresAt <= now()) {
      cache.delete(id);
      return undefined;
    }
    return e;
  };
  const put = (id: string, value: DiscoveryMetadata | undefined): void => {
    const expiresAt = now() + TTL_MS;
    cache.set(id, value === undefined ? { valid: false, expiresAt } : { valid: true, value, expiresAt });
    if (cache.size > CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };
  const matches = (v: unknown, id: string): v is DiscoveryMetadata =>
    isPlainRecord(v) && v.id === id;

  return async (seedIDs, knownIDs, shouldContinue = () => true) => {
    const result = new Map<string, Record<string, unknown>>();
    const queued = new Set<string>();
    const queue: string[] = [];
    for (const seed of seedIDs) {
      if (!seed.startsWith(SES_PREFIX)) continue;
      if (knownIDs.has(seed) || queued.has(seed)) continue;
      queued.add(seed);
      queue.push(seed);
    }

    let remote = 0;
    let cursor = 0;

    while (cursor < queue.length && cursor < MAX_EXAMINED) {
      if (!shouldContinue()) break;
      const batch = queue.slice(cursor, Math.min(cursor + BATCH, MAX_EXAMINED));
      cursor += batch.length;
      const fetched = await Promise.all(
        batch.map(async (id) => {
          let value: unknown;
          try {
            value = readCached(id);
          } catch {
            value = undefined;
          }
          if (matches(value, id)) {
            put(id, value);
            return value;
          }
          const c = lookup(id);
          if (c) return c.valid ? c.value : undefined;
          if (remote >= MAX_REMOTE) return undefined;
          remote++;
          try {
            value = await readRemote(id);
          } catch {
            value = undefined;
          }
          if (matches(value, id)) {
            put(id, value);
            return value;
          }
          put(id, undefined);
          return undefined;
        }),
      );
      for (const record of fetched) {
        if (!record) continue;
        result.set(record.id, record);
        const parent = record.parentID;
        if (typeof parent !== "string" || !parent.startsWith(SES_PREFIX)) continue;
        if (knownIDs.has(parent) || queued.has(parent)) continue;
        queued.add(parent);
        queue.push(parent);
      }
      if (!shouldContinue()) break;
    }
    return result;
  };
}
