// PRM-057 criterion 4 (07 §12 row 7): a user with `view` on the document an asset is attached to
// reads it through the resolve route; for another document the same asset is refused. Lane
// U-PRM-052-067. The asset worker runs in process, unsandboxed, as in routes.assets.test.ts; the
// test uses the real PostgreSQL store when the integration environment is up (memory otherwise).
import { randomBytes } from 'node:crypto';
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsandboxed } from '@docedit/asset-worker';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const URL_KEY = { id: 'k1', secret: randomBytes(32) };
const BODY_PARAGRAPH = 'pIntro0000000001';

/** The position just inside the node with `id` (for a `replace` step). */
function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, p) => {
      if (n.attrs['id'] === id) at = p + 1;
      return at < 0;
    });
  if (at < 0) throw new Error(`no node ${id}`);
  return at;
}

/** Attaches an image of `asset` to the body paragraph by a stored commit (as the editor would). */
async function attachImage(h: Harness, doc: string, asset: string): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const content = await h.service.content.rebuild(ref, head.incarnation, head.seq);
  const commit: StoredCommit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: inside(content.doc, BODY_PARAGRAPH),
        to: inside(content.doc, BODY_PARAGRAPH),
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
  describe(`PRM-057 row 7: asset reads (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
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

    /** Uploads the PNG, completes it and waits until it is ready. */
    async function readyAsset(doc: string, token: string): Promise<string> {
      const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
        token,
        body: { filename: 'dot.png', mime: 'image/png', size: PNG.length },
      });
      expect(r.status).toBe(201);
      const id = r.json.asset as string;
      await h.service.assets.putQuarantined(h.tenant, id, PNG);
      const done = await h.call('POST', `/v1/assets/${id}/complete`, { token });
      expect(done.status).toBe(202);
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
      'lets a viewer of the attached document read the asset, and refuses the same read on another document',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const other = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner', [other]: 'owner' }, { sub: 'olga' });
        const asset = await readyAsset(doc, owner);
        await attachImage(h, doc, asset);

        // With view on the attached document the asset resolves to a short-lived URL.
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'vera' });
        const read = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
          token: viewer,
          body: { assets: [asset] },
        });
        expect(read.status).toBe(200);
        expect(read.json.assets.map((a: { asset: string }) => a.asset)).toEqual([asset]);

        // A user whose only role is on the other document has no view on this one: refused.
        const stranger = h.userToken({ [other]: 'viewer' }, { sub: 'otto' });
        const refusedHere = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
          token: stranger,
          body: { assets: [asset] },
        });
        expect(refusedHere.status).toBe(403);
        expect(refusedHere.json.error?.code ?? refusedHere.json.code).toBe('forbidden');

        // Resolving the same asset through the other document returns nothing: it is not attached there.
        const elsewhere = await h.call('POST', `/v1/documents/${other}/assets/resolve`, {
          token: stranger,
          body: { assets: [asset] },
        });
        expect(elsewhere.status).toBe(200);
        expect(elsewhere.json.assets).toEqual([]);
      },
    );
  });
}
