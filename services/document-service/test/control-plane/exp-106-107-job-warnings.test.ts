// EXP-106 criterion 3 and EXP-107 criterion 4: the result of an import job names each substituted
// font family once, with the family that replaced it, and carries the report of what the import
// dropped, approximated or preserved, so that the host can show both to the importing user. The
// importer is the real one of packages/export-docx, joined to the job by `jobWarnings`. Memory
// stores and the real data plane; the same route as exp-098-real-importer.test.ts.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDocx, jobWarnings } from '../../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from '../../src/control-plane/imports.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('import job warnings: font substitutions and the report (memory)', () => {
  let h: Harness;
  const importer: DocxImporter = async (bytes) => {
    const r = await importDocx(bytes);
    return { envelope: r.envelope, warnings: jobWarnings(r) };
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

  async function run(name: string): Promise<Record<string, unknown>> {
    const file = corpusFiles().find((f) => f.name === name);
    if (!file) throw new Error('missing corpus file ' + name);
    const bytes = readFile(file);
    const probe = await importDocx(bytes);
    const doc = await h.createDocument({
      content: { ...documentWithRegions(), requires: probe.envelope.requires },
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
    return last;
  }

  type Line = Record<string, unknown>;

  it('names a family without a substitute once, with the default that replaces it and the reflow warning', async () => {
    // Tahoma has no metric-compatible substitute. (Aptos files of the corpus carry drawings, whose
    // assets the job does not yet attach: they fail I4 here; the Aptos case is in packages/export-docx.)
    const job = await run('poi/FieldCodes.docx');
    expect(job['error'] ?? null).toBeNull();
    expect(job['state']).toBe('completed');
    const fonts = (job['warnings'] as Line[]).filter((w) => w['kind'] === 'font substitution');
    const tahoma = fonts.filter((w) => w['from'] === 'Tahoma');
    expect(tahoma).toHaveLength(1);
    expect(tahoma[0]).toMatchObject({
      to: 'Liberation Sans',
      source: 'default',
      reflow: true,
      action: 'approximated',
    });
    expect(String(tahoma[0]!['message'])).toContain('the document will reflow');
    const from = fonts.map((w) => String(w['from']).toLowerCase());
    expect(new Set(from).size).toBe(from.length);
  });
  it('maps Calibri to Carlito in the job result', async () => {
    const job = await run('poi/sample.docx');
    expect(job['state']).toBe('completed');
    const calibri = (job['warnings'] as Line[]).find(
      (w) => w['kind'] === 'font substitution' && w['from'] === 'Calibri',
    );
    expect(calibri).toMatchObject({ to: 'Carlito', source: 'builtin', reflow: false });
  });

  it('carries the report lines of what the import left out or kept, with counts and blocks', async () => {
    const job = await run('poi/FieldCodes.docx');
    expect(job['state']).toBe('completed');
    const lines = (job['warnings'] as Line[]).filter(
      (w) => w['kind'] !== 'font substitution' && typeof w['count'] === 'number',
    );
    const field = lines.find((w) => w['kind'] === 'field');
    expect(field).toMatchObject({ action: 'preserved', count: 6 });
    expect((field!['blocks'] as string[]).length).toBeGreaterThan(0);
    // The same lines as the importer's own report.
    const probe = await importDocx(
      readFile(corpusFiles().find((f) => f.name === 'poi/FieldCodes.docx')!),
    );
    expect(lines.map((w) => [w['kind'], w['action'], w['count']])).toEqual(
      probe.report.map((r) => [r.kind, r.action, r.count]),
    );
  });
  it('returns an empty list of report lines for a file with nothing to report', async () => {
    const job = await run('poi/Styles.docx');
    expect(job['state']).toBe('completed');
    const reportLines = (job['warnings'] as Line[]).filter(
      (w) => typeof w['count'] === 'number' && w['kind'] !== 'font substitution',
    );
    expect(reportLines).toEqual([]);
  });
});
