// SEC-038 criterion 4, control-plane half (lane U-SEC-033-048): a job the sandbox stops at its time or
// memory limit settles its asset `failed` with the registry code `too_large` and the reason
// `resource_limit`, raises `asset.failed` to the uploader, and leaves a concurrent asset's job alone.
// The kill itself is proven in services/asset-worker/test/sandbox.podman.test.ts (Podman, real sandbox).
import type { AssetOutcome } from '@docedit/asset-worker';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAssetRegistry } from '../../src/control-plane/assets.ts';
import { settleAsset } from '../../src/objects/asset-pipeline.ts';

const TENANT = 'tenant-u-sec-033-048';
const DOC = 'doc-u-sec-033-048';
const KILLED = '018f0000-0000-7000-8000-0000000000a1';
const CONCURRENT = '018f0000-0000-7000-8000-0000000000a2';
const NOW = 1_000_000;

/** An upload already taken by its job: `processing`, as the job handler finds it. */
async function processingRow(reg: MemoryAssetRegistry, id: string): Promise<void> {
  await reg.create(
    TENANT,
    {
      id,
      doc: DOC,
      filename: 'a.png',
      mime: 'image/png',
      declaredBytes: 67,
      createdBy: 'uploader',
      uploadExpiresAt: NOW + 60_000,
    },
    NOW,
  );
  expect(await reg.markProcessing(TENANT, id, `job-${id}`, NOW)).not.toBeNull();
}

describe('SEC-038 criterion 4: a killed decode settles failed and raises asset.failed', () => {
  it('marks the killed asset failed with too_large and resource_limit, and the concurrent asset ready', async () => {
    const reg = new MemoryAssetRegistry();
    await processingRow(reg, KILLED);
    await processingRow(reg, CONCURRENT);
    const notify = vi.fn();

    // What the worker reports when the sandbox is stopped at its time or memory limit (worker.ts,
    // errors.ts: resource_limit maps to the registry code too_large).
    const killed: AssetOutcome = {
      ok: false,
      tenant: TENANT,
      asset: KILLED,
      code: 'too_large',
      reason: 'resource_limit',
      message: 'the sandbox was stopped at its time limit',
    };
    // The other job, in the same process, finishes normally.
    const sha = 'a'.repeat(64);
    const concurrent: AssetOutcome = {
      ok: true,
      tenant: TENANT,
      asset: CONCURRENT,
      mime: 'image/png',
      contentType: 'image/png',
      sha256: sha,
      bytes: 67,
      objectKey: `tenants/${TENANT}/assets/${sha}`,
      width: 1,
      height: 1,
      frames: null,
      renditions: [],
      notes: [],
    };

    expect(await settleAsset(reg, killed, NOW + 10, notify)).toBe(true);
    expect(await settleAsset(reg, concurrent, NOW + 11, notify)).toBe(true);

    const failed = await reg.get(TENANT, KILLED);
    expect(failed).toMatchObject({
      state: 'failed',
      failure: { code: 'too_large', reason: 'resource_limit' },
    });
    expect(failed?.sha256).toBeNull();
    expect(notify).toHaveBeenCalledWith(
      { tenant: TENANT, doc: DOC },
      expect.objectContaining({
        type: 'asset.failed',
        data: { state: 'failed', code: 'too_large' },
      }),
      { user: 'uploader' },
    );

    const ready = await reg.get(TENANT, CONCURRENT);
    expect(ready).toMatchObject({ state: 'ready', sha256: sha });
    expect(notify).toHaveBeenCalledWith(
      { tenant: TENANT, doc: DOC },
      expect.objectContaining({ type: 'asset.ready' }),
      { user: 'uploader' },
    );
    // A failed job is not settled twice: the second settlement changes nothing.
    expect(await settleAsset(reg, killed, NOW + 12, notify)).toBe(false);
  });
});
