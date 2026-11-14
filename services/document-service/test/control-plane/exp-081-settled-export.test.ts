// EXP-081 criterion 5 (lane U-EXP-081-096; fixed in U4 group 1 round 3): an export with
// `suggestions` set to `accept` or `reject` runs to `completed` and leaves the document unchanged,
// with no commit created. Runs over real HTTP on the memory store and on PostgreSQL.
//
// The harness runs an `export` job handler in process. It does what a worker does with the
// document: it reads the content at the job's `seq` from the service (the stored commit log and
// checkpoints), settles the suggestions with the real converter of `@docedit/export-latex` (the
// Markdown writer, target `md`, so that no LaTeX sandbox is needed) and stores the output under the
// job. The head, the content and the whole commit log are read before the request and again after
// the job has finished, so a commit written by the request or by the finished job would show. On
// PostgreSQL the `doc_heads` and `doc_commits` rows are counted as well (09 §10; 05 §6.2).
import { markdownText } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** A document with one insertion and one deletion, so that it has unresolved suggestions. */
function withSuggestions(): Record<string, unknown> {
  const c = documentWithRegions() as {
    doc: { content: Array<{ content: Array<{ content?: unknown[] }> }> };
  };
  c.doc.content[1]!.content[0]!.content = [
    { type: 'text', text: 'Hello' },
    {
      type: 'text',
      text: ' there',
      marks: [{ type: 'ins', attrs: { id: 'sSugg00000000081', user: 'alice' } }],
    },
    {
      type: 'text',
      text: ' old',
      marks: [{ type: 'del', attrs: { id: 'sSugg00000000082', user: 'alice' } }],
    },
  ];
  return c;
}

/** The mark types found anywhere under a JSON node. */
function markTypes(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const n of node) markTypes(n, out);
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (Array.isArray(o['marks']))
      for (const m of o['marks'] as Array<{ type?: unknown }>)
        if (typeof m.type === 'string') out.add(m.type);
    for (const v of Object.values(o)) if (typeof v === 'object') markTypes(v, out);
  }
  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`EXP-081 settled export leaves the document unchanged (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    /** The text each finished job wrote, by job id. */
    const written = new Map<string, string>();

    const exportHandler: JobHandler = async (job, ctx) => {
      const seq = job.payload['seq'] as number;
      const options = job.payload['options'] as Record<string, unknown>;
      await ctx.report('converting', 10);
      // The content as stored, at the job's seq; a service read (no reader projection).
      const read = await h.service.content.read(
        { tenant: job.tenant, doc: job.doc! },
        { seq, conn: null },
      );
      const envelope = {
        cdm: read.cdm,
        requires: read.requires,
        doc: read.doc,
      } as unknown as CdmEnvelope;
      const out = markdownText(envelope, {
        suggestions: options['suggestions'] as 'accept' | 'reject',
      });
      if (!out.ok) throw new Error(`the converter refused: ${JSON.stringify(out.diagnostics)}`);
      await h.service.assets.putExport(job.tenant, job.id, 'output.md', out.bytes, 'text/markdown');
      written.set(job.id, out.text);
      return {
        output: 'output.md',
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
          views: FULL_VIEWS,
          jobHandlers: { export: exportHandler },
          config: { jobIdleMs: 20, jobLeaseMs: 2000, exportTargets: ['pdf', 'md'] },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    /** The head sequence number, the content at the head and the whole commit log, as served. */
    async function snapshot(doc: string, token: string) {
      const head = await h.call('GET', `/v1/documents/${doc}/content`, { token });
      expect(head.status, head.text).toBe(200);
      const log = await h.call('GET', `/v1/documents/${doc}/commits?after=0&limit=200`, { token });
      expect(log.status, log.text).toBe(200);
      const rows = h.db
        ? (
            await h.db.admin.query<{ head: string; commits: number }>(
              `SELECT (SELECT head_seq FROM doc_heads WHERE doc_id = $1)::text AS head,
                      (SELECT count(*)::int FROM doc_commits WHERE doc_id = $1) AS commits`,
              [doc],
            )
          ).rows[0]
        : null;
      return { content: head.text, seq: head.json.seq as number, log: log.text, rows };
    }

    /** Polls the API until the job reaches one of `states`. */
    async function reach(token: string, job: string, states: string[]) {
      let last: unknown = null;
      for (let i = 0; i < 250; i++) {
        const r = await h.call('GET', `/v1/exports/${job}`, { token });
        last = r.json;
        if (states.includes(r.json?.state)) return r;
        await sleep(20);
      }
      throw new Error(
        `job ${job} did not reach ${states.join(' or ')}; last ${JSON.stringify(last)}`,
      );
    }

    for (const [suggestions, expected, gone] of [
      ['accept', 'Hello there', ' old'],
      ['reject', 'Hello old', ' there'],
    ] as const) {
      it.skipIf(skip)(
        `runs an export with suggestions ${suggestions} to completed, and leaves the document and its commit log unchanged (EXP-081 criterion 5)`,
        async () => {
          const doc = await h.createDocument({ content: withSuggestions() });
          const viewer = h.userToken({ [doc]: 'viewer' });
          const before = await snapshot(doc, viewer);
          expect([...markTypes(JSON.parse(before.content))]).toEqual(
            expect.arrayContaining(['ins', 'del']),
          );

          const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
            token: viewer,
            body: { target: 'md', options: { suggestions } },
          });
          expect(r.status, r.text).toBe(202);
          const job = r.json.id as string;
          const done = await reach(viewer, job, ['completed', 'failed']);
          expect(done.json.state, JSON.stringify(done.json)).toBe('completed');

          // The finished export settled the suggestions in its output...
          const text = written.get(job) ?? '';
          expect(text).toContain(expected);
          expect(text).not.toContain(gone);

          // ...and the document is as it was: the same content, head, commit log and rows.
          const after = await snapshot(doc, viewer);
          expect(after.content).toBe(before.content);
          expect(after.seq).toBe(before.seq);
          expect(after.log).toBe(before.log);
          expect(after.rows).toEqual(before.rows);
          // The stored content still holds both suggestions, unresolved.
          const marks = markTypes(JSON.parse(after.content));
          expect(marks.has('ins')).toBe(true);
          expect(marks.has('del')).toBe(true);
          // A service read of the head, past any reader projection, holds them too.
          const stored = await h.service.content.read({ tenant: h.tenant, doc }, { conn: null });
          expect(stored.seq).toBe(before.seq);
          const storedMarks = markTypes(stored.doc);
          expect(storedMarks.has('ins') && storedMarks.has('del')).toBe(true);
        },
      );
    }
  });
}
