// Assets over real HTTP (05 §6.2; 06 §4.4; 10 §3.5; PRO-061, PRO-062; D142), with the asset worker
// of services/asset-worker running in process on its content checks without the Podman sandbox
// (`unsandboxed()`, for tests only) and the separate asset origin started beside the service.
import { randomBytes } from 'node:crypto';
import { NOTHING_HIDDEN, type StoredCommit, type Visibility } from '@docedit/authority';
import {
  startAssetOrigin,
  unsandboxed,
  verifyAssetUrl,
  type RunningOrigin,
} from '@docedit/asset-worker';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { workerObjects } from '../../src/objects/asset-pipeline.ts';
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

/** Stores a commit that inserts an inline image of `asset` at the start of block `block`. */
async function insertImage(
  h: Harness,
  doc: string,
  block: string,
  asset: string,
  attach = false,
): Promise<void> {
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
  // With ttach, the doc_assets row is written with the commit, as the data plane does (BE-044).
  const r = await h.parts.logs.append(
    ref,
    { epoch, revision: perms.revision, fromSeq: head.seq + 1, commits: [commit] },
    attach ? { attachments: [{ asset, seq: head.seq + 1 }] } : {},
  );
  expect(r.status).toBe('ok');
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`assets (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let origin: RunningOrigin;
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
      // The separate origin that serves the objects, with the same URL key (BE-045).
      origin = await startAssetOrigin({
        objects: workerObjects(h.parts.objects),
        keys: { current: URL_KEY },
        host: '127.0.0.1',
        port: 0,
      });
    });
    afterAll(async () => {
      await origin?.close();
      await h?.close();
    });

    const upload = async (doc: string, token: string, body: unknown) =>
      h.call('POST', `/v1/documents/${doc}/assets`, { token, body });

    /** Uploads the PNG, completes it and waits until its uploader can resolve it. */
    async function readyAsset(doc: string, token: string): Promise<string> {
      const r = await upload(doc, token, {
        filename: 'dot.png',
        mime: 'image/png',
        size: PNG.length,
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
      'gives an editor an identifier and a size-bound upload into quarantine, and refuses viewers (PRO-061 criteria 1, 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const r = await upload(doc, editor, { filename: 'dot.png', mime: 'image/png', size: 67 });
        expect(r.status).toBe(201);
        expect(r.json).toMatchObject({
          asset: expect.stringMatching(/^[0-9a-f-]{36}$/),
          doc,
          state: 'quarantined',
          upload: { method: 'PUT', headers: { 'content-length': '67' } },
        });
        const row = await h.parts.assetRegistry.get(h.tenant, r.json.asset);
        expect(row).toMatchObject({ state: 'quarantined', declaredBytes: 67, mime: 'image/png' });
        expect(row?.sha256).toBeNull();
        // `view` alone is not enough (row 6 of 07 §12).
        const viewer = await upload(doc, h.userToken({ [doc]: 'viewer' }), {
          filename: 'a.png',
          mime: 'image/png',
          size: 10,
        });
        expect(viewer.status).toBe(403);
        // A suggester and a service credential may upload.
        expect(
          (
            await upload(doc, h.userToken({ [doc]: 'suggester' }), {
              filename: 'a.png',
              mime: 'image/png',
              size: 10,
            })
          ).status,
        ).toBe(201);
        expect(
          (await upload(doc, h.apiKey, { filename: 'a.png', mime: 'image/png', size: 10 })).status,
        ).toBe(201);
        // What the worker does not take is refused before anything is created.
        const exe = await upload(doc, editor, {
          filename: 'x.exe',
          mime: 'application/x-msdownload',
          size: 10,
        });
        expect(exe.status).toBe(400);
        expect(exe.json.code).toBe('validation_failed');
        const huge = await upload(doc, editor, {
          filename: 'big.png',
          mime: 'image/png',
          size: 2 ** 40,
        });
        expect(huge.status).toBe(413);
        expect(huge.json.code).toBe('too_large');
      },
    );

    it.skipIf(skip)(
      'completes an upload through the asset worker, which raises asset.ready to the uploader (PRO-061 criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' }, { sub: 'uploader' });
        const id = await readyAsset(doc, editor);
        const row = (await h.parts.assetRegistry.get(h.tenant, id))!;
        expect(row).toMatchObject({
          state: 'ready',
          contentType: 'image/png',
          width: 1,
          height: 1,
        });
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
        // The worker computed the hash of what it wrote, under the content-addressed key.
        expect(row.objectKey).toBe(`tenants/${h.tenant}/assets/${row.sha256}`);
        expect(await h.service.assets.getQuarantined(h.tenant, id)).toBeNull();
        const surrogate = (await h.parts.users.resolve(h.tenant, 'uploader')).surrogate;
        expect(h.stub.notices).toContainEqual(
          expect.objectContaining({
            kind: 'notify',
            user: surrogate,
            notification: expect.objectContaining({
              type: 'asset.ready',
              resource: `/assets/${id}`,
            }),
          }),
        );
        // Another user cannot complete someone's upload; a second completion changes nothing.
        expect(
          (
            await h.call('POST', `/v1/assets/${id}/complete`, {
              token: h.userToken({ [doc]: 'editor' }),
            })
          ).status,
        ).toBe(403);
        expect(
          (await h.call('POST', `/v1/assets/${id}/complete`, { token: editor })).json.state,
        ).toBe('ready');
      },
    );

    it.skipIf(skip)(
      'fails an upload whose content differs from its declared type, with asset.failed (PRO-061 criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const r = await upload(doc, editor, {
          filename: 'dot.jpg',
          mime: 'image/jpeg',
          size: PNG.length,
        });
        const id = r.json.asset as string;
        await h.service.assets.putQuarantined(h.tenant, id, PNG);
        await h.call('POST', `/v1/assets/${id}/complete`, { token: editor });
        let row = await h.parts.assetRegistry.get(h.tenant, id);
        for (let i = 0; i < 200 && row?.state !== 'failed'; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          row = await h.parts.assetRegistry.get(h.tenant, id);
        }
        expect(row).toMatchObject({ state: 'failed', failure: { code: 'validation_failed' } });
        expect(h.stub.notices).toContainEqual(
          expect.objectContaining({
            kind: 'notify',
            notification: expect.objectContaining({ type: 'asset.failed' }),
          }),
        );
        // A failed asset has no URL.
        const resolved = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
          token: editor,
          body: { assets: [id] },
        });
        expect(resolved.json.assets).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'resolves ready, attached assets the caller can see to short-lived URLs of the separate origin (PRO-061 criterion 4; PRO-062)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
        const visible = await readyAsset(doc, owner);
        const secret = await readyAsset(doc, owner);
        const loose = await readyAsset(doc, owner);
        const pending = (
          await upload(doc, owner, { filename: 'p.png', mime: 'image/png', size: PNG.length })
        ).json.asset as string;
        await insertImage(h, doc, 'pIntro0000000001', visible);
        await insertImage(h, doc, 'pLegal0000000001', secret);
        // A viewer sees the intro and not the legal region (the test policy).
        const viewer = h.userToken({ [doc]: 'viewer' });
        const r = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
          token: viewer,
          body: { assets: [visible, secret, loose, pending, uuid7()] },
        });
        expect(r.status).toBe(200);
        expect(r.json.assets.map((a: { asset: string }) => a.asset)).toEqual([visible]);
        const [a] = r.json.assets as Array<{ url: string; expiresAt: string; contentType: string }>;
        expect(a!.contentType).toBe('image/png');
        const url = new URL(a!.url);
        // A separate origin from the service's own (10 §3.5).
        expect(url.origin).toBe('https://assets.tests.example');
        expect(url.origin).not.toBe(new URL(h.base).origin);
        // The asset origin serves it with a fixed type, and refuses it after the expiry.
        const served = await fetch(`${origin.url}${url.pathname}${url.search}`);
        expect(served.status).toBe(200);
        expect(served.headers.get('content-type')).toBe('image/png');
        expect(served.headers.get('x-content-type-options')).toBe('nosniff');
        await served.arrayBuffer();
        const exp = Date.parse(a!.expiresAt);
        expect(exp - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
        expect(
          verifyAssetUrl(`${url.pathname}${url.search}`, { current: URL_KEY }, exp + 1000),
        ).toEqual({
          ok: false,
          reason: 'expired',
        });
        // The owner sees both, and the uploader its loose upload as well.
        const all = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
          token: owner,
          body: { assets: [visible, secret, loose, pending] },
        });
        expect(all.json.assets.map((x: { asset: string }) => x.asset).sort()).toEqual(
          [visible, secret, loose].sort(),
        );
        // An asset of another document is not attached here.
        const other = await h.createDocument({ content: documentWithRegions() });
        const elsewhere = await h.call('POST', `/v1/documents/${other}/assets/resolve`, {
          token: h.userToken({ [other]: 'owner' }),
          body: { assets: [visible] },
        });
        expect(elsewhere.json.assets).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'resolves an asset only for a document it is attached to, even when the content of another document names it (BE-045 criterion 1)',
      async () => {
        const first = await h.createDocument({ content: documentWithRegions() });
        const second = await h.createDocument({ content: documentWithRegions() });
        const asset = await readyAsset(first, h.userToken({ [first]: 'owner' }, { sub: 'olga' }));
        // The second document's content names the first document's asset; no row attaches it there.
        await insertImage(h, second, 'pIntro0000000001', asset);
        const owner = h.userToken({ [second]: 'owner' }, { sub: 'olga' });
        const resolve = async () =>
          (
            await h.call('POST', `/v1/documents/${second}/assets/resolve`, {
              token: owner,
              body: { assets: [asset] },
            })
          ).json.assets.map((a: { asset: string }) => a.asset);
        expect(await resolve()).toEqual([]);
        // Once a commit attaches it to the second document, it resolves there to a signed URL.
        await insertImage(h, second, 'pIntro0000000001', asset, true);
        expect(await resolve()).toEqual([asset]);
      },
    );
  });
}
