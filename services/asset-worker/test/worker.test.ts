/**
 * The worker's job end to end with an in-memory store (BE-043 criteria 2, 3, 6, 7; SEC-037
 * criteria 1 and 2; SEC-038 criterion 4; SEC-040 criteria 2 and 3). The content checks run
 * unsandboxed here; sandbox.podman.test.ts runs the same jobs in the Podman sandbox. Fake sandboxes
 * stand for a compromised or failing one: their replies are forged, and the worker must refuse them.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assetKeys } from '../src/keys.ts';
import { MemoryAssetObjects, ObjectStoreUnavailable, type AssetObjects } from '../src/objects.ts';
import { unsandboxed, type Sandbox, type SandboxRun } from '../src/sandbox-port.ts';
import { encodeFrame, REPLY_MAGIC } from '../src/sandbox/frame.ts';
import { DOCX, GIF, JPEG, PDF, PNG, SVG } from '../src/sandbox/types.ts';
import {
  AssetJobError,
  createAssetWorker,
  type AssetFailed,
  type AssetOutcomes,
  type AssetReady,
} from '../src/worker.ts';
import { concat, docx, enc, gifOf, jpegOf, png, pngPixelBomb, SVG_OK } from './fixtures.ts';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function recorder() {
  const events: (AssetReady | AssetFailed)[] = [];
  const outcomes: AssetOutcomes = {
    async ready(r) {
      events.push(r);
    },
    async failed(f) {
      events.push(f);
    },
  };
  return { events, outcomes };
}

function setup(sandbox: Sandbox = unsandboxed(), objects: AssetObjects = new MemoryAssetObjects()) {
  const rec = recorder();
  const worker = createAssetWorker({
    objects,
    sandbox,
    outcomes: rec.outcomes,
    allowUnsandboxed: true,
  });
  return { worker, objects, ...rec };
}

async function upload(objects: AssetObjects, tenant: string, bytes: Uint8Array): Promise<string> {
  const asset = randomUUID();
  await objects.put(assetKeys.quarantine(tenant, asset), bytes, {
    contentType: 'application/octet-stream',
  });
  return asset;
}

const job = (tenant: string, payload: Record<string, unknown>) => ({
  tenant,
  id: randomUUID(),
  payload,
});

describe('the worker refuses to run without its sandbox', () => {
  it('needs allowUnsandboxed to use the in-process runner', () => {
    expect(() =>
      createAssetWorker({ objects: new MemoryAssetObjects(), sandbox: unsandboxed() }),
    ).toThrow(/sandbox/);
  });
});

describe('a valid image (BE-043 criterion 3; SEC-037 criterion 1)', () => {
  it('is re-encoded, hashed by the worker, stored once under the tenant, and its upload deleted', async () => {
    const { worker, objects, events } = setup();
    const mem = objects as MemoryAssetObjects;
    const tenant = randomUUID();
    const input = concat(png(), enc('<script>appended</script>'));
    const asset = await upload(objects, tenant, input);
    // A declared hash and a foreign tenant in the payload are ignored: only asset, mime, size are read.
    const forged = '0'.repeat(64);
    const r = await worker.handle(
      job(tenant, {
        asset,
        mime: 'image/png',
        size: input.length,
        sha256: forged,
        tenant: randomUUID(),
      }),
    );
    expect(r.ok).toBe(true);
    const ready = r as AssetReady;
    const stored = mem.objects.get(ready.objectKey)!;
    expect(ready.objectKey).toBe(`tenants/${tenant}/assets/${ready.sha256}`);
    expect(ready.sha256).toBe(sha(stored.body));
    expect(ready.sha256).not.toBe(forged);
    expect(ready.sha256).not.toBe(sha(input));
    expect(ready).toMatchObject({
      tenant,
      asset,
      mime: PNG,
      contentType: PNG,
      bytes: stored.body.length,
      width: 48,
      height: 32,
    });
    expect(stored.contentType).toBe(PNG);
    expect(stored.cacheControl).toMatch(/immutable/);
    expect(mem.objects.has(assetKeys.quarantine(tenant, asset))).toBe(false);
    expect(mem.objects.has(assetKeys.final(tenant, forged))).toBe(false);
    expect([...mem.objects.keys()].every((k) => k.startsWith(`tenants/${tenant}/`))).toBe(true);
    expect(events).toEqual([ready]);
  });

  it('ignores a declared hash of an existing asset, of this tenant or another, and overwrites nothing (SEC-037 criterion 1)', async () => {
    const { worker, objects, events } = setup();
    const mem = objects as MemoryAssetObjects;
    const owner = randomUUID();
    const intruder = randomUUID();
    // The owner's asset already exists under its own prefix.
    const existing = (await worker.handle(
      job(owner, {
        asset: await upload(objects, owner, png()),
        mime: PNG,
        size: png().length,
      }),
    )) as AssetReady;
    const existingKey = existing.objectKey;
    const existingBody = mem.objects.get(existingKey)!.body.slice();
    mem.calls.length = 0;
    // The intruder declares the owner's hash for a different image.
    const other = jpegOf(40, 30);
    for (const declared of [existing.sha256]) {
      const r = (await worker.handle(
        job(intruder, {
          asset: await upload(objects, intruder, other),
          mime: JPEG,
          size: other.length,
          sha256: declared,
        }),
      )) as AssetReady;
      expect(r.ok).toBe(true);
      // Keyed by the worker's own hash of its output, under the intruder's prefix only.
      expect(r.sha256).not.toBe(declared);
      expect(r.objectKey).toBe(`tenants/${intruder}/assets/${r.sha256}`);
      expect(mem.objects.has(assetKeys.final(intruder, declared))).toBe(false);
    }
    // The owner's object is untouched and no write went to its key.
    expect(mem.objects.get(existingKey)!.body).toEqual(existingBody);
    expect(mem.calls.some((c) => c.includes(`tenants/${owner}/`))).toBe(false);
    // The owner's job and the intruder's job each raised one ready event.
    expect(events.filter((e) => e.ok)).toHaveLength(2);
  });

  it('stores renditions for the typesetter: a PNG of a GIF, a PDF of an SVG', async () => {
    const { worker, objects } = setup();
    const mem = objects as MemoryAssetObjects;
    const tenant = randomUUID();
    const g = gifOf(2);
    const gr = (await worker.handle(
      job(tenant, { asset: await upload(objects, tenant, g), mime: GIF, size: g.length }),
    )) as AssetReady;
    expect(gr).toMatchObject({ mime: GIF, contentType: GIF, frames: 2 });
    expect(gr.renditions).toHaveLength(1);
    expect(gr.renditions[0]).toMatchObject({ role: 'print', mime: PNG });
    expect(mem.objects.get(gr.renditions[0]!.objectKey)!.contentType).toBe(PNG);
    const s = enc(SVG_OK);
    const sr = (await worker.handle(
      job(tenant, { asset: await upload(objects, tenant, s), mime: SVG, size: s.length }),
    )) as AssetReady;
    expect(sr).toMatchObject({ mime: SVG, contentType: SVG });
    expect(sr.renditions[0]).toMatchObject({ role: 'print', mime: PDF });
    // The uploaded SVG text is stored nowhere; only the sanitised file and the PDF are.
    for (const o of mem.objects.values())
      expect(Buffer.from(o.body).includes(Buffer.from('inkscape'))).toBe(false);
  });

  it('keeps a Word file unchanged, under its own hash', async () => {
    const { worker, objects } = setup();
    const tenant = randomUUID();
    const d = docx();
    const r = (await worker.handle(
      job(tenant, { asset: await upload(objects, tenant, d), mime: DOCX, size: d.length }),
    )) as AssetReady;
    expect(r).toMatchObject({
      ok: true,
      mime: DOCX,
      contentType: DOCX,
      sha256: sha(d),
      bytes: d.length,
      renditions: [],
    });
  });
});

describe('the same bytes from two tenants (BE-043 criterion 7; SEC-037 criterion 2)', () => {
  it('give each tenant its own object under its own prefix', async () => {
    const { worker, objects } = setup();
    const mem = objects as MemoryAssetObjects;
    const a = randomUUID();
    const b = randomUUID();
    const bytes = jpegOf();
    const ra = (await worker.handle(
      job(a, { asset: await upload(objects, a, bytes), mime: JPEG, size: bytes.length }),
    )) as AssetReady;
    const rb = (await worker.handle(
      job(b, { asset: await upload(objects, b, bytes), mime: JPEG, size: bytes.length }),
    )) as AssetReady;
    expect(ra.sha256).toBe(rb.sha256);
    expect(ra.objectKey).toBe(`tenants/${a}/assets/${ra.sha256}`);
    expect(rb.objectKey).toBe(`tenants/${b}/assets/${rb.sha256}`);
    expect(mem.objects.has(ra.objectKey) && mem.objects.has(rb.objectKey)).toBe(true);
  });

  it('never overwrites an existing object: the second write of a hash is skipped', async () => {
    const { worker, objects } = setup();
    const mem = objects as MemoryAssetObjects;
    const t = randomUUID();
    const bytes = png();
    const first = (await worker.handle(
      job(t, { asset: await upload(objects, t, bytes), mime: PNG, size: bytes.length }),
    )) as AssetReady;
    mem.calls.length = 0;
    const second = (await worker.handle(
      job(t, { asset: await upload(objects, t, bytes), mime: PNG, size: bytes.length }),
    )) as AssetReady;
    expect(second.objectKey).toBe(first.objectKey);
    expect(mem.calls.filter((c) => c === `PUT ${first.objectKey}`)).toHaveLength(1);
    expect(mem.objects.get(first.objectKey)!.body.length).toBe(first.bytes);
  });
});

describe('a file that fails (BE-043 criterion 2; SEC-040 criterion 3)', () => {
  it('ends failed with asset.failed, its upload deleted and nothing stored, when the type does not match', async () => {
    const { worker, objects, events } = setup();
    const mem = objects as MemoryAssetObjects;
    const tenant = randomUUID();
    const html = enc('<html><script>alert(document.cookie)</script></html>');
    const asset = await upload(objects, tenant, html);
    const r = (await worker.handle(
      job(tenant, { asset, mime: PNG, size: html.length }),
    )) as AssetFailed;
    expect(r).toMatchObject({
      ok: false,
      tenant,
      asset,
      code: 'validation_failed',
      reason: 'type_mismatch',
    });
    expect(events).toEqual([r]);
    expect(mem.objects.size).toBe(0);
  });

  it('ends failed for a pixel bomb with the registry code too_large', async () => {
    const { worker, objects } = setup();
    const t = randomUUID();
    const bomb = pngPixelBomb(60_000, 60_000);
    const r = (await worker.handle(
      job(t, { asset: await upload(objects, t, bomb), mime: PNG, size: bomb.length }),
    )) as AssetFailed;
    expect(r).toMatchObject({ code: 'too_large', reason: 'pixel_limit' });
  });

  it('fails a missing upload, a size other than the declared one, and a declared type it does not accept', async () => {
    const { worker, objects } = setup();
    const t = randomUUID();
    expect(await worker.handle(job(t, { asset: randomUUID(), mime: PNG, size: 10 }))).toMatchObject(
      { reason: 'missing_upload' },
    );
    const bytes = png();
    expect(
      await worker.handle(
        job(t, { asset: await upload(objects, t, bytes), mime: PNG, size: bytes.length + 1 }),
      ),
    ).toMatchObject({
      reason: 'size_mismatch',
    });
    expect(
      await worker.handle(
        job(t, { asset: await upload(objects, t, bytes), mime: 'text/html', size: bytes.length }),
      ),
    ).toMatchObject({
      reason: 'unsupported_type',
    });
  });

  it('refuses a payload without an asset identifier, and a job without a tenant', async () => {
    const { worker } = setup();
    await expect(worker.handle(job(randomUUID(), { mime: PNG, size: 1 }))).rejects.toThrow(
      AssetJobError,
    );
    await expect(
      worker.handle({ tenant: 'x', id: '1', payload: { asset: randomUUID(), mime: PNG, size: 1 } }),
    ).rejects.toThrow(AssetJobError);
  });
});

/** A sandbox that answers with whatever `reply` builds. */
function forged(run: Partial<SandboxRun>): Sandbox {
  return {
    kind: 'podman',
    async run() {
      return {
        exitCode: 0,
        timedOut: false,
        outputOverflow: false,
        aborted: false,
        engineError: null,
        stdout: new Uint8Array(),
        stderr: '',
        wallMs: 1,
        ...run,
      };
    },
  };
}

const replyOf = (header: unknown, blobs: Uint8Array[] = []): Uint8Array =>
  encodeFrame(REPLY_MAGIC, header, blobs);

describe('a compromised or failing sandbox (BE-043 criterion 6; SEC-038 criterion 4; SEC-040 criterion 2)', () => {
  const pngHeader = (bytes: number) => ({
    v: 1,
    ok: true,
    detected: PNG,
    keepOriginal: false,
    outputs: [{ role: 'display', mime: PNG, bytes }],
    notes: [],
  });

  const cases: [string, Partial<SandboxRun>, string][] = [
    ['stopped at the time limit', { exitCode: null, timedOut: true }, 'resource_limit'],
    ['killed at the memory limit', { exitCode: 137 }, 'resource_limit'],
    ['stopped at the heap limit', { exitCode: 134 }, 'resource_limit'],
    ['crashed', { exitCode: 1 }, 'decode_failed'],
    ['flooded its output', { exitCode: null, outputOverflow: true }, 'output_limit'],
    ['answered nothing', { stdout: new Uint8Array() }, 'bad_reply'],
    [
      'answered HTML as a PNG',
      { stdout: replyOf(pngHeader(40), [enc('<html><script>alert(1)</script></html>  ')]) },
      'bad_reply',
    ],
    [
      'answered with a different type',
      { stdout: replyOf({ ...pngHeader(8), detected: JPEG }, [new Uint8Array(8)]) },
      'bad_reply',
    ],
    [
      'answered lengths that do not cover the body',
      { stdout: replyOf(pngHeader(4), [new Uint8Array(8)]) },
      'bad_reply',
    ],
    [
      'answered an SVG with a script',
      {
        stdout: replyOf(
          {
            v: 1,
            ok: true,
            detected: SVG,
            keepOriginal: false,
            outputs: [
              { role: 'display', mime: SVG, bytes: 67 },
              { role: 'print', mime: PDF, bytes: 21 },
            ],
            notes: [],
          },
          [
            enc(
              '<svg xmlns="http://www.w3.org/2000/svg" ><script>alert(1)</script></svg>'.slice(
                0,
                67,
              ),
            ),
            enc('%PDF-1.4\nx\n%%EOF\n'.padEnd(21, ' ')),
          ],
        ),
      },
      'bad_reply',
    ],
    [
      'answered an unknown failure reason',
      { stdout: replyOf({ v: 1, ok: false, reason: 'all_good', message: 'x' }) },
      'bad_reply',
    ],
  ];

  for (const [what, run, reason] of cases)
    it(`fails the asset when the sandbox ${what}`, async () => {
      const { worker, objects, events } = setup(forged(run));
      const mem = objects as MemoryAssetObjects;
      const t = randomUUID();
      const bytes = png();
      const asset = await upload(objects, t, bytes);
      const declared = what.includes('SVG') ? SVG : PNG;
      const input = declared === SVG ? enc(SVG_OK) : bytes;
      if (declared === SVG)
        await objects.put(assetKeys.quarantine(t, asset), input, { contentType: 'x' });
      const r = (await worker.handle(
        job(t, { asset, mime: declared, size: input.length }),
      )) as AssetFailed;
      expect(r).toMatchObject({ ok: false, reason });
      expect(events).toEqual([r]);
      expect(mem.objects.size).toBe(0); // nothing stored, the upload deleted
    });

  it('retries, and keeps the upload, when the container engine fails', async () => {
    const { worker, objects, events } = setup(
      forged({ exitCode: 125, engineError: 'no such image' }),
    );
    const t = randomUUID();
    const bytes = png();
    const asset = await upload(objects, t, bytes);
    const e = await worker
      .handle(job(t, { asset, mime: PNG, size: bytes.length }))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AssetJobError);
    expect((e as AssetJobError).retry).toBe(true);
    expect(events).toEqual([]);
    expect((objects as MemoryAssetObjects).objects.has(assetKeys.quarantine(t, asset))).toBe(true);
  });

  it('retries, and keeps the upload, when the object store fails', async () => {
    const inner = new MemoryAssetObjects();
    let failPuts = true;
    const flaky: AssetObjects = {
      get: (k, m) => inner.get(k, m),
      head: (k) => inner.head(k),
      delete: (k) => inner.delete(k),
      put: (k, b, o) =>
        failPuts && k.includes('/assets/')
          ? Promise.reject(new ObjectStoreUnavailable('down', 503))
          : inner.put(k, b, o),
    };
    const { worker, events } = setup(unsandboxed(), flaky);
    const t = randomUUID();
    const bytes = png();
    const asset = await upload(flaky, t, bytes);
    const e = await worker
      .handle(job(t, { asset, mime: PNG, size: bytes.length }))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AssetJobError);
    expect((e as AssetJobError).retry).toBe(true);
    expect(events).toEqual([]);
    expect(inner.objects.has(assetKeys.quarantine(t, asset))).toBe(true);
    failPuts = false;
    expect((await worker.handle(job(t, { asset, mime: PNG, size: bytes.length }))).ok).toBe(true);
  });
});
