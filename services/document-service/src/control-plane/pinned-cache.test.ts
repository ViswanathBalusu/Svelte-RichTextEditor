// Version-pinned content and assets cached near the reader (BE-075; ADR 0019 SR-C4). The cache is
// the subject; the home region, the permission check and the switch are stubs the test controls.
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  NotCacheable,
  PinnedCache,
  type PinnedRequest,
  type PinnedResource,
  pinnedKey,
} from './pinned-cache.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** A home region that counts its reads and returns bytes derived from the request. */
function home(overrides: { missing?: boolean } = {}) {
  const reads: PinnedRequest[] = [];
  const bytesOf = (req: PinnedRequest) => new TextEncoder().encode(pinnedKey(req));
  return {
    reads,
    fromHome: async (req: PinnedRequest) => {
      reads.push(req);
      return overrides.missing ? null : bytesOf(req);
    },
    bytesOf,
  };
}

/** A cache wired to stubs: a switch per tenant, and an allow list the test changes. */
function rig(opts: { missing?: boolean } = {}) {
  const h = home(opts);
  const enabled = new Set<string>();
  const allowed = { value: true };
  const cache = new PinnedCache({
    cachingEnabled: (t) => enabled.has(t),
    authorise: async () => allowed.value,
    fromHome: h.fromHome,
  });
  return { cache, h, enabled, allowed };
}

const content = (tenant: string, doc: string, seq: number, cls = 'full'): PinnedRequest => ({
  resource: { kind: 'content', doc: { tenant, doc }, seq },
  visibilityClass: cls,
  restricted: false,
  reader: 'reader-1',
});

const asset = (tenant: string, hash: string, cls = 'full'): PinnedRequest => ({
  resource: { kind: 'asset', tenant, hash },
  visibilityClass: cls,
  restricted: false,
  reader: 'reader-1',
});

describe('immutable resources only (BE-075 criterion 2)', () => {
  it('builds a key only for content pinned to a sequence number or an asset addressed by hash', () => {
    expect(pinnedKey(content('t', 'd', 3))).toBe(pinnedKey(content('t', 'd', 3)));
    expect(pinnedKey(asset('t', HASH_A))).not.toBe(pinnedKey(asset('t', HASH_B)));
    const mutable = {
      resource: { kind: 'content', doc: { tenant: 't', doc: 'd' }, seq: Number.NaN },
      visibilityClass: 'full',
      restricted: false,
      reader: 'r',
    } as PinnedRequest;
    expect(() => pinnedKey(mutable)).toThrow(NotCacheable);
    const latest = {
      resource: { kind: 'content', doc: { tenant: 't', doc: 'd' }, seq: -1 },
      visibilityClass: 'full',
      restricted: false,
      reader: 'r',
    } as PinnedRequest;
    expect(() => pinnedKey(latest)).toThrow(NotCacheable);
    expect(() => pinnedKey(asset('t', 'not-a-hash'))).toThrow(NotCacheable);
    expect(() => pinnedKey({ ...content('t', 'd', 1), visibilityClass: '' })).toThrow(NotCacheable);
  });

  it('refuses a mutable read without reading anything', async () => {
    const { cache, h, enabled } = rig();
    enabled.add('t');
    const mutable = {
      resource: { kind: 'content', doc: { tenant: 't', doc: 'd' }, seq: 1.5 },
      visibilityClass: 'full',
      restricted: false,
      reader: 'r',
    } as PinnedRequest;
    await expect(cache.serve(mutable)).rejects.toThrow(NotCacheable);
    expect(h.reads).toHaveLength(0);
  });
});

describe('the cache key includes the tenant and the visibility class (BE-075 criterion 2)', () => {
  it('never shares a copy between two tenants that hold the same document identifier and sequence', async () => {
    const { cache, h, enabled } = rig();
    enabled.add('tenant-a');
    enabled.add('tenant-b');
    const doc = randomUUID();
    const a = await cache.serve(content('tenant-a', doc, 4));
    const b = await cache.serve(content('tenant-b', doc, 4));
    expect(a.status === 'served' && b.status === 'served' && a.from).toBe('home');
    expect(b.status === 'served' && b.from).toBe('home');
    expect(h.reads.map((r) => r.resource)).toHaveLength(2);
  });

  it('does not serve a copy made for one visibility class to another class', async () => {
    const { cache, h, enabled } = rig();
    enabled.add('t');
    await cache.serve(content('t', 'd', 2, 'class-x'));
    const other = await cache.serve(content('t', 'd', 2, 'class-y'));
    expect(other.status === 'served' && other.from).toBe('home');
    expect(h.reads).toHaveLength(2);
    const again = await cache.serve(content('t', 'd', 2, 'class-x'));
    expect(again.status === 'served' && again.from).toBe('cache');
    expect(h.reads).toHaveLength(2);
  });
});

describe('the permission check runs before a copy is served (BE-075 criterion 3)', () => {
  it('refuses a cached copy once the reader is no longer allowed, without asking the home region', async () => {
    const { cache, h, enabled, allowed } = rig();
    enabled.add('t');
    const first = await cache.serve(content('t', 'd', 1));
    expect(first.status === 'served' && first.from).toBe('home');
    allowed.value = false;
    const second = await cache.serve(content('t', 'd', 1));
    expect(second).toEqual({ status: 'refused' });
    expect(h.reads).toHaveLength(1);
    expect(cache.stats.refused).toBe(1);
  });
});

describe('restricted documents and the switch (BE-075 criterion 4; SR-C4)', () => {
  it('never stores or reads a document with hidden scopes at a shared edge', async () => {
    const { cache, h, enabled } = rig();
    enabled.add('t');
    const restricted = { ...content('t', 'd', 1), restricted: true };
    await cache.serve(restricted);
    await cache.serve(restricted);
    expect(cache.entries('t')).toBe(0);
    expect(h.reads).toHaveLength(2);
  });

  it('sends every request to the home region and stores nothing while caching is off', async () => {
    const { cache, h } = rig();
    await cache.serve(asset('t', HASH_A));
    await cache.serve(asset('t', HASH_A));
    expect(h.reads).toHaveLength(2);
    expect(cache.entries('t')).toBe(0);
  });

  it('drops the tenant copies when the switch is turned off', async () => {
    const { cache, h, enabled } = rig();
    enabled.add('t');
    await cache.serve(asset('t', HASH_A));
    expect(cache.entries('t')).toBe(1);
    enabled.delete('t');
    await cache.serve(asset('t', HASH_A));
    expect(cache.entries('t')).toBe(0);
    expect(h.reads).toHaveLength(2);
    enabled.add('t');
    const back = await cache.serve(asset('t', HASH_A));
    expect(back.status === 'served' && back.from).toBe('home');
    expect(h.reads).toHaveLength(3);
  });

  it('reports a missing resource as not found and stores nothing for it', async () => {
    const { cache, enabled } = rig({ missing: true });
    enabled.add('t');
    expect(await cache.serve(asset('t', HASH_A))).toEqual({ status: 'not-found' });
    expect(cache.entries('t')).toBe(0);
  });
});

describe('a copy answers as the home region would (BE-075 criterion 1; property)', () => {
  const tenantArb = fc.constantFrom('t1', 't2');
  const docArb = fc.constantFrom('d1', 'd2');
  const clsArb = fc.constantFrom('full', 'hidden-a');
  const opArb = fc.record({
    tenant: tenantArb,
    doc: docArb,
    seq: fc.integer({ min: 0, max: 3 }),
    cls: clsArb,
    restricted: fc.boolean(),
    allowed: fc.boolean(),
    enabled: fc.boolean(),
  });

  it('serves, refuses or reads only what the rules allow, and every served body is the home body', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const h = home();
        let allowed = true;
        let enabled = false;
        const cache = new PinnedCache({
          cachingEnabled: () => enabled,
          authorise: async () => allowed,
          fromHome: h.fromHome,
        });
        for (const op of ops) {
          allowed = op.allowed;
          enabled = op.enabled;
          const req: PinnedRequest = {
            resource: { kind: 'content', doc: { tenant: op.tenant, doc: op.doc }, seq: op.seq },
            visibilityClass: op.cls,
            restricted: op.restricted,
            reader: 'r',
          };
          const out = await cache.serve(req);
          if (!op.allowed) {
            expect(out).toEqual({ status: 'refused' });
            continue;
          }
          expect(out.status).toBe('served');
          if (out.status === 'served') expect(out.body).toEqual(h.bytesOf(req));
          // A tenant with caching off holds no copy after the read.
          if (!op.enabled) expect(cache.entries(op.tenant)).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('keeps asset keys distinct for each hash in one tenant', () => {
    const r = (hash: string): PinnedResource => ({ kind: 'asset', tenant: 't', hash });
    const k = (hash: string) =>
      pinnedKey({ resource: r(hash), visibilityClass: 'full', restricted: false, reader: 'x' });
    const hashArb = fc
      .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 64, maxLength: 64 })
      .map((cs) => cs.join(''));
    fc.assert(
      fc.property(hashArb, hashArb, (x, y) => {
        expect(k(x) === k(y)).toBe(x === y);
      }),
    );
  });
});
