// EXP-104 through the import route: a Word file with editable ranges is imported by a service
// credential, the ranges become regions in the stored content, the regions have no grants and
// policy `inherit` (or `restricted` for a locked one), and the file creates no grants by itself.
// The package is imported by its source path, as exp-098-real-importer.test.ts does. The file is
// the package of `poi/sample.docx` (which keeps no preserved fragments as assets, so the route
// can store it) with a body written here.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  entryData,
  importDocx,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from '../../src/control-plane/imports.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const enc = new TextEncoder();

const p = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/** The package of poi/sample.docx with `body` as the content of w:body (the final sectPr is kept). */
function docx(body: string): Uint8Array {
  const file = corpusFiles().find((f) => f.name === 'poi/sample.docx')!;
  const zip = readZip(readFile(file));
  const xml = new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
  const open = xml.indexOf('<w:body>') + '<w:body>'.length;
  const sect = xml.lastIndexOf('<w:sectPr');
  const next = xml.slice(0, open) + body + xml.slice(sect);
  const entries: ZipWriteEntry[] = zip.entries.map((e) =>
    e.name === 'word/document.xml'
      ? { name: e.name, data: enc.encode(next), like: e }
      : { name: e.name, copyOf: e, from: zip },
  );
  return writeZip(entries);
}

describe('EXP-104 import of editable ranges through the route (memory, real importer)', () => {
  let h: Harness;
  const importer: DocxImporter = async (bytes) => {
    const r = await importDocx(bytes);
    return { envelope: r.envelope, warnings: r.warnings };
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

  async function upload(doc: string, bytes: Uint8Array): Promise<string> {
    const asset = uuid7();
    const sha = await h.service.assets.putFinal(h.tenant, bytes, DOCX_CONTENT_TYPE);
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id: asset,
        doc,
        filename: 'protected.docx',
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
    return asset;
  }

  async function finished(id: string): Promise<Record<string, unknown>> {
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 600 && last['state'] !== 'completed' && last['state'] !== 'failed'; i++) {
      last = (await h.call('GET', `/v1/imports/${id}`, { token: h.apiKey })).json;
      await sleep(25);
    }
    return last;
  }

  it('stores the regions, creates no grants, and reports the locked range with its location', async () => {
    const bytes = docx(
      p('before') +
        '<w:permStart w:id="1" w:edGrp="everyone"/>' +
        p('open block') +
        '<w:permEnd w:id="1"/>' +
        '<w:p><w:r><w:t>half </w:t></w:r><w:permStart w:id="2" w:edGrp="everyone"/><w:r><w:t>open</w:t></w:r><w:permEnd w:id="2"/></w:p>' +
        p('after'),
    );
    const doc = await h.createDocument({
      content: { ...documentWithRegions(), requires: (await importDocx(bytes)).envelope.requires },
    });
    const grantsBefore = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
    const accepted = await h.call('POST', `/v1/documents/${doc}/imports`, {
      token: h.apiKey,
      body: { asset: await upload(doc, bytes), format: 'docx' },
    });
    expect(accepted.status).toBe(202);
    const job = await finished(String(accepted.json.id));
    expect(job['error'] ?? null).toBeNull();
    expect(job['state']).toBe('completed');
    // The report names the locked range and its place.
    const warnings = (job['warnings'] as Array<{ message: string }>).map((w) => w.message);
    expect(warnings.some((w) => w.includes('editable range 2') && w.includes('body block'))).toBe(
      true,
    );

    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const body = (
      content.json.doc as { content: Array<{ type: string; content: unknown[] }> }
    ).content.find((n) => n.type === 'body')!.content as Array<{
      type: string;
      attrs?: Record<string, unknown>;
    }>;
    const regions = body.filter((n) => n.type === 'region');
    expect(regions.map((r) => r.attrs?.['policy'] ?? 'inherit')).toEqual(['inherit', 'restricted']);

    // No grants were made by the file, and the document's grants are the ones it had.
    const grantsAfter = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
    expect(grantsAfter.json).toEqual(grantsBefore.json);
  });

  it('refuses the request from a user token: the import is a service-credential operation', async () => {
    const bytes = docx(p('a'));
    const doc = await h.createDocument({ content: documentWithRegions() });
    const asset = await upload(doc, bytes);
    const refused = await h.call('POST', `/v1/documents/${doc}/imports`, {
      token: h.userToken({ [doc]: 'owner' }),
      body: { asset, format: 'docx' },
    });
    expect(refused.status).toBe(403);
  });
});
