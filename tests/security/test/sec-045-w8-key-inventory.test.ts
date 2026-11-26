/**
 * SEC-045 criterion 5 (lane w8, 2026-11-26): the keys of every cache, counter and stream, listed.
 *
 * What the test shows, and what it does not. It lists the keys the product builds and checks, for
 * each kind, whether the tenant is in the key:
 *
 * - the tenant and user rate counters, which go to the shared store (Redis or Valkey in stage 2):
 *   recorded through a `RateStore` that logs every key; each holds the tenant;
 * - the idempotency records (tenant first in the scope), and the pinned read cache (the tenant in the
 *   key): the same request of another tenant is another record and another entry;
 * - the address counters (`c:{address}`, `f:{address}`): they run before a token is verified, so
 *   they cannot hold a tenant. They are never sent to the shared store (the recording store sees
 *   none), and they are kept in the node's memory;
 * - the bus topics: found by scanning the source for every `publish` and `subscribe` call. They are
 *   `node:{node}` (one inbox per node, ADR 0393) and `announce`. Neither holds a tenant. The frames
 *   they carry name the document.
 *
 * The last two kinds do not meet the criterion as it is worded ("each includes the tenant"). They
 * are listed here and pinned: a new key of either kind fails the test until it is classified. Whether
 * they are an accepted exception or the keys must change is a decision for the owner, proposed in
 * docs/adr/0428-w8-SEC-045-key-inventory.md. Search entries are tables with `tenant_id` and forced
 * row-level security (the catalogue check of BE-011, services/document-service/test/postgres).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MemoryRateStore,
  RateLimits,
  type RateStore,
} from '../../../services/document-service/src/data-plane/limits.ts';
import { DEFAULT_RATES } from '../../../services/document-service/src/data-plane/settings.ts';
import { MemoryIdempotencyStore } from '../../../services/document-service/src/control-plane/idempotency.ts';
import { pinnedKey } from '../../../services/document-service/src/control-plane/pinned-cache.ts';

const A = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c51';
const B = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c52';
const DOC = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c53';

describe('SEC-045 criterion 5: the keys of caches, counters and streams', () => {
  it('every key of the shared rate store holds the tenant, and the address counters never reach it', async () => {
    const taken: string[] = [];
    const inner = new MemoryRateStore();
    const store: RateStore = {
      take(key, s, now, n) {
        taken.push(key);
        return inner.take(key, s, now, n);
      },
    };
    const limits = new RateLimits(DEFAULT_RATES, { store });
    const now = Date.now();
    for (const tenant of [A, B]) {
      await limits.message(tenant, 'user-1', now);
      await limits.rest(tenant, 'user-2', now);
    }
    limits.connection('203.0.113.7', now);
    limits.frame('203.0.113.7', now);

    expect(taken.length).toBeGreaterThanOrEqual(8);
    for (const key of taken)
      expect(key.includes(A) || key.includes(B), `rate key ${JSON.stringify(key)}`).toBe(true);
    // The same user name in two tenants is two counters.
    expect(new Set(taken.filter((k) => k.startsWith('u:'))).size).toBe(4);
    // The address counters are the node's own and are not in the shared store.
    expect(
      taken.some((k) => k.startsWith('c:') || k.startsWith('f:') || k.includes('203.0.113.7')),
    ).toBe(false);
  });

  it('an idempotency key of one tenant is not found by another tenant that sends the same key', async () => {
    const store = new MemoryIdempotencyStore();
    const now = Date.now();
    const scope = (tenant: string) => ({
      tenant,
      principal: 'p',
      route: 'createDocument',
      key: 'k1',
    });
    expect((await store.claim(scope(A), 'f', now, 60_000, 30_000)).claimed).toBe(true);
    expect((await store.claim(scope(B), 'f', now, 60_000, 30_000)).claimed).toBe(true);
    expect(store.size).toBe(2);
    expect(await store.read({ ...scope(B), key: 'other' }, now)).toBeNull();
    expect(await store.purge(A, now + 120_000)).toBe(1);
    expect(store.size).toBe(1);
  });

  it('the pinned read cache keys a request by its tenant', () => {
    const req = (tenant: string) => ({
      resource: { kind: 'content' as const, doc: { tenant, doc: DOC }, seq: 3 },
      visibilityClass: 'full',
      restricted: false,
      reader: 'reader',
    });
    const ka = pinnedKey(req(A));
    const kb = pinnedKey(req(B));
    expect(ka).toContain(A);
    expect(kb).toContain(B);
    expect(ka).not.toBe(kb);
    const asset = (tenant: string) => ({
      resource: { kind: 'asset' as const, tenant, hash: 'a'.repeat(64) },
      visibilityClass: 'full',
      restricted: false,
      reader: 'reader',
    });
    expect(pinnedKey(asset(A))).not.toBe(pinnedKey(asset(B)));
    expect(pinnedKey(asset(A))).toContain(A);
  });

  it('the bus has exactly two topics, and neither is keyed by tenant (pinned; an owner decision is pending)', () => {
    const src = join(import.meta.dirname, '../../../services/document-service/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(src);
    const topics = new Set<string>();
    for (const file of files) {
      // The bus implementations declare the methods; the callers pass a topic.
      if (/data-plane\/(bus|valkey-bus)\.ts$/.test(file.replaceAll('\\', '/'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bbus\.(?:publish|subscribe)\(\s*([^,]+),/g))
        topics.add(`${relative(src, file).replaceAll('\\', '/')}: ${m[1]!.trim()}`);
    }
    expect([...topics].sort()).toEqual([
      'data-plane/announcements.ts: TOPIC',
      'data-plane/forwarding.ts: `node:${chan.peer}`',
      'data-plane/forwarding.ts: `node:${this.#d.node}`',
    ]);
  });
});
