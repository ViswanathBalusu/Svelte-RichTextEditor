// EXP-098 with the real importer of packages/export-docx: a Word file of the corpus goes through
// the whole route, job, checks and snapshot commit. The package is imported by its source path
// (this service does not depend on it), as other tests of this folder import fixtures of packages.
// Runs in memory with the real data plane.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDocx } from '../../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from '../../src/control-plane/imports.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('import job with the real Word importer (memory)', () => {
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

  /** Runs the import of a corpus file into a new document that lists 
equires; returns the job. */
  async function run(
    name: string,
    requires: 'those of the file' | 'none',
  ): Promise<{ doc: string; job: Record<string, unknown> }> {
    const file = corpusFiles().find((f) => f.name === name);
    if (!file) throw new Error('missing corpus file ' + name);
    const bytes = readFile(file);
    const probe = await importDocx(bytes);
    const doc = await h.createDocument({
      content: {
        ...documentWithRegions(),
        requires: requires === 'none' ? [] : probe.envelope.requires,
      },
    });
    const asset = uuid7();
    const sha = await h.service.assets.putFinal(h.tenant, bytes, DOCX_CONTENT_TYPE);
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id: asset,
        doc,
        filename: 'sample.docx',
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
    return { doc, job: last };
  }

  it('stores the import of poi/sample.docx and reports its warnings', async () => {
    const { doc, job } = await run('poi/sample.docx', 'those of the file');
    expect(job['error'] ?? null).toBeNull();
    expect(job['state']).toBe('completed');
    expect(Array.isArray(job['warnings'])).toBe(true);
    const content = await h.call('GET', '/v1/documents/' + doc + '/content', { token: h.apiKey });
    const stored = JSON.stringify(content.json.doc);
    // The fixture's own text is gone and the file's content is there.
    expect(stored).not.toContain('Liability');
    expect(stored).toContain('"type":"style_def"');
    expect(content.json.seq).toBeGreaterThan(0);
  });

  it('fails the job, and stores nothing, when the document lacks a feature the import needs', async () => {
    const { doc, job } = await run('poi/sample.docx', 'none');
    expect(job['state']).toBe('failed');
    // The room refuses the snapshot (I1): the document does not list the preserve feature.
    expect(job['error']).toMatchObject({ code: 'validation_failed' });
    expect(JSON.stringify(job['error'])).toContain('preserve');
    const content = await h.call('GET', '/v1/documents/' + doc + '/content', { token: h.apiKey });
    expect(JSON.stringify(content.json.doc)).toContain('Liability');
  });
});
