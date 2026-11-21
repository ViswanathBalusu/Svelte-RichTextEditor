/**
 * Contract checks for the `CheckpointStore` and `AssetStore` ports of 06 §14 (BE-002, BE-003,
 * BE-004). Like the storage checks of `checks.ts` they are plain async functions that throw on a
 * violation, so the same lists run against the stores over the in-memory object store, over an
 * S3-compatible server and over Azure Blob Storage, against any other implementation of the two
 * ports, and against deliberately wrong stores, to show that the suite catches them.
 *
 * Every check makes a tenant and documents of its own, so checks that share one bucket do not see
 * each other's objects. The members that `CheckpointStore` added later are optional in the port;
 * a check of one of them passes a store that does not offer it, and `OPTIONAL_CHECKPOINT_MEMBERS`
 * names them, so that a test can require them of the reference stores.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { canonicalize, type JsonEnvelope } from '@docedit/model';
import { emptyDocument } from '../../src/control-plane/content.ts';
import {
  encodeCheckpoint,
  ObjectAssetStore,
  ObjectCheckpointStore,
} from '../../src/objects/checkpoints.ts';
import {
  ForeignKeyError,
  ObjectExistsError,
  objectKeys,
  type ObjectStore,
} from '../../src/objects/store.ts';
import type { AssetStore, CheckpointStore, DocRef } from '../../src/storage/types.ts';

export interface ObjectHarness {
  checkpoints: CheckpointStore;
  assets: AssetStore;
  /** The object store behind both, when there is one: a check then also looks at the keys. */
  objects?: ObjectStore;
}

export interface ObjectCheck {
  name: string;
  run(h: ObjectHarness): Promise<void>;
}

/** The two ports as the reference service builds them over one `ObjectStore`. */
export function objectHarness(store: ObjectStore): ObjectHarness {
  return {
    checkpoints: new ObjectCheckpointStore(store),
    assets: new ObjectAssetStore(store),
    objects: store,
  };
}

export const OPTIONAL_CHECKPOINT_MEMBERS = [
  'putEncoded',
  'getEncoded',
  'putSide',
  'getSide',
  'setAside',
] as const;

/** One more listing page than an S3-compatible server returns at once (1,000 keys a page). */
export const MORE_THAN_ONE_PAGE = 1100;

const newRef = (tenant: string = randomUUID()): DocRef => ({ tenant, doc: randomUUID() });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const same = (a: Uint8Array | null, b: Uint8Array, what: string): void => {
  assert.ok(a, `${what} is stored`);
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), `${what} is read back byte for byte`);
};

/**
 * Content that differs from the empty document and from other marks. Two calls never give equal
 * content (an empty document has identifiers of its own), so a check keeps what it wrote.
 */
function content(mark: string): JsonEnvelope {
  return { ...emptyDocument(), requires: [`x-${mark}`] };
}

/** Bytes that a store must not read as text: every byte value, then noise. */
function binary(extra = 2048): Uint8Array {
  return Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(extra)]);
}

export const CHECKPOINT_STORE_CHECKS: ObjectCheck[] = [
  {
    name: 'a checkpoint is read back at its sequence number, and the newest at or before a number is found',
    async run(h) {
      const cps = h.checkpoints;
      const ref = newRef();
      assert.equal(await cps.get(ref, 0), null);
      assert.equal(await cps.latest(ref, 10), null);
      const zero = emptyDocument();
      const three = content('three');
      const twenty = content('twenty');
      // Not in order: the store does not rely on the order of the writes.
      await cps.put(ref, 0, zero);
      await cps.put(ref, 20, twenty);
      await cps.put(ref, 3, three);
      assert.deepStrictEqual(await cps.get(ref, 0), zero);
      assert.deepStrictEqual(await cps.get(ref, 3), three);
      assert.deepStrictEqual(await cps.get(ref, 20), twenty);
      assert.equal(await cps.get(ref, 1), null, 'exactly the sequence number, not the nearest');
      assert.deepStrictEqual(await cps.latest(ref, 0), { seq: 0, content: zero });
      assert.deepStrictEqual(await cps.latest(ref, 2), { seq: 0, content: zero });
      assert.deepStrictEqual(await cps.latest(ref, 3), { seq: 3, content: three });
      assert.deepStrictEqual(await cps.latest(ref, 19), { seq: 3, content: three });
      assert.deepStrictEqual(await cps.latest(ref, 20), { seq: 20, content: twenty });
      assert.deepStrictEqual(await cps.latest(ref, Number.MAX_SAFE_INTEGER), {
        seq: 20,
        content: twenty,
      });
    },
  },
  {
    name: 'sequence numbers are ordered as numbers, not as text',
    async run(h) {
      const cps = h.checkpoints;
      const ref = newRef();
      const big = 2 ** 40 + 7;
      const written = new Map<number, JsonEnvelope>();
      for (const seq of [100, 9, big, 10]) {
        written.set(seq, content(`s${seq}`));
        await cps.put(ref, seq, written.get(seq)!);
      }
      assert.equal((await cps.latest(ref, 9))?.seq, 9);
      assert.equal((await cps.latest(ref, 99))?.seq, 10);
      assert.equal((await cps.latest(ref, 100))?.seq, 100);
      assert.equal((await cps.latest(ref, big - 1))?.seq, 100);
      assert.deepStrictEqual(await cps.latest(ref, big), { seq: big, content: written.get(big) });
      assert.deepStrictEqual(await cps.get(ref, 10), written.get(10));
      assert.equal(await cps.latest(ref, 8), null);
      for (const bad of [-1, 1.5, Number.NaN])
        await assert.rejects(async () => cps.put(ref, bad, emptyDocument()), RangeError);
    },
  },
  {
    name: 'writing a sequence number again with equal content leaves one checkpoint',
    async run(h) {
      const cps = h.checkpoints;
      const ref = newRef();
      const five = content('five');
      await cps.put(ref, 5, five);
      await cps.put(ref, 5, five);
      assert.deepStrictEqual(await cps.get(ref, 5), five);
      assert.deepStrictEqual(await cps.latest(ref, 5), { seq: 5, content: five });
      if (h.objects)
        assert.deepStrictEqual(await h.objects.list(objectKeys.checkpoints(ref.tenant, ref.doc)), [
          objectKeys.checkpoint(ref.tenant, ref.doc, 5),
        ]);
    },
  },
  {
    name: 'a checkpoint belongs to its tenant and its document',
    async run(h) {
      const cps = h.checkpoints;
      const ref = newRef();
      const mine = content('mine');
      await cps.put(ref, 4, mine);
      // The same document identifier under another tenant, and another document of the tenant.
      const theirs = { tenant: randomUUID(), doc: ref.doc };
      const sibling = newRef(ref.tenant);
      for (const other of [theirs, sibling]) {
        assert.equal(await cps.get(other, 4), null);
        assert.equal(await cps.latest(other, 100), null);
      }
      const other = content('theirs');
      await cps.put(theirs, 4, other);
      await cps.put(sibling, 6, content('sibling'));
      assert.deepStrictEqual(await cps.get(ref, 4), mine);
      assert.deepStrictEqual(await cps.latest(ref, 100), { seq: 4, content: mine });
      assert.deepStrictEqual(await cps.get(theirs, 4), other);
      // Identifiers that are not UUIDs name no place in the layout of 06 §4.2.
      await assert.rejects(async () => cps.put({ tenant: 'acme', doc: ref.doc }, 1, mine));
      await assert.rejects(async () => cps.get({ tenant: ref.tenant, doc: '../other' }, 1));
    },
  },
  {
    name: 'the stored bytes are the canonical JSON text compressed with Zstandard',
    async run(h) {
      const cps = h.checkpoints;
      if (!cps.putEncoded || !cps.getEncoded) return;
      const ref = newRef();
      assert.equal(await cps.getEncoded(ref, 7), null);
      const seven = content('seven');
      await cps.put(ref, 7, seven);
      const stored = await cps.getEncoded(ref, 7);
      assert.ok(stored);
      assert.equal(zstdDecompressSync(stored).toString('utf8'), canonicalize(seven));
      // The other way: bytes encoded elsewhere (a worker thread) are a checkpoint like any other.
      const eight = content('eight');
      const encoded = encodeCheckpoint(eight);
      await cps.putEncoded(ref, 8, encoded);
      same(await cps.getEncoded(ref, 8), encoded, 'the encoded checkpoint');
      assert.deepStrictEqual(await cps.get(ref, 8), eight);
      assert.deepStrictEqual(await cps.latest(ref, 8), { seq: 8, content: eight });
    },
  },
  {
    name: 'the side object of a checkpoint is stored beside it and is not a checkpoint',
    async run(h) {
      const cps = h.checkpoints;
      if (!cps.putSide || !cps.getSide) return;
      const ref = newRef();
      assert.equal(await cps.getSide(ref, 4), null);
      const four = content('four');
      const side = binary();
      await cps.putSide(ref, 4, side);
      await cps.put(ref, 4, four);
      same(await cps.getSide(ref, 4), side, 'the side object');
      assert.deepStrictEqual(await cps.get(ref, 4), four);
      // A side object without its checkpoint makes no checkpoint.
      await cps.putSide(ref, 30, binary(16));
      assert.equal(await cps.get(ref, 30), null);
      assert.deepStrictEqual(await cps.latest(ref, 40), { seq: 4, content: four });
      assert.equal(await cps.getSide({ tenant: randomUUID(), doc: ref.doc }, 4), null);
      if (h.objects)
        assert.deepStrictEqual(await h.objects.list(objectKeys.checkpoints(ref.tenant, ref.doc)), [
          objectKeys.checkpointSide(ref.tenant, ref.doc, 30),
          objectKeys.checkpoint(ref.tenant, ref.doc, 4),
          objectKeys.checkpointSide(ref.tenant, ref.doc, 4),
        ]);
    },
  },
  {
    name: 'checkpoints above a sequence number are set aside with their side objects and never read again',
    async run(h) {
      const cps = h.checkpoints;
      if (!cps.setAside) return;
      const ref = newRef();
      const sibling = newRef(ref.tenant);
      const written = new Map<number, JsonEnvelope>();
      for (const seq of [0, 10, 20, 30]) {
        written.set(seq, content(`s${seq}`));
        await cps.put(ref, seq, written.get(seq)!);
      }
      for (const seq of [10, 20, 30]) await cps.putSide?.(ref, seq, binary(64));
      await cps.put(sibling, 50, content('sibling'));

      assert.deepStrictEqual(await cps.setAside(ref, 10), [20, 30]);
      for (const seq of [20, 30]) {
        assert.equal(await cps.get(ref, seq), null);
        if (cps.getSide) assert.equal(await cps.getSide(ref, seq), null);
      }
      assert.deepStrictEqual(await cps.latest(ref, 100), { seq: 10, content: written.get(10) });
      assert.deepStrictEqual(await cps.get(ref, 0), written.get(0));
      if (cps.getSide) assert.ok(await cps.getSide(ref, 10), 'the side object at the limit stays');
      assert.deepStrictEqual(await cps.setAside(ref, 10), [], 'nothing is left above');
      assert.equal((await cps.latest(sibling, 100))?.seq, 50, 'another document is untouched');

      if (h.objects) {
        // Kept for the investigation, outside the prefix that reads look in (BE-078).
        const prefix = objectKeys.prefix(ref.tenant);
        const kept = await h.objects.list(`${prefix}docs/${ref.doc}/aside/`);
        assert.equal(kept.length, cps.putSide ? 4 : 2);
        assert.deepStrictEqual(
          (await h.objects.list(objectKeys.checkpoints(ref.tenant, ref.doc))).sort(),
          [
            objectKeys.checkpoint(ref.tenant, ref.doc, 0),
            objectKeys.checkpoint(ref.tenant, ref.doc, 10),
            ...(cps.putSide ? [objectKeys.checkpointSide(ref.tenant, ref.doc, 10)] : []),
          ].sort(),
        );
      }

      // After the recovery the log grows again: a new checkpoint at a number once set aside counts.
      const again = content('again');
      await cps.put(ref, 20, again);
      assert.deepStrictEqual(await cps.latest(ref, 100), { seq: 20, content: again });
      assert.deepStrictEqual(await cps.setAside(ref, 0), [10, 20]);
      assert.deepStrictEqual(await cps.latest(ref, 100), { seq: 0, content: written.get(0) });
    },
  },
  {
    name: 'the newest checkpoint is found among more objects than one listing page holds',
    async run(h) {
      const cps = h.checkpoints;
      const ref = newRef();
      const bytes = encodeCheckpoint(emptyDocument());
      const write = (seq: number): Promise<void> =>
        cps.putEncoded ? cps.putEncoded(ref, seq, bytes) : cps.put(ref, seq, emptyDocument());
      // Written from the top down in parallel batches, so no order of arrival helps the listing.
      const seqs = Array.from({ length: MORE_THAN_ONE_PAGE }, (_, i) => MORE_THAN_ONE_PAGE - i);
      for (let i = 0; i < seqs.length; i += 50) await Promise.all(seqs.slice(i, i + 50).map(write));
      try {
        assert.equal((await cps.latest(ref, Number.MAX_SAFE_INTEGER))?.seq, MORE_THAN_ONE_PAGE);
        // In key order `999` is among the last keys, so a listing cut at one page would miss it.
        assert.equal((await cps.latest(ref, 999))?.seq, 999);
        assert.equal((await cps.latest(ref, 1))?.seq, 1);
        assert.equal(await cps.latest(ref, 0), null);
        if (h.objects)
          assert.equal(
            (await h.objects.list(objectKeys.checkpoints(ref.tenant, ref.doc))).length,
            MORE_THAN_ONE_PAGE,
          );
      } finally {
        // A shared bucket is not left with a thousand objects for every run.
        if (h.objects) {
          const store = h.objects;
          const keys = seqs.map((seq) => objectKeys.checkpoint(ref.tenant, ref.doc, seq));
          for (let i = 0; i < keys.length; i += 50)
            await Promise.all(keys.slice(i, i + 50).map((k) => store.delete(k)));
        }
      }
    },
  },
];

export const ASSET_STORE_CHECKS: ObjectCheck[] = [
  {
    name: 'a quarantined upload is read back by its tenant, and a second upload replaces it',
    async run(h) {
      const assets = h.assets;
      const tenant = randomUUID();
      const asset = randomUUID();
      assert.equal(await assets.getQuarantined(tenant, asset), null);
      const first = binary();
      await assets.putQuarantined(tenant, asset, first);
      same(await assets.getQuarantined(tenant, asset), first, 'the upload');
      const second = Buffer.from('a second upload under the same identifier');
      await assets.putQuarantined(tenant, asset, second);
      same(await assets.getQuarantined(tenant, asset), second, 'the second upload');
      assert.equal(await assets.getQuarantined(randomUUID(), asset), null);
      assert.equal(await assets.getQuarantined(tenant, randomUUID()), null);
      if (h.objects)
        assert.deepStrictEqual(await h.objects.list(`${objectKeys.prefix(tenant)}quarantine/`), [
          `tenants/${tenant}/quarantine/${asset}`,
        ]);
    },
  },
  {
    name: 'a final asset is stored under the SHA-256 the store computes, once for each tenant',
    async run(h) {
      const assets = h.assets;
      const tenant = randomUUID();
      const other = randomUUID();
      const bytes = binary();
      const sha = await assets.putFinal(tenant, bytes, 'image/png');
      assert.equal(sha, sha256(bytes));
      assert.equal(
        await assets.putFinal(tenant, bytes, 'image/png'),
        sha,
        'the same content again',
      );
      same(await assets.getFinal(tenant, sha), bytes, 'the asset');
      assert.equal(await assets.getFinal(tenant, sha256(Buffer.from('never stored'))), null);

      // Assets are scoped to a tenant (06 §4.4): equal content elsewhere is another object.
      assert.equal(await assets.getFinal(other, sha), null);
      assert.equal(await assets.putFinal(other, bytes, 'image/png'), sha);
      same(await assets.getFinal(other, sha), bytes, "the other tenant's asset");

      const second = Buffer.from('different content');
      const sha2 = await assets.putFinal(tenant, second, 'image/jpeg');
      assert.notEqual(sha2, sha);
      if (h.objects)
        assert.deepStrictEqual(
          await h.objects.list(`${objectKeys.prefix(tenant)}assets/`),
          [`tenants/${tenant}/assets/${sha}`, `tenants/${tenant}/assets/${sha2}`].sort(),
        );
    },
  },
  {
    name: 'an export output is stored under its job and read through a signed URL, and through nothing else',
    async run(h) {
      const assets = h.assets;
      const tenant = randomUUID();
      const job = randomUUID();
      const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), binary(512)]);
      await assets.putExport(tenant, job, 'output.pdf', pdf, 'application/pdf');
      await assets.putExport(tenant, job, 'log.txt', Buffer.from('compile log'), 'text/plain');
      const key = objectKeys.exportFile(tenant, job, 'output.pdf');
      assert.equal(key, `tenants/${tenant}/exports/${job}/output.pdf`);
      if (h.objects)
        assert.deepStrictEqual(await h.objects.list(objectKeys.exports(tenant, job)), [
          `tenants/${tenant}/exports/${job}/log.txt`,
          key,
        ]);

      const url = assets.signedUrl(tenant, key, Date.now() + 60_000);
      if (/^https?:\/\//.test(url)) {
        // The signed URL reads the object without credentials, with the type it was stored with.
        const res = await fetch(url);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /^application\/pdf\b/);
        same(new Uint8Array(await res.arrayBuffer()), pdf, 'the export output');
        // The signature is for this object: it opens no other, and without it nothing is served.
        const tampered = await fetch(url.replace('output.pdf', 'log.txt'));
        await tampered.arrayBuffer();
        assert.equal(tampered.status, 403);
        const bare = await fetch(url.slice(0, url.indexOf('?')));
        await bare.arrayBuffer();
        assert.ok(bare.status >= 400 && bare.status < 500, `unsigned read: ${bare.status}`);
      } else assert.ok(url.includes(`tenants/${tenant}/exports/${job}/output.pdf`));

      // A URL is signed for the tenant's own objects only (BE-003 criterion 2).
      const foreign = objectKeys.exportFile(randomUUID(), job, 'output.pdf');
      assert.throws(() => assets.signedUrl(tenant, foreign, Date.now() + 60_000), ForeignKeyError);
    },
  },
  {
    name: 'a sealed PDF is written once',
    async run(h) {
      const assets = h.assets;
      const tenant = randomUUID();
      const doc = randomUUID();
      assert.equal(await assets.getSealed(tenant, doc, 'wf1'), null);
      const sealed = Buffer.concat([Buffer.from('%PDF-1.7 sealed\n'), binary(512)]);
      await assets.putSealed(tenant, doc, 'wf1', sealed);
      await assert.rejects(
        async () => assets.putSealed(tenant, doc, 'wf1', Buffer.from('%PDF-1.7 other')),
        ObjectExistsError,
      );
      await assert.rejects(
        async () => assets.putSealed(tenant, doc, 'wf1', sealed),
        ObjectExistsError,
      );
      same(await assets.getSealed(tenant, doc, 'wf1'), sealed, 'the sealed PDF');
      // Another workflow, another document and another tenant each have a place of their own.
      await assets.putSealed(tenant, doc, 'wf2', Buffer.from('%PDF-1.7 second workflow'));
      await assets.putSealed(tenant, randomUUID(), 'wf1', Buffer.from('%PDF-1.7 other document'));
      assert.equal(await assets.getSealed(randomUUID(), doc, 'wf1'), null);
      same(await assets.getSealed(tenant, doc, 'wf1'), sealed, 'the sealed PDF');
      if (h.objects)
        assert.deepStrictEqual(await h.objects.list(`${objectKeys.prefix(tenant)}final/${doc}/`), [
          `tenants/${tenant}/final/${doc}/wf1.pdf`,
          `tenants/${tenant}/final/${doc}/wf2.pdf`,
        ]);
    },
  },
  {
    name: 'names that could leave the layout of 06 §4.2 are refused',
    async run(h) {
      const assets = h.assets;
      const tenant = randomUUID();
      const id = randomUUID();
      const bytes = Buffer.from('x');
      const refused: Array<() => Promise<unknown>> = [
        async () => assets.putQuarantined('acme', id, bytes),
        async () => assets.putQuarantined(tenant, '../escape', bytes),
        async () => assets.getQuarantined(tenant, `${id}/../x`),
        async () => assets.putFinal('acme', bytes, 'image/png'),
        async () => assets.getFinal(tenant, '../../other'),
        async () => assets.getFinal(tenant, 'ABCDEF'),
        async () => assets.putExport(tenant, 'not-a-job', 'output.pdf', bytes, 'application/pdf'),
        async () => assets.putExport(tenant, id, '../output.pdf', bytes, 'application/pdf'),
        async () => assets.putExport(tenant, id, 'a/b.pdf', bytes, 'application/pdf'),
        async () => assets.putExport(tenant, id, '..', bytes, 'application/pdf'),
        async () => assets.putExport(tenant, id, '', bytes, 'application/pdf'),
        async () => assets.putSealed(tenant, 'not-a-document', 'wf1', bytes),
        async () => assets.putSealed(tenant, id, '../wf1', bytes),
        async () => assets.getSealed(tenant, id, 'a/b'),
      ];
      for (const [i, call] of refused.entries()) await assert.rejects(call, `call ${i}`);
      if (h.objects) assert.deepStrictEqual(await h.objects.list(objectKeys.prefix(tenant)), []);
    },
  },
];

/** Runs every check and returns `name: first line of the failure` for those that failed. */
export async function failingObjectChecks(
  checks: readonly ObjectCheck[],
  harness: () => ObjectHarness,
): Promise<string[]> {
  const failed: string[] = [];
  for (const c of checks) {
    try {
      await c.run(harness());
    } catch (e) {
      failed.push(`${c.name}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  return failed;
}
