// EXP-109 criteria 2 and 5 over the import job: an identifier of a removed region is not reused, and
// content over a limit of I7 fails the import as a whole, naming the limit, with nothing stored.
// The first case uses the real importer of packages/export-docx (imported by its source path, as in
// exp-098-real-importer.test.ts) on a package with 501 editable ranges; the second a stand-in
// importer that returns the region of the document again after an import has removed it.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  entryData,
  importDocx,
  readZip,
  writeZip,
} from '../../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from '../../src/control-plane/imports.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The package of `poi/footnotes.docx` with a body of `n` paragraphs, each an editable range. */
function withRanges(n: number): Uint8Array {
  const bytes = readFile(corpusFiles().find((f) => f.name === 'poi/footnotes.docx')!);
  const zip = readZip(bytes);
  const body = Array.from(
    { length: n },
    (_, i) =>
      `<w:p><w:permStart w:id="${i}" w:edGrp="everyone"/><w:r><w:t>r${i}</w:t></w:r><w:permEnd w:id="${i}"/></w:p>`,
  ).join('');
  return writeZip(
    zip.entries.map((e) => {
      if (e.name !== 'word/document.xml') return { name: e.name, copyOf: e, from: zip };
      const xml = new TextDecoder().decode(entryData(zip, e));
      const next = xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`);
      return { name: e.name, data: new TextEncoder().encode(next), like: e };
    }),
  );
}

describe('import checks of EXP-109 over the job (memory, real data plane)', () => {
  let h: Harness;
  const real = withRanges(501);
  /** A stand-in importer for the bytes the real one does not take: the text of the bytes, or the region. */
  const importer: DocxImporter = async (bytes) => {
    if (bytes[0] === 0x50)
      return importDocx(bytes).then((r) => ({ envelope: r.envelope, warnings: r.warnings }));
    const text = new TextDecoder().decode(bytes);
    const c = JSON.parse(JSON.stringify(documentWithRegions())) as {
      doc: { content: Array<{ content: Array<Record<string, unknown>> }> };
    };
    // With the text `again`, the document's own region comes back; otherwise a body of one paragraph.
    if (text !== 'again')
      c.doc.content[1]!.content = [
        {
          type: 'paragraph',
          attrs: { id: 'pImport000000001', style: 'Normal' },
          content: [{ type: 'text', text }],
        },
      ];
    return { envelope: c, warnings: [] };
  };

  beforeAll(async () => {
    h = await startHarness('memory', {
      importer,
      realDataPlane: true,
      config: { jobIdleMs: 20, jobLeaseMs: 20_000 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  /** Runs an import of `bytes` into `doc`; returns the settled job. */
  async function run(doc: string, bytes: Uint8Array): Promise<Record<string, unknown>> {
    const asset = uuid7();
    const sha = await h.service.assets.putFinal(h.tenant, bytes, DOCX_CONTENT_TYPE);
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id: asset,
        doc,
        filename: 'draft.docx',
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
    return last;
  }

  const seqOf = async (doc: string): Promise<number> =>
    (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).json.seq as number;

  it('fails an import with more than 500 regions as a whole, names the limit and stores nothing (criterion 5)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const before = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const job = await run(doc, real);
    expect(job['state']).toBe('failed');
    const error = job['error'] as { code?: string; message?: string; detail?: string };
    expect(JSON.stringify(error)).toMatch(/more than 500/);
    expect(JSON.stringify(error)).toMatch(/too_many_regions/);
    const after = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    expect(after.json.seq).toBe(before.json.seq);
    expect(JSON.stringify(after.json.doc)).toBe(JSON.stringify(before.json.doc));
  });

  it('refuses an import that brings back the identifier of a region an earlier import removed (criterion 2)', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const first = await run(doc, new TextEncoder().encode('first'));
    expect(first['state']).toBe('completed');
    const seq = await seqOf(doc);
    expect(seq).toBeGreaterThan(0);
    const second = await run(doc, new TextEncoder().encode('again'));
    expect(second['state']).toBe('failed');
    expect(JSON.stringify(second['error'])).toMatch(/breaks the model/);
    expect(await seqOf(doc)).toBe(seq);
    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    expect(JSON.stringify(content.json.doc)).toContain('first');
  });
});
