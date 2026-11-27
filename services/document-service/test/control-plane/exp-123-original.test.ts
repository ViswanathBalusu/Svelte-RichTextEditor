// EXP-123 criterion 3 and EXP-090 criterion 5, the control plane's part: a `docx` export of a document
// imported from Word names the original file, its source map and its fragments in the job only for a
// full export (a manager who asks for it, or a service). Every other requester's job names none of
// them, so the original is neither patched nor offered (ADR 0017; ADR 0019; SR-C1). Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { MemoryAssetRegistry } from '../../src/control-plane/assets.ts';
import { preservationAssets } from '../../src/control-plane/export-routes.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import {
  DOCX_CONTENT_TYPE,
  FRAGMENT_CONTENT_TYPE,
  SOURCE_MAP_CONTENT_TYPE,
} from '../../src/control-plane/imports.ts';
import type { Kit } from '../../src/control-plane/kit.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const sha = (c: string): string => c.repeat(64);

/** Registers a ready asset of a document, as an import does. */
async function ready(
  registry: MemoryAssetRegistry,
  tenant: string,
  doc: string,
  type: string,
  hash: string,
  at: number,
): Promise<string> {
  const id = uuid7();
  await registry.create(
    tenant,
    { id, doc, filename: null, mime: type, declaredBytes: 3, createdBy: 'u', uploadExpiresAt: 9 },
    at,
  );
  await registry.settleReady(
    tenant,
    id,
    {
      sha256: hash,
      bytes: 3,
      contentType: type,
      objectKey: `k/${id}`,
      width: null,
      height: null,
      frames: null,
      renditions: [],
    },
    at + 1,
  );
  return id;
}

describe('EXP-123 criterion 3: what a patching export is given', () => {
  it('names the newest original and source map and every fragment of the document', async () => {
    const r = new MemoryAssetRegistry();
    const tenant = uuid7();
    const doc = uuid7();
    await ready(r, tenant, doc, DOCX_CONTENT_TYPE, sha('1'), 10);
    const original = await ready(r, tenant, doc, DOCX_CONTENT_TYPE, sha('2'), 20);
    await ready(r, tenant, doc, SOURCE_MAP_CONTENT_TYPE, sha('3'), 10);
    await ready(r, tenant, doc, SOURCE_MAP_CONTENT_TYPE, sha('4'), 20);
    const fragment = await ready(r, tenant, doc, FRAGMENT_CONTENT_TYPE, sha('5'), 20);
    await ready(r, tenant, doc, 'image/png', sha('6'), 20);
    await ready(r, tenant, uuid7(), DOCX_CONTENT_TYPE, sha('7'), 30);
    const d = { assetRegistry: r } as unknown as Kit['d'];
    expect(original).toBeTypeOf('string');
    expect(await preservationAssets(d, tenant, doc)).toEqual({
      original: { sha256: sha('2'), mediaType: DOCX_CONTENT_TYPE },
      sourceMap: { sha256: sha('4'), mediaType: SOURCE_MAP_CONTENT_TYPE },
      fragments: { [fragment]: { sha256: sha('5'), mediaType: FRAGMENT_CONTENT_TYPE } },
    });
  });

  it('names nothing for a document that was not imported', async () => {
    const r = new MemoryAssetRegistry();
    const tenant = uuid7();
    const doc = uuid7();
    await ready(r, tenant, doc, 'image/png', sha('1'), 10);
    const d = { assetRegistry: r } as unknown as Kit['d'];
    expect(await preservationAssets(d, tenant, doc)).toBeNull();
  });
});

for (const storage of ['memory'] as Storage[]) {
  describe(`a docx export of an imported document (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const payloads = new Map<string, Record<string, unknown>>();
    const exportHandler: JobHandler = async (job, ctx) => {
      payloads.set(job.id, job.payload);
      await ctx.report('converting', 10);
      await h.service.assets.putExport(
        job.tenant,
        job.id,
        'output.docx',
        Buffer.from('PK test'),
        DOCX_CONTENT_TYPE,
      );
      return {
        output: 'output.docx',
        pages: null,
        layout: null,
        converged: null,
        log: null,
        diagnostics: [],
      };
    };
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000, exportTargets: ['pdf', 'docx'] },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    async function completed(token: string, job: string): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const r = await h.call('GET', `/v1/exports/${job}`, { token });
        if (r.json?.state === 'completed') return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`job ${job} did not complete`);
    }

    it.skipIf(skip)(
      'gives the original, the source map and the fragments to a full export and to no other',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const registry = h.parts.assetRegistry as MemoryAssetRegistry;
        await ready(registry, h.tenant, doc, DOCX_CONTENT_TYPE, sha('a'), 10);
        await ready(registry, h.tenant, doc, SOURCE_MAP_CONTENT_TYPE, sha('b'), 10);
        const fragment = await ready(registry, h.tenant, doc, FRAGMENT_CONTENT_TYPE, sha('c'), 10);
        const owner = h.userToken({ [doc]: 'owner' });
        const editor = h.userToken({ [doc]: 'editor' });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const post = (token: string, options?: Record<string, unknown>) =>
          h.call('POST', `/v1/documents/${doc}/exports`, {
            token,
            body: options ? { target: 'docx', options } : { target: 'docx' },
          });

        const full = await post(owner, { full: true });
        expect(full.status).toBe(202);
        await completed(owner, full.json.id);
        expect(payloads.get(full.json.id)).toMatchObject({
          full: true,
          preservation: {
            original: { sha256: sha('a') },
            sourceMap: { sha256: sha('b') },
            fragments: { [fragment]: { sha256: sha('c') } },
          },
        });

        // A manager who does not ask for everything, an editor and a viewer: nothing about the original.
        // (A different locale for each, so that no request is answered by another's cached result.)
        const locales = ['en-GB', 'de-DE', 'fr-FR'];
        for (const [i, token] of [owner, editor, viewer].entries()) {
          const r = await post(token, { locale: locales[i]! });
          expect(r.status).toBe(202);
          await completed(token, r.json.id);
          const payload = payloads.get(r.json.id)!;
          expect(payload['full']).toBe(false);
          expect(payload).not.toHaveProperty('preservation');
          expect(JSON.stringify(payload)).not.toContain(sha('a'));
          expect(JSON.stringify(payload)).not.toContain(sha('b'));
          expect(JSON.stringify(payload)).not.toContain(sha('c'));
        }

        // The full request is a request of its own: a cached projected result does not answer it.
        const again = await post(owner, { full: true });
        expect(again.status).toBe(202);
      },
    );

    it.skipIf(skip)(
      'never lists the source map or the fragments of an import to a reader',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const registry = h.parts.assetRegistry as MemoryAssetRegistry;
        const map = await ready(registry, h.tenant, doc, SOURCE_MAP_CONTENT_TYPE, sha('d'), 10);
        const frag = await ready(registry, h.tenant, doc, FRAGMENT_CONTENT_TYPE, sha('e'), 10);
        const owner = h.userToken({ [doc]: 'owner' });
        const r = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
          token: owner,
          body: { assets: [map, frag] },
        });
        const served = ((r.json?.assets ?? []) as Array<{ asset: string }>).map((a) => a.asset);
        expect(served).not.toContain(map);
      },
    );
  });
}
