/**
 * Export latency by stage, through the real job path (EXP-060 criteria 2 and 5):
 *
 *   node services/export-worker/scripts/latency.ts [--corpus <dir>] [--docs a,b] [--runs 3]
 *        [--profiles final,preview]
 *
 * Starts an in-process document service (memory storage; objects in the integration environment's
 * S3 store when it is up) and the export worker on its queue, then, for every document and
 * profile, creates the document, requests an export through `POST /v1/documents/{id}/exports`, and
 * waits for the job. Records the worker's stage times (queue wait, content, conversion, checks,
 * the sandbox's time outside the passes, each pass, parsing, storing) and the job's own time from
 * creation to its end, as the control plane's clock gives them. Documents whose content the service
 * refuses (for example one that names assets nobody uploaded) are skipped with a warning. Writes
 * results.json and summary.md to services/export-worker/out/latency/<stamp>/ (not under version
 * control). The default documents are spike S4's (fixtures/s4-corpus), which need no assets.
 */
import { cpus, totalmem } from 'node:os';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRecord } from '@docedit/document-service';
import { podmanInfo } from '../src/container.ts';
import { imageFontManifest } from '../src/fonts.ts';
import type { ExportMetrics } from '../src/job.ts';
import { completedMetrics } from '../src/metrics-log.ts';
import { IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';
import { createExportWorker } from '../src/worker.ts';
import { startTestService } from '../test/service.ts';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const corpus = resolve(opt('--corpus', join(root, 'fixtures', 's4-corpus')));
const only = argv.includes('--docs') ? new Set(opt('--docs', '').split(',')) : null;
const runs = Number(opt('--runs', '3'));
const profiles = opt('--profiles', 'final,preview').split(',');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(opt('--out', join(root, 'out', 'latency', stamp)));

const ready = await sandboxReady();
if (!ready.ok) {
  console.error(`the sandbox is not ready: ${ready.reason}`);
  process.exit(1);
}
const t = await startTestService();
const metrics = new Map<string, ExportMetrics>();
const fonts = await imageFontManifest(IMAGE);
const worker = createExportWorker({
  queue: t.service.parts.queue,
  deps: {
    stores: {
      logs: t.service.parts.logs,
      checkpoints: t.service.checkpoints,
      documents: t.service.parts.documents,
    },
    outputs: t.service.assets,
    fonts: async () => fonts,
    onMetrics: (m, job) => metrics.set(job.id, m),
  },
  worker: 'latency',
  leaseMs: 5000,
  idleMs: 20,
  retryAfterMs: 1000,
});
worker.start();

interface Row {
  doc: string;
  profile: string;
  run: number;
  state: string;
  error: string | null;
  pages: number | null;
  jobMs: number;
  metrics: ExportMetrics | null;
  /** The codes of a failed job's diagnostics (EXP-060: a failed run says why, not only that it failed). */
  diagnostics: string[];
}

const rows: Row[] = [];

/** The codes and block identifiers of a failed job's diagnostics, from its stored result. */
function diagnosticCodes(result: JobRecord['result'] | undefined): string[] {
  const list = (result as { diagnostics?: unknown } | null | undefined)?.diagnostics;
  if (!Array.isArray(list)) return [];
  return list.map((d: { code?: unknown; blockId?: unknown }) =>
    [String(d.code), d.blockId ? String(d.blockId) : null].filter(Boolean).join('@'),
  );
}
const files = readdirSync(corpus)
  .filter((f) => f.endsWith('.cdm.json') && (!only || only.has(f.replace(/\.cdm\.json$/, ''))))
  .sort();
for (const file of files) {
  const name = file.replace(/\.cdm\.json$/, '');
  const content = JSON.parse(readFileSync(join(corpus, file), 'utf8')) as unknown;
  for (const profile of profiles)
    for (let run = 1; run <= runs; run++) {
      let doc: string;
      try {
        doc = await t.createDocument(content, name);
      } catch (e) {
        console.warn(
          `${name}: the service refused the document (${String(e).slice(0, 200)}); skipped`,
        );
        break;
      }
      const token = t.userToken({ [doc]: 'editor' });
      const created = await t.call('POST', `/v1/documents/${doc}/exports`, {
        token,
        body: { target: 'pdf', options: { profile } },
      });
      const id = created.json.id as string;
      let record: JobRecord | null = null;
      for (let i = 0; i < 6000 && !record; i++) {
        const j = await t.service.parts.queue.get(t.tenant, id);
        if (j && ['completed', 'failed', 'cancelled'].includes(j.state)) record = j;
        else await new Promise((r) => setTimeout(r, 50));
      }
      const row: Row = {
        doc: name,
        profile,
        run,
        state: record?.state ?? 'timeout',
        error: record?.error ? `${record.error.code}: ${record.error.message}` : null,
        pages: ((record?.result as { pages?: number } | null)?.pages ?? null) as number | null,
        jobMs: record ? record.updatedAt - record.createdAt : -1,
        metrics: metrics.get(id) ?? null,
        diagnostics: diagnosticCodes(record?.result),
      };
      rows.push(row);
      console.log(JSON.stringify({ ...row, metrics: row.metrics && { ...row.metrics } }));
    }
}
await worker.stop();
await t.close();

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sec = (ms: number) => (Number.isNaN(ms) ? '–' : (ms / 1000).toFixed(2));
const lines = [
  `# Export latency by stage, ${stamp}`,
  '',
  `Machine: ${cpus()[0]?.model ?? 'unknown'}, ${cpus().length} logical CPUs, ${Math.round(totalmem() / 2 ** 30)} GiB; ${process.platform}; Node ${process.version}. Podman ${podmanInfo()?.version ?? '?'}; route: ${ready.reason}; image ${IMAGE}.`,
  `Command: node services/export-worker/scripts/latency.ts ${argv.join(' ')}`,
  `Seconds, medians of ${runs} runs. "Job" runs from the job's creation to its end (control plane clock); the stages are the worker's.`,
  '',
  '| Document | Pages | Profile | Job | Queue wait | Content | Conversion | Checks | Sandbox outside passes | Passes | Parse | Store | OK |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];
const groups = new Map<string, Row[]>();
for (const r of rows)
  groups.set(`${r.doc}|${r.profile}`, [...(groups.get(`${r.doc}|${r.profile}`) ?? []), r]);
for (const [, g] of groups) {
  // Completed attempts only: a failed one has 0 for the stages it did not reach (metrics-log.ts).
  const ok = completedMetrics(g.map((r) => r.metrics));
  const m = (f: (x: ExportMetrics) => number) => sec(median(ok.map(f)));
  const passes =
    ok[0]?.passMs.map((_, i) => sec(median(ok.map((x) => x.passMs[i] ?? NaN)))).join(' + ') ?? '–';
  lines.push(
    `| ${g[0]!.doc} | ${g[0]!.pages ?? '–'} | ${g[0]!.profile} | ${sec(median(g.map((r) => r.jobMs)))} | ${m((x) => x.queueWaitMs)} | ${m((x) => x.contentMs)} | ${m((x) => x.convertMs)} | ${m((x) => x.verifyMs)} | ${m((x) => x.sandboxOverheadMs)} | ${passes} | ${m((x) => x.parseMs)} | ${m((x) => x.storeMs)} | ${g.every((r) => r.state === 'completed') ? 'yes' : g.map((r) => r.error ?? r.state).join('; ')} |`,
  );
}
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'results.json'),
  JSON.stringify({ argv, image: IMAGE, route: ready.reason, rows }, null, 2),
);
writeFileSync(join(out, 'summary.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`results: ${out}`);
