// The parts of BE-042 and BE-043 that test/control-plane/routes.assets.test.ts does not assert: the
// answer code of a refused viewer, the uploader and document on the row, a client-declared hash
// ignored, the answer for an oversized declaration, and the quarantined object removed when the
// declared type does not match. Memory storage only; the PostgreSQL run is in routes.assets.test.ts.
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { unsandboxed } from '@docedit/asset-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const CLAIMED_HASH = 'a'.repeat(64);

const visibility: Visibility = () => NOTHING_HIDDEN;

/** Polls the registry until `done` holds for the row, or gives up after about four seconds. */
async function settle(h: Harness, id: string, done: (state: string | undefined) => boolean) {
  let row = await h.parts.assetRegistry.get(h.tenant, id);
  for (let i = 0; i < 200 && !done(row?.state); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    row = await h.parts.assetRegistry.get(h.tenant, id);
  }
  return row;
}

describe('asset upload answers and quarantine (BE-042 criteria 2, 4, 5; BE-043 criterion 2)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('memory', {
      views: { ...FULL_VIEWS, visibility },
      assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
      config: { jobIdleMs: 20 },
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  const upload = (doc: string, token: string, body: unknown) =>
    h.call('POST', `/v1/documents/${doc}/assets`, { token, body });

  it('answers forbidden to a viewer and too_large above the maximum (BE-042 criteria 2, 4)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const viewer = await upload(doc, h.userToken({ [doc]: 'viewer' }), {
      filename: 'a.png',
      mime: 'image/png',
      size: PNG.length,
    });
    expect(viewer.status).toBe(403);
    expect(viewer.json.code).toBe('forbidden');

    const editor = h.userToken({ [doc]: 'editor' });
    const huge = await upload(doc, editor, {
      filename: 'big.png',
      mime: 'image/png',
      size: 2 ** 40,
    });
    expect(huge.status).toBe(413);
    expect(huge.json.code).toBe('too_large');
  });

  it('records the uploader and document, and ignores a client-declared hash (BE-042 criterion 5)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' }, { sub: 'author-be042' });
    const r = await upload(doc, editor, {
      filename: 'dot.png',
      mime: 'image/png',
      size: PNG.length,
      sha256: CLAIMED_HASH,
    });
    expect(r.status).toBe(201);
    const row = await h.parts.assetRegistry.get(h.tenant, r.json.asset);
    expect(row).toMatchObject({
      doc,
      state: 'quarantined',
      mime: 'image/png',
      declaredBytes: PNG.length,
    });
    expect(row?.sha256).toBeNull();
    const surrogate = (await h.parts.users.resolve(h.tenant, 'author-be042')).surrogate;
    expect(row?.createdBy).toBe(surrogate);
    expect(r.json.upload.headers['content-length']).toBe(String(PNG.length));
  });

  it('removes the quarantined object when the declared type differs from the content (BE-043 criterion 2)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await upload(doc, editor, {
      filename: 'dot.jpg',
      mime: 'image/jpeg',
      size: PNG.length,
    });
    expect(r.status).toBe(201);
    const id = r.json.asset as string;
    await h.service.assets.putQuarantined(h.tenant, id, PNG);
    expect(await h.service.assets.getQuarantined(h.tenant, id)).not.toBeNull();
    expect((await h.call('POST', `/v1/assets/${id}/complete`, { token: editor })).status).toBe(202);

    const row = await settle(h, id, (state) => state === 'failed');
    expect(row).toMatchObject({ state: 'failed', failure: { code: 'validation_failed' } });
    expect(await h.service.assets.getQuarantined(h.tenant, id)).toBeNull();
    expect(h.stub.notices).toContainEqual(
      expect.objectContaining({
        kind: 'notify',
        notification: expect.objectContaining({ type: 'asset.failed' }),
      }),
    );
  });
});
