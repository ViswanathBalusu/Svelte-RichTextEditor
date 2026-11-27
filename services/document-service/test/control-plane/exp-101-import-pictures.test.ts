// EXP-101 criterion 3: the pictures of a Word file go through the asset worker, which decodes and
// re-encodes them, and are attached to the document with their alternative text. The real importer
// of packages/export-docx (imported by its source path, as exp-098-real-importer.test.ts does)
// runs through the import route and job on the memory store with the real data plane. The asset
// worker is the real one, run in this process without its Podman sandbox (`unsandboxed()`, tests
// only); the sandbox's own checks are those of services/asset-worker. Test values only.
import { unsandboxed } from '@docedit/asset-worker';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDocx } from '../../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from '../../src/control-plane/imports.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The importer of the real package, with the pictures, fragments and fallbacks it makes. */
const importer: DocxImporter = async (bytes) => {
  const r = await importDocx(bytes);
  return {
    envelope: r.envelope,
    warnings: r.warnings,
    assets: r.assets
      .all()
      .filter((a) => a.role !== 'original' && a.role !== 'source-map')
      .map((a) => ({ id: a.id, bytes: a.bytes, contentType: a.contentType })),
  };
};

/** A Word file whose picture is not a picture, to show that a refused picture fails the import. */
const badPicture: DocxImporter = async (bytes) => {
  const r = await importDocx(bytes);
  const first = r.assets.all().find((a) => a.role === 'image' && a.contentType === 'image/png');
  return {
    envelope: r.envelope,
    warnings: r.warnings,
    assets: [
      ...r.assets
        .all()
        .filter((a) => a.role !== 'original' && a.role !== 'source-map' && a !== first)
        .map((a) => ({ id: a.id, bytes: a.bytes, contentType: a.contentType })),
      ...(first
        ? [
            {
              id: first.id,
              bytes: new TextEncoder().encode('this is not a PNG file'),
              contentType: 'image/png',
            },
          ]
        : []),
    ],
  };
};

interface Imported {
  doc: string;
  /** The seq of the document's content before the import was requested. */
  before: number;
  job: Record<string, unknown>;
}

function suite(title: string, make: () => DocxImporter) {
  describe(title, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness('memory', {
        importer: make(),
        realDataPlane: true,
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        config: { jobIdleMs: 20, jobLeaseMs: 20_000 },
      });
    });
    afterAll(async () => {
      await h?.close();
    });

    async function run(name: string): Promise<Imported> {
      const file = corpusFiles().find((f) => f.name === name);
      if (!file) throw new Error('missing corpus file ' + name);
      const bytes = readFile(file);
      const probe = await importDocx(bytes);
      const doc = await h.createDocument({
        content: { ...documentWithRegions(), requires: probe.envelope.requires },
      });
      const before = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).json
        .seq as number;
      const asset = uuid7();
      const sha = await h.service.assets.putFinal(h.tenant, bytes, DOCX_CONTENT_TYPE);
      await h.parts.assetRegistry.create(
        h.tenant,
        {
          id: asset,
          doc,
          filename: 'file.docx',
          mime: DOCX_CONTENT_TYPE,
          declaredBytes: bytes.length,
          createdBy: 'system',
          uploadExpiresAt: h.now() + 60_000,
        },
        h.now(),
      );
      await h.parts.assetRegistry.settleReady(
        h.tenant,
        asset,
        {
          sha256: sha,
          bytes: bytes.length,
          contentType: DOCX_CONTENT_TYPE,
          objectKey: `test/${asset}`,
          width: null,
          height: null,
          frames: null,
          renditions: [],
        },
        h.now(),
      );
      const accepted = await h.call('POST', `/v1/documents/${doc}/imports`, {
        token: h.apiKey,
        body: { asset, format: 'docx' },
      });
      expect(accepted.status).toBe(202);
      let last: Record<string, unknown> = {};
      for (let i = 0; i < 600 && last['state'] !== 'completed' && last['state'] !== 'failed'; i++) {
        last = (await h.call('GET', `/v1/imports/${accepted.json.id}`, { token: h.apiKey })).json;
        await sleep(25);
      }
      return { doc, job: last, before };
    }

    it('runs a PNG and a JPEG through the asset worker and keeps the alt text', async () => {
      if (!title.includes('real importer')) return;
      const { doc, job } = await run('poi/VariousPictures.docx');
      expect(job['error'] ?? null).toBeNull();
      expect(job['state']).toBe('completed');
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const images: Array<{ asset: string; alt?: string }> = [];
      const walk = (n: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
        if (n.type === 'image' || n.type === 'figure')
          images.push(n.attrs as { asset: string; alt?: string });
        for (const c of (n.content ?? []) as Array<typeof n>) walk(c);
      };
      walk(content.json.doc as never);
      // The alternative text of the file's own drawing properties arrives with each picture.
      expect(images.map((i) => i.alt)).toEqual(
        expect.arrayContaining(['tomcat.png', 'clock.jpg', 'santa.wmf', 'wrench.emf']),
      );
      const ready = await h.parts.assetRegistry.readyFor(h.tenant, doc);
      const byType = (t: string) => ready.filter((a) => a.contentType === t);
      // The worker decoded the PNG and the JPEG: it recorded their size, which the raw path does
      // not, and the object under the recorded hash is the file it wrote.
      for (const a of [...byType('image/png'), ...byType('image/jpeg')]) {
        expect(a.width, a.id).toBeGreaterThan(0);
        expect(a.height, a.id).toBeGreaterThan(0);
        const stored = await h.service.assets.getFinal(h.tenant, a.sha256 ?? '');
        expect(stored, a.id).not.toBeNull();
      }
      expect(byType('image/png').length).toBeGreaterThan(0);
      expect(byType('image/jpeg').length).toBeGreaterThan(0);
      // A type the worker does not take (Windows metafiles) is kept as brought, as before.
      const metafiles = ready.filter((a) => /x-(wmf|emf)/.test(a.contentType ?? ''));
      expect(metafiles.length).toBeGreaterThan(0);
      for (const a of metafiles) expect(a.width).toBeNull();
      // Each is attached to the document from the import commit on.
      for (const i of images) expect(ready.map((a) => a.id)).toContain(i.asset);
    });

    it('fails the job, and stores no content, when the worker refuses a picture', async () => {
      if (!title.includes('refused picture')) return;
      const { doc, job, before } = await run('poi/VariousPictures.docx');
      expect(job['state']).toBe('failed');
      expect(job['error']).toMatchObject({ code: 'validation_failed' });
      expect(JSON.stringify(job['error'])).toContain('a picture of the Word file was refused');
      // Nothing was stored: the document still holds the content it had. The pictures that were
      // registered before the refusal stay unattached until the orphan sweep takes them, as for any
      // other failure of the job (the registry removes only an upload nobody completed).
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      expect(content.json.seq).toBe(before);
    });
  });
}

suite('EXP-101 pictures of an import through the asset worker (real importer)', () => importer);
suite('EXP-101 pictures of an import through the asset worker (refused picture)', () => badPicture);
