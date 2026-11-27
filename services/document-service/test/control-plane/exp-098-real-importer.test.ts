// EXP-098 with the real importer of packages/export-docx: a Word file of the corpus goes through
// the whole route, job, checks and snapshot commit. The package is imported by its source path
// (this service does not depend on it), as other tests of this folder import fixtures of packages.
// Runs in memory with the real data plane.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDocx, preservationReport } from '../../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from '../../src/control-plane/imports.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('import job with the real Word importer (memory)', () => {
  let h: Harness;
  const importer: DocxImporter = async (bytes) => {
    const r = await importDocx(bytes);
    // EXP-116 criterion 5: the share of preserved nodes and the size overhead, from the same import.
    return {
      envelope: r.envelope,
      warnings: r.warnings,
      preservation: { ...(await preservationReport(bytes, r)) },
      // The pictures, fragments and fallbacks the content names; the original file is the upload.
      assets: r.assets
        .all()
        .filter((a) => a.role !== 'original' && a.role !== 'source-map')
        .map((a) => ({ id: a.id, bytes: a.bytes, contentType: a.contentType })),
    };
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

  it('reports the share of preserved nodes and the size overhead of the corpus files that complete (EXP-116)', async () => {
    const names = corpusFiles().map((f) => f.name);
    const skipped: string[] = [];
    let done = 0;
    let negative = 0;
    for (const name of names) {
      const { job } = await run(name, 'those of the file');
      if (job['state'] !== 'completed') {
        skipped.push(name + ' ' + JSON.stringify(job['error']));
        continue;
      }
      done++;
      const p = job['preservation'] as Record<string, number | null>;
      expect(p, name).toBeDefined();
      expect(p['nodes']).toBeGreaterThan(0);
      expect(p['nodesWithPreserved']).toBeGreaterThan(0);
      expect(p['share']).toBeCloseTo(p['nodesWithPreserved']! / p['nodes']!, 10);
      expect(p['share']).toBeGreaterThan(0);
      expect(p['share']).toBeLessThanOrEqual(1);
      // The overhead is the difference to an import without preservation. It is usually positive
      // (preserved data costs bytes) but not always: a few files import smaller with it.
      expect(p['overheadBytes']).toBe(p['bytes']! - p['baselineBytes']!);
      if (p['overheadBytes']! < 0) negative++;
      expect(p['overhead']).toBeCloseTo(p['overheadBytes']! / p['baselineBytes']!, 10);
    }
    // The job stores the pictures, fragments and fallbacks the importer makes, so every file of the
    // corpus completes and reports.
    expect(skipped, 'files the job refused').toEqual([]);
    expect(done, 'files imported through the job').toBe(names.length);
    console.log(
      'EXP-116 corpus through the job: ' +
        done +
        ' of ' +
        names.length +
        ', negative overhead: ' +
        negative,
    );
  }, 300_000);

  // UX-107 turned requires growth on in the document service (03 §11.1; CDM-047): a snapshot that
  // needs a feature the document does not list is accepted when every attached client announced the
  // feature, and no client is attached to an import. Before, the room refused it (I1).
  it('adds the feature the import needs to the document when no attached client lacks it', async () => {
    const { doc, job } = await run('poi/sample.docx', 'none');
    expect(job['error'] ?? null).toBeNull();
    expect(job['state']).toBe('completed');
    const content = await h.call('GET', '/v1/documents/' + doc + '/content', { token: h.apiKey });
    const stored = JSON.stringify(content.json);
    expect(stored).not.toContain('Liability');
    expect(stored).toContain('"preserve"');
  });
});
