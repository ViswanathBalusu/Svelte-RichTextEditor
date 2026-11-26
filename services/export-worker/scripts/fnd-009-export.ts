/**
 * FND-009 criterion 3: a 20-page export, measured against the target of 10 seconds at the 95th
 * percentile with an empty queue (00 §9). It is a measurement, not a test: it needs Podman and the
 * worker image, and it takes minutes.
 *
 *   node scripts/fnd-009-export.ts [--runs 20] [--pages 20] [--toc] [--out report.json]
 *
 * The document service and the export worker run in this process, on the service's own queue and
 * in-memory stores (test/service.ts). Each export is a `POST /v1/documents/{id}/exports`, then a
 * poll of `GET /v1/exports/{id}` every 25 ms until the job ends; the time is taken from the POST to
 * the poll that sees `completed`. Runs are sequential, so the queue is empty at every start. The
 * compile runs in the real Podman sandbox (`compileInSandbox`). A few exports first find the
 * number of sections that gives the requested page count; they are not counted.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { imageFontManifest } from '../src/fonts.ts';
import { compileInSandbox, IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';
import { createExportWorker } from '../src/worker.ts';
import { tocDocument } from '../test/documents.ts';
import { startTestService } from '../test/service.ts';

/** The nearest-rank percentile of a list of numbers. */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '20' },
    pages: { type: 'string', default: '20' },
    toc: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});
const RUNS = Number(values.runs);
const PAGES = Number(values.pages);

const ready = await sandboxReady();
if (!ready.ok) {
  console.error(`The sandbox is not ready: ${ready.reason}`);
  process.exit(2);
}

const t = await startTestService();
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
    compile: (files, opts) =>
      compileInSandbox(files, {
        ...opts,
        name: `docedit-job-fnd009-${randomBytes(4).toString('hex')}`,
      }),
  },
  worker: 'fnd-009-export',
  leaseMs: 30_000,
  idleMs: 25,
  retryAfterMs: 1000,
});
worker.start();

/** A document of `sections` headings with a paragraph each, with or without a table of contents. */
function documentOf(sections: number) {
  const envelope = tocDocument(sections) as unknown as {
    doc: { content: Array<{ content: unknown[] }> };
  };
  if (!values.toc) envelope.doc.content[1]!.content = envelope.doc.content[1]!.content.slice(1);
  return envelope as unknown as Parameters<typeof t.createDocument>[0];
}

interface Outcome {
  ms: number;
  state: string;
  pages: number | null;
  passes: number | null;
}

async function exportOnce(sections: number): Promise<Outcome> {
  const doc = await t.createDocument(documentOf(sections));
  const token = t.userToken({ [doc]: 'editor' });
  const started = performance.now();
  const created = await t.call('POST', `/v1/documents/${doc}/exports`, {
    token,
    body: { target: 'pdf', options: {} },
  });
  if (created.status !== 202) throw new Error(`export refused: ${created.status} ${created.text}`);
  for (;;) {
    const r = await t.call('GET', `/v1/exports/${created.json.id as string}`, { token });
    const state = r.json?.state as string;
    if (['completed', 'failed', 'cancelled'].includes(state)) {
      return {
        ms: performance.now() - started,
        state,
        pages: (r.json?.result?.pages as number | undefined) ?? null,
        passes: (r.json?.result?.passes as number | undefined) ?? null,
      };
    }
    if (performance.now() - started > 600_000) throw new Error('an export did not end');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

try {
  // Find the section count for the page count, starting from the page rate of one probe.
  let sections = 15 * PAGES;
  let probe = await exportOnce(sections);
  for (let i = 0; i < 4 && probe.pages !== PAGES && probe.pages !== null; i++) {
    const next = Math.max(1, Math.round((sections * PAGES) / probe.pages));
    sections = next === sections ? sections + (probe.pages < PAGES ? 1 : -1) : next;
    probe = await exportOnce(sections);
  }
  console.error(`probe: ${sections} sections gave ${probe.pages} pages (${probe.state})`);

  const runs: Outcome[] = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(await exportOnce(sections));
    console.error(`run ${i + 1}/${RUNS}: ${Math.round(runs[i]!.ms)} ms, ${runs[i]!.pages} pages`);
  }
  const ok = runs.filter((r) => r.state === 'completed').map((r) => r.ms);
  const report = {
    story: 'FND-009 criterion 3',
    date: new Date().toISOString(),
    machine: {
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      platform: `${os.platform()} ${os.release()}`,
    },
    node: process.version,
    image: IMAGE,
    storage: t.s3 ? 'S3-compatible' : 'memory',
    toc: values.toc,
    sections,
    pages: [...new Set(runs.map((r) => r.pages))],
    runs: RUNS,
    failed: runs.length - ok.length,
    targetMs: { p95: 10_000 },
    ms: {
      min: Math.round(Math.min(...ok)),
      median: Math.round(percentile(ok, 50)),
      p95: Math.round(percentile(ok, 95)),
      max: Math.round(Math.max(...ok)),
    },
    samples: runs.map((r) => Math.round(r.ms)),
  };
  const text = JSON.stringify(report, null, 2);
  if (values.out) writeFileSync(resolve(values.out), text);
  console.log(text);
} finally {
  await worker.stop();
  await t.close();
}
