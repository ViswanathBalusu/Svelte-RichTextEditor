// FRW-045 on the service (lane w4, 2026-11-18): a signature or initials image adopted by a
// participant goes through the real asset worker like any other upload, cannot be used until it is
// ready, is refused with the worker's reason when it failed, belongs to the participant and the
// document, and its hash is computed by the service from the stored bytes. Memory storage, the asset
// worker in process (unsandboxed, tests only). The adoption screen (criteria 1, 4 and 6) is the
// editor's and is not tested here. docs/adr/0396-w4-FRW-045-signature-adoption.md (proposed).
import { createHash } from 'node:crypto';
import { unsandboxed } from '@docedit/asset-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { adoptSignature } from '../../src/workflow/signature-adoption.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('adopting a signature image (FRW-045)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', {
      views: FULL_VIEWS,
      assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
      config: { jobIdleMs: 20 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  const deps = () => ({ assets: h.parts.assetRegistry, objects: h.parts.objects });
  const surrogateOf = async (sub: string) => (await h.parts.users.resolve(h.tenant, sub)).surrogate;

  async function upload(doc: string, sub: string, bytes: Buffer, mime = 'image/png') {
    const token = h.userToken({ [doc]: 'filler' }, { sub });
    const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
      token,
      body: { filename: 'signature.png', mime, size: bytes.length },
    });
    expect(r.status, r.text).toBe(201);
    const id = r.json.asset as string;
    await h.service.assets.putQuarantined(h.tenant, id, bytes);
    return { id, token };
  }
  async function settle(id: string) {
    let row = await h.parts.assetRegistry.get(h.tenant, id);
    for (let i = 0; i < 200 && row?.state !== 'ready' && row?.state !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      row = await h.parts.assetRegistry.get(h.tenant, id);
    }
    return row;
  }

  it('cannot use the image until asset.ready, then answers the value and the hash of the stored bytes (criteria 2 and 3, the service half)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const actor = await surrogateOf('signer-045');
    const { id, token } = await upload(doc, 'signer-045', PNG);
    const ask = (mode: unknown = 'uploaded', asset: unknown = id) =>
      adoptSignature(deps(), { tenant: h.tenant, doc, actor, asset, mode });

    // Quarantined: not usable yet.
    expect(await ask()).toEqual({
      ok: false,
      problem: { code: 'not_ready', state: 'quarantined' },
    });
    // Queued for the worker: still not usable until the worker has settled it.
    expect((await h.call('POST', `/v1/assets/${id}/complete`, { token })).status).toBe(202);
    const row = await settle(id);
    expect(row?.state).toBe('ready');

    for (const mode of ['typed', 'drawn', 'uploaded'] as const) {
      const out = await ask(mode);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) continue;
      expect(out.adoption.value).toEqual({ asset: id, mode });
      // The hash is that of the bytes the worker stored, computed here, not a value of the request.
      const stored = Buffer.from((await h.parts.objects.get(row!.objectKey!))!);
      expect(out.adoption.imageHash).toBe(createHash('sha256').update(stored).digest('hex'));
      expect(out.adoption.imageHash).toBe(row!.sha256);
    }

    // The mode and the identifier are checked.
    expect(await ask('scribbled')).toMatchObject({
      ok: false,
      problem: { code: 'validation_failed', path: '/mode' },
    });
    expect(await ask('typed', 'not-an-id')).toMatchObject({
      ok: false,
      problem: { code: 'validation_failed', path: '/asset' },
    });
  });

  it('refuses an image that failed, with the worker’s reason (criterion 2)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const actor = await surrogateOf('signer-045-failed');
    // The declared type is not the content's type: the worker fails the asset.
    const { id, token } = await upload(doc, 'signer-045-failed', PNG, 'image/jpeg');
    expect((await h.call('POST', `/v1/assets/${id}/complete`, { token })).status).toBe(202);
    const row = await settle(id);
    expect(row?.state).toBe('failed');
    const out = await adoptSignature(deps(), {
      tenant: h.tenant,
      doc,
      actor,
      asset: id,
      mode: 'uploaded',
    });
    expect(out).toEqual({ ok: false, problem: { code: 'failed', reason: row!.failure!.reason } });
    expect(row!.failure!.reason.length).toBeGreaterThan(0);
  });

  it('is the participant’s own image, of this document, and an image', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const other = await h.createDocument({ content: documentWithRegions() });
    const mine = await surrogateOf('signer-045-own');
    const { id, token } = await upload(doc, 'signer-045-own', PNG);
    expect((await h.call('POST', `/v1/assets/${id}/complete`, { token })).status).toBe(202);
    expect((await settle(id))?.state).toBe('ready');
    const base = { tenant: h.tenant, asset: id, mode: 'uploaded' };
    // Another participant of the same document may not use it.
    expect(
      await adoptSignature(deps(), {
        ...base,
        doc,
        actor: await surrogateOf('someone-else-045'),
      }),
    ).toEqual({ ok: false, problem: { code: 'forbidden' } });
    // Another document does not know it.
    expect(await adoptSignature(deps(), { ...base, doc: other, actor: mine })).toEqual({
      ok: false,
      problem: { code: 'not_found' },
    });
    // A guessed identifier answers as an absent asset does.
    expect(
      await adoptSignature(deps(), {
        ...base,
        asset: '0190c9d8-0000-7000-8000-000000000000',
        doc,
        actor: mine,
      }),
    ).toEqual({ ok: false, problem: { code: 'not_found' } });
    expect((await adoptSignature(deps(), { ...base, doc, actor: mine })).ok).toBe(true);
  });
});
