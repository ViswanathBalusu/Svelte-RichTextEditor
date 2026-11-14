/**
 * SEC-045 criterion 4, in part (lane SEC-040-052, 2026-11-13): object keys carry the tenant, and a
 * signed URL for tenant A's object does not work on a key of tenant B.
 *
 * Proved here:
 * - the asset origin's verifier (services/asset-worker/src/signing.ts, `verifyAssetUrl`) refuses a
 *   URL signed for tenant A's object once its tenant is replaced with B's, in the path, with the
 *   signature of A kept (property over tenant pairs and hashes); B's own URL still verifies;
 * - the object layer writes every key of a two-tenant run under `tenants/{tenant}/` (the kinds of
 *   `objectKeys` that exist: checkpoints, checkpoint asides, quarantine, assets, export files and
 *   final PDFs), read back from the in-memory store.
 *
 * Not proved here: the criterion's "full scenario" (the document service's HTTP scenario and every
 * key it writes), because no such run is wired to this test; and the control plane's own store URLs
 * (`MemoryObjectStore.signedUrl`), which have no verifier in the service. See the story's Notes.
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore, objectKeys, TenantObjects } from '@docedit/document-service';
import {
  signAssetUrl,
  verifyAssetUrl,
  type AssetUrlKeys,
} from '../../../services/asset-worker/src/signing.ts';
import { PNG } from '../../../services/asset-worker/src/sandbox/types.ts';

const ORIGIN = 'https://assets.example.test/';
const NOW = 1_700_000_000_000;

function keysFor(seed: number): AssetUrlKeys {
  return {
    current: { id: `k${seed % 100}`, secret: new Uint8Array(32).fill(seed % 251) },
  };
}

function sha(n: number): string {
  return n.toString(16).padStart(8, '0').repeat(8).slice(0, 64);
}

describe('SEC-045 criterion 4: a signed URL for tenant A does not open tenant B', () => {
  it('a URL for A, re-pathed under B with A signature, fails; B own URL verifies', () => {
    const a = randomUUID();
    const b = randomUUID();
    const hash = sha(7);
    const keys = keysFor(7);
    const urlA = signAssetUrl({
      origin: ORIGIN,
      tenant: a,
      sha256: hash,
      mime: PNG,
      expiresAt: NOW + 60_000,
      keys,
    });
    const pathAndQuery = urlA.slice(ORIGIN.length - 1);
    expect(verifyAssetUrl(pathAndQuery, keys, NOW)).toMatchObject({ ok: true, tenant: a });

    const moved = pathAndQuery.replace(`/a/${a}/`, `/a/${b}/`);
    expect(verifyAssetUrl(moved, keys, NOW)).toEqual({ ok: false, reason: 'bad_signature' });

    const urlB = signAssetUrl({
      origin: ORIGIN,
      tenant: b,
      sha256: hash,
      mime: PNG,
      expiresAt: NOW + 60_000,
      keys,
    });
    expect(verifyAssetUrl(urlB.slice(ORIGIN.length - 1), keys, NOW)).toMatchObject({
      ok: true,
      tenant: b,
    });
  });

  it('for any pair of tenants, hashes and key seeds, moving a URL to another tenant never verifies (property)', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 0, max: 0xffffff }),
        fc.integer({ min: 1, max: 250 }),
        (tenantA, tenantB, hashSeed, seed) => {
          fc.pre(tenantA !== tenantB);
          const keys = keysFor(seed);
          const url = signAssetUrl({
            origin: ORIGIN,
            tenant: tenantA,
            sha256: sha(hashSeed),
            mime: PNG,
            expiresAt: NOW + 60_000,
            keys,
          });
          const moved = url.slice(ORIGIN.length - 1).replace(`/a/${tenantA}/`, `/a/${tenantB}/`);
          const result = verifyAssetUrl(moved, keys, NOW);
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('SEC-045 criterion 4: every object key of a two-tenant run starts with its tenant', () => {
  it('lists every key written by both tenants, and each starts with tenants/{tenant}/', async () => {
    const raw = new MemoryObjectStore();
    const a = randomUUID();
    const b = randomUUID();
    const enc = new TextEncoder();
    const doc = randomUUID();
    const job = randomUUID();
    const sha256 = sha(1);
    for (const tenant of [a, b]) {
      const view = new TenantObjects(raw, tenant);
      await view.put(objectKeys.checkpoint(tenant, doc, 3), enc.encode('cp'));
      await view.put(objectKeys.checkpointAside(tenant, doc, 3, 'side'), enc.encode('aside'));
      await view.put(objectKeys.quarantine(tenant, randomUUID()), enc.encode('q'));
      await view.put(objectKeys.asset(tenant, sha256), enc.encode('asset'));
      await view.put(objectKeys.exportFile(tenant, job, 'out.pdf'), enc.encode('pdf'));
      await view.put(objectKeys.final(tenant, doc, 'workflow'), enc.encode('final'));
    }
    const listed = await raw.list('');
    expect(listed.length).toBe(12);
    for (const key of listed) {
      const owner = [a, b].find((t) => key.startsWith(`tenants/${t}/`));
      expect(owner).toBeDefined();
    }
  });
});
