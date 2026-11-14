// SEC-037 criteria 4 to 6 (lane U-SEC-033-048): an asset is resolved to a URL only when it is ready
// and attached to the document the caller may read. A quarantined or failed asset gets no URL, an
// asset of another document gets no URL for a caller who may read that other document, and a guessed
// identifier answers exactly as an absent asset does. Runs over the real HTTP service with the asset
// worker in process (unsandboxed, for tests only), on memory and on PostgreSQL where it is available.
import { randomBytes } from 'node:crypto';
import { NOTHING_HIDDEN, type StoredCommit, type Visibility } from '@docedit/authority';
import { unsandboxed } from '@docedit/asset-worker';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const LEGAL = 'rLegal0000000001';
const URL_KEY = { id: 'k1', secret: randomBytes(32) };

const visibility: Visibility = (conn) =>
  conn.role === 'owner'
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

/** Stores a commit that inserts an inline image of `asset` at the start of block `block` (as the room would). */
async function insertImage(h: Harness, doc: string, block: string, asset: string): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const content = await h.service.content.rebuild(ref, head.incarnation, head.seq);
  const pos = inside(content.doc, block);
  const commit: StoredCommit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: pos,
        to: pos,
        slice: { content: [{ type: 'image', attrs: { asset, width: 100, height: 100 } }] },
      },
    ] as StoredCommit['steps'],
    user: 'u-test',
    session: 's',
    time: h.now(),
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  };
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [commit],
  });
  expect(r.status).toBe('ok');
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`SEC-037 asset resolve refusals (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        views: { ...FULL_VIEWS, visibility },
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        config: {
          jobIdleMs: 20,
          assetOrigin: 'https://assets.tests.example',
          assetUrlKey: `${URL_KEY.id}:${URL_KEY.secret.toString('base64')}`,
        },
      });
    });
    afterAll(async () => {
      await h?.close();
    });

    const upload = (doc: string, token: string, body: unknown) =>
      h.call('POST', `/v1/documents/${doc}/assets`, { token, body });

    const resolve = (doc: string, token: string, assets: string[]) =>
      h.call('POST', `/v1/documents/${doc}/assets/resolve`, { token, body: { assets } });

    /** Uploads the PNG, completes it and waits until it is ready. */
    async function readyAsset(doc: string, token: string): Promise<string> {
      const r = await upload(doc, token, {
        filename: 'dot.png',
        mime: 'image/png',
        size: PNG.length,
      });
      expect(r.status).toBe(201);
      const id = r.json.asset as string;
      await h.service.assets.putQuarantined(h.tenant, id, PNG);
      expect((await h.call('POST', `/v1/assets/${id}/complete`, { token })).status).toBe(202);
      for (let i = 0; i < 200; i++) {
        const row = await h.parts.assetRegistry.get(h.tenant, id);
        if (row?.state === 'ready') return id;
        if (row?.state === 'failed')
          throw new Error(`asset failed: ${JSON.stringify(row.failure)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('the asset did not become ready');
    }

    it.skipIf(skip)(
      'issues no URL for a quarantined or a failed asset, even when the content references it (criterion 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
        const ready = await readyAsset(doc, owner);
        // Quarantined: uploaded, never completed.
        const quarantined = (
          await upload(doc, owner, { filename: 'q.png', mime: 'image/png', size: PNG.length })
        ).json.asset as string;
        // Failed: a JPEG declared but PNG bytes sent, so the worker's type check fails it.
        const failedUpload = await upload(doc, owner, {
          filename: 'f.jpg',
          mime: 'image/jpeg',
          size: PNG.length,
        });
        const failed = failedUpload.json.asset as string;
        await h.service.assets.putQuarantined(h.tenant, failed, PNG);
        await h.call('POST', `/v1/assets/${failed}/complete`, { token: owner });
        for (let i = 0; i < 200; i++) {
          if ((await h.parts.assetRegistry.get(h.tenant, failed))?.state === 'failed') break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect((await h.parts.assetRegistry.get(h.tenant, failed))?.state).toBe('failed');
        expect((await h.parts.assetRegistry.get(h.tenant, quarantined))?.state).toBe('quarantined');

        // Attach all three to the document's content, so only the state can refuse them.
        await insertImage(h, doc, 'pIntro0000000001', ready);
        await insertImage(h, doc, 'pIntro0000000001', quarantined);
        await insertImage(h, doc, 'pIntro0000000001', failed);

        // Control: the ready one is resolved, so the empty answers below are not vacuous.
        const r = await resolve(doc, owner, [ready, quarantined, failed]);
        expect(r.status).toBe(200);
        expect(r.json.assets.map((a: { asset: string }) => a.asset)).toEqual([ready]);
        // A quarantined asset and a failed asset each get no URL on their own.
        expect((await resolve(doc, owner, [quarantined])).json.assets).toEqual([]);
        expect((await resolve(doc, owner, [failed])).json.assets).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'refuses a URL for an asset attached only to document A to a caller who has view on document B (criterion 4)',
      async () => {
        const docA = await h.createDocument({ content: documentWithRegions() });
        const docB = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [docA]: 'owner' }, { sub: 'olga' });
        const asset = await readyAsset(docA, owner);
        await insertImage(h, docA, 'pIntro0000000001', asset);

        // Control: the owner of A gets the URL.
        const own = await resolve(docA, owner, [asset]);
        expect(own.json.assets.map((a: { asset: string }) => a.asset)).toEqual([asset]);

        // A caller with view on B, and nothing on A, asks B for the asset of A: no URL.
        const viewerB = h.userToken({ [docB]: 'viewer' }, { sub: 'vera' });
        const onB = await resolve(docB, viewerB, [asset]);
        expect(onB.status).toBe(200);
        expect(onB.json.assets).toEqual([]);
        // And asks A itself with the same token: refused, because the token does not cover A, and no URL.
        const onA = await resolve(docA, viewerB, [asset]);
        expect(onA.status).toBe(403);
        expect(JSON.stringify(onA.json)).not.toContain('assets.tests.example');
      },
    );

    it.skipIf(skip)(
      'answers a guessed identifier exactly as it answers an absent one (criterion 6)',
      async () => {
        const docA = await h.createDocument({ content: documentWithRegions() });
        const docB = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [docA]: 'owner' }, { sub: 'olga' });
        const asset = await readyAsset(docA, owner);
        await insertImage(h, docA, 'pIntro0000000001', asset);
        const guessed = uuid7();

        // A caller with view on B, who cannot see the asset of A.
        const viewerB = h.userToken({ [docB]: 'viewer' }, { sub: 'vera' });
        const real = await resolve(docB, viewerB, [asset]);
        const absent = await resolve(docB, viewerB, [guessed]);
        expect(absent.status).toBe(real.status);
        expect(absent.json).toEqual(real.json);

        // A caller with no grant on A at all: the real identifier and a guessed one answer alike.
        const stranger = h.userToken({ [docB]: 'viewer' }, { sub: 'stan' });
        const realOnA = await resolve(docA, stranger, [asset]);
        const guessedOnA = await resolve(docA, stranger, [guessed]);
        // requestId is unique per request; everything else must be the same.
        const withoutRequest = (j: unknown) => ({
          ...(j as Record<string, unknown>),
          requestId: undefined,
        });
        expect(guessedOnA.status).toBe(realOnA.status);
        expect(withoutRequest(guessedOnA.json)).toEqual(withoutRequest(realOnA.json));
        expect(JSON.stringify(realOnA.json)).not.toContain(asset);
      },
    );
  });
}
