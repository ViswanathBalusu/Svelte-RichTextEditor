// EXP-004 criterion 6 (lane w2), through the running service: an export requested over HTTP, run to
// completion by the job runner, leaves one version of kind `export` at the exported `seq` in the
// `versions` table, so the exported state can be found again. A preview leaves none. The compile
// worker is a stand-in registered as the `export` handler; the version is stored by the service's
// own export hooks (`control-plane/exports.ts`, wired in `server.ts`). PostgreSQL only: the test
// reads the `versions` table through the harness's admin pool, which the memory storage lacks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportOutputs } from '../../src/control-plane/handlers.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { documentWithRegions, skipReason, startHarness, type Harness } from './support.ts';

interface VersionRow {
  seq: string | number;
  kind: string;
  created_by: string;
}

const skip = await skipReason('postgres');

describe.skipIf(skip)('EXP-004 criterion 6: a completed export is a version (postgres)', () => {
  let h: Harness;
  const exportHandler: JobHandler = async (job, ctx) => {
    await ctx.report('converting', 10);
    await ctx.report('compiling', 60);
    await h.service.assets.putExport(
      job.tenant,
      job.id,
      'output.pdf',
      Buffer.from('%PDF-1.7 test'),
      'application/pdf',
    );
    const out: ExportOutputs = { output: 'output.pdf', pages: 1, layout: null, converged: true };
    return out as unknown as Record<string, unknown>;
  };

  beforeAll(async () => {
    h = await startHarness('postgres', {
      jobHandlers: { export: exportHandler },
      config: { jobIdleMs: 20, jobLeaseMs: 2000 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  async function completed(token: string, job: string): Promise<{ seq: number }> {
    for (let i = 0; i < 200; i++) {
      const r = await h.call('GET', `/v1/exports/${job}`, { token });
      if (r.json?.state === 'completed') return { seq: r.json.seq as number };
      if (r.json?.state === 'failed') throw new Error(`job ${job} failed`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`job ${job} did not complete`);
  }

  const versionsOf = async (doc: string): Promise<VersionRow[]> =>
    (
      await h.db!.admin.query<VersionRow>(
        'select seq, kind, created_by from versions where doc_id = $1 order by seq, kind',
        [doc],
      )
    ).rows;

  /** The version is stored after the job settles, so the table is polled. */
  async function exportVersions(doc: string, atLeast: number): Promise<VersionRow[]> {
    let rows: VersionRow[] = [];
    for (let i = 0; i < 100; i++) {
      rows = (await versionsOf(doc)).filter((v) => v.kind === 'export');
      if (rows.length >= atLeast) return rows;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return rows;
  }

  it('stores one export version at the exported seq, also when the export runs twice', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    expect(await versionsOf(doc)).toEqual([]);

    const first = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf', options: { profile: 'final' } },
    });
    expect(first.status).toBe(202);
    const { seq } = await completed(editor, first.json.id);
    const rows = await exportVersions(doc, 1);
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.seq)).toBe(seq);
    expect(rows[0]!.created_by.length).toBeGreaterThan(0);

    // A second export of the same state, with other options so that it is a job of its own: still
    // one version for that seq (HIS-007 criterion 5).
    const second = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf', options: { profile: 'final', tagging: 'draft' } },
    });
    expect(second.status).toBe(202);
    expect(second.json.id).not.toBe(first.json.id);
    await completed(editor, second.json.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await exportVersions(doc, 1)).length).toBe(1);
  });

  it('stores no version for a preview', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf', options: { profile: 'preview' } },
    });
    expect(r.status).toBe(202);
    await completed(editor, r.json.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await versionsOf(doc)).toEqual([]);
  });
});
