// BE-042 criterion 6 over HTTP (memory storage; the PostgreSQL run skips without a database): the
// completion of an upload queues the asset worker's job, and the asset stays unusable while the job
// has not raised `asset.ready`. The harness runs no asset worker here (`assetWorker: null`), so the
// job stays queued and the state at each step is fixed.
import { ASSET_JOB_KIND } from '@docedit/asset-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('BE-042 criterion 6 over HTTP (memory)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', {
      views: FULL_VIEWS,
      assetWorker: null,
      config: { jobIdleMs: 20 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('queues one asset-worker job on completion and keeps the asset unusable until it is ready', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
      token: editor,
      body: { filename: 'dot.png', mime: 'image/png', size: PNG.length },
    });
    expect(r.status).toBe(201);
    const id = r.json.asset as string;
    await h.service.assets.putQuarantined(h.tenant, id, PNG);

    const done = await h.call('POST', `/v1/assets/${id}/complete`, { token: editor });
    expect(done.status).toBe(202);
    expect(done.json).toMatchObject({ asset: id, doc, state: 'processing' });

    // The job the completion queued: the worker's kind, and the payload it reads and nothing else.
    const row = await h.parts.assetRegistry.get(h.tenant, id);
    expect(row).toMatchObject({ state: 'processing' });
    expect(row!.jobId).toEqual(expect.any(String));
    const job = await h.parts.queue.get(h.tenant, row!.jobId!);
    expect(job).toMatchObject({
      kind: ASSET_JOB_KIND,
      state: 'queued',
      payload: { asset: id, mime: 'image/png', size: PNG.length },
    });

    // Not ready, so the uploader cannot resolve it to a URL.
    const before = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
      token: editor,
      body: { assets: [id] },
    });
    expect(before.status).toBe(200);
    expect(before.json.assets).toEqual([]);

    // A second completion queues no second job.
    const again = await h.call('POST', `/v1/assets/${id}/complete`, { token: editor });
    expect(again.status).toBe(202);
    expect(again.json.state).toBe('processing');
    const latest = await h.parts.queue.latestFor(h.tenant, doc, ASSET_JOB_KIND);
    expect(latest?.id).toBe(row!.jobId);
    expect((await h.parts.assetRegistry.get(h.tenant, id))?.jobId).toBe(row!.jobId);
  });
});
