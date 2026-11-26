/**
 * Node.js measurements of the model's whole-document operations on the shared corpus, for the
 * criteria the model stories left to the harness (FND-007):
 *
 * - CDM-013 criterion 7: `validate()` of the result of a typical single-paragraph commit on a
 *   100-page document (target: well under one millisecond of CPU, 04 §12), and the same on
 *   `pages-300` and `pages-1000`;
 * - CDM-010 criterion 7: the canonical form and the document hash computed in a worker on a
 *   document at the 16 MiB limit of invariant I7 (no target in the spec), with the elapsed time and
 *   peak memory; also on `pages-100`, `pages-300` and `pages-1000`.
 *
 * - CDM-042 criterion 7: `computeLabels` of the document after one paragraph of it was edited, on
 *   `pages-100`, `pages-300` and `pages-1000`, against the typing budget of 13 §9 (16 ms at the
 *   median and 50 ms at the 95th percentile for the whole keystroke to paint, of which the labels
 *   are a part). It is the whole-document computation, run with the style table of the unedited
 *   document (a typed word changes no style) and again with a table built for each edit.
 *
 * Each document is measured in a fresh child process, so that its peak resident memory
 * (`process.resourceUsage().maxRSS`) belongs to that document alone; the canonical form and hash
 * run in a `worker_threads` worker inside it. The 16 MiB document is `pages-1000` with its body's
 * blocks repeated until the canonical form is just under 16 MiB; it is only canonicalised, since
 * its repeated identifiers would not validate. Result: test-results/model/<run>.json.
 *
 * Usage: node scripts/model-costs.ts   (from packages/perf)
 */
import { corpusStamp, loadDocument } from '@docedit/corpus';
import {
  canonicalText,
  computeLabels,
  sha256HexBytes,
  styleTable,
  type JsonEnvelope,
  type JsonNode,
  type TreeNode,
} from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { CommitValidator, validate, type CommitContext } from '@docedit/model/validate';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem, type as osType } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { summarise } from '../src/stats.ts';

const here = fileURLToPath(import.meta.url);
const pkg = resolve(dirname(here), '..');
const MIB = 1024 * 1024;
const LIMIT = 16 * MIB;

const encoder = new TextEncoder();

function withBody(env: JsonEnvelope, content: JsonNode[]): JsonEnvelope {
  return {
    ...env,
    doc: {
      ...env.doc,
      content: env.doc.content!.map((n) => (n.type === 'body' ? { ...n, content } : n)),
    },
  };
}

/** `pages-1000` with its body's blocks repeated until the canonical form is just under 16 MiB. */
async function atTheLimit(): Promise<JsonEnvelope> {
  const base = (await loadDocument('pages-1000')).envelope as unknown as JsonEnvelope;
  const blocks = base.doc.content!.find((n) => n.type === 'body')!.content ?? [];
  const perBlock = encoder.encode(canonicalText(base)).length / blocks.length;
  let count = Math.floor(LIMIT / perBlock);
  for (;;) {
    const content = Array.from({ length: count }, (_, i) => blocks[i % blocks.length]!);
    const env = withBody(base, content);
    if (encoder.encode(canonicalText(env)).length <= LIMIT) return env;
    count = Math.floor(count * 0.99);
  }
}

/** The document after a typical single-paragraph commit: a word typed into one paragraph. */
function afterCommit(env: JsonEnvelope, at = 0.5): JsonEnvelope {
  const copy = structuredClone(env);
  const body = copy.doc.content!.find((n) => n.type === 'body')!;
  const paragraphs = (body.content ?? []).filter(
    (n) => n.type === 'paragraph' && n.content?.some((c) => c.type === 'text'),
  );
  const t = paragraphs[Math.floor(paragraphs.length * at)]!.content!.find(
    (c) => c.type === 'text',
  ) as JsonNode & { text: string };
  t.text = `${t.text.slice(0, 10)}typed ${t.text.slice(10)}`;
  return copy;
}

interface WorkerResult {
  parseMs: number;
  canonicalMs: number;
  encodeMs: number;
  hashMs: number;
  canonicalBytes: number;
  heapUsedAfterParseMB: number;
  heapUsedAfterMB: number;
}

/**
 * CDM-013 criterion 7: `CommitValidator.validate()` on a chain of single-paragraph commits. Each
 * commit types a six-character word into a paragraph, and the result of one commit is the
 * document before the next (so the validator keeps its indexes, as a room does). The word is a
 * slice of the same paragraph, so no package other than the model's is needed. The document edit
 * is not timed. The first call, which has no known-valid base and validates the whole document,
 * is reported apart. Wall time only: `process.cpuUsage` ticks at 15.6 ms on Windows. Slow samples
 * are matched with the garbage collections that V8 reported during the loop.
 */
async function commitValidation(
  env: JsonEnvelope,
  attachedAssets: ReadonlySet<string>,
  commits: number,
): Promise<unknown> {
  const schema = cdmSchema();
  let doc = schema.nodeFromJSON(env.doc);
  const requires = (env as unknown as { requires: string[] }).requires;
  const ctx: CommitContext = { attachedAssets };
  const eligible = (n: typeof doc): boolean =>
    n.type.name === 'paragraph' && n.firstChild?.isText === true && n.firstChild.text!.length >= 20;
  const edit = (before: typeof doc, k: number): typeof doc => {
    let seen = -1;
    let at = -1;
    before.descendants((n, pos) => {
      if (at >= 0) return false;
      if (eligible(n)) {
        seen++;
        if (seen === k) at = pos;
      }
      return at < 0;
    });
    if (at < 0) throw new Error('no paragraph to edit');
    const word = before.slice(at + 1, at + 7);
    return before.replace(at + 4, at + 4, word);
  };
  let count = 0;
  doc.descendants((n) => {
    if (eligible(n)) count++;
    return true;
  });
  const cv = new CommitValidator();
  const first = edit(doc, 0);
  const f0 = performance.now();
  const firstResult = cv.validate(doc, first, requires, ctx);
  const firstMs = performance.now() - f0;
  doc = first;
  const warm = 100;
  for (let i = 1; i <= warm; i++) {
    const next = edit(doc, (i * 7919) % count);
    cv.validate(doc, next, requires, ctx);
    doc = next;
  }
  const gcs: { start: number; end: number }[] = [];
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      gcs.push({ start: e.startTime, end: e.startTime + e.duration });
  });
  obs.observe({ entryTypes: ['gc'] });
  const wall: number[] = [];
  const spans: { start: number; end: number }[] = [];
  let invalid = 0;
  const slowOnes: { ms: number; how: string; why: string | null }[] = [];
  const base = { ...cv.stats };
  for (let i = 0; i < commits; i++) {
    const next = edit(doc, ((warm + i + 1) * 7919) % count);
    const t0 = performance.now();
    const r = cv.validate(doc, next, requires, ctx);
    const t1 = performance.now();
    if (!r.valid) invalid++;
    wall.push(t1 - t0);
    spans.push({ start: t0, end: t1 });
    if (t1 - t0 >= 1) slowOnes.push({ ms: t1 - t0, how: r.how, why: r.why ?? null });
    doc = next;
  }
  await new Promise((ok) => setTimeout(ok, 100));
  obs.disconnect();
  const slow = spans.filter((s) => s.end - s.start >= 1);
  const slowWithGc = slow.filter((s) => gcs.some((g) => g.start < s.end && g.end > s.start));
  const sorted = [...wall].sort((a, b) => a - b);
  return {
    commits,
    eligibleParagraphs: count,
    firstCommitFullMs: firstMs,
    firstCommitHow: firstResult.how,
    wallMs: { ...summarise(wall), p99: sorted[Math.ceil(0.99 * sorted.length) - 1] },
    incremental: cv.stats.incremental - base.incremental,
    full: cv.stats.full - base.full,
    invalid,
    samplesOverOneMs: slow.length,
    slowSamples: slowOnes,
    ofThemDuringAGarbageCollection: slowWithGc.length,
    garbageCollectionsInLoop: gcs.length,
  };
}

async function workerMain(): Promise<void> {
  const t0 = performance.now();
  const env = JSON.parse(workerData as string) as JsonEnvelope;
  const t1 = performance.now();
  const heapAfterParse = getHeapStatistics().used_heap_size;
  const canonical = canonicalText(env);
  const t2 = performance.now();
  const bytes = encoder.encode(canonical);
  const t3 = performance.now();
  await sha256HexBytes(bytes);
  const t4 = performance.now();
  parentPort!.postMessage({
    parseMs: t1 - t0,
    canonicalMs: t2 - t1,
    encodeMs: t3 - t2,
    hashMs: t4 - t3,
    canonicalBytes: bytes.length,
    heapUsedAfterParseMB: heapAfterParse / MIB,
    heapUsedAfterMB: getHeapStatistics().used_heap_size / MIB,
  } satisfies WorkerResult);
}

async function child(name: string): Promise<void> {
  const limit = name === 'limit-16MiB';
  const loaded = limit ? null : await loadDocument(name);
  const env = limit ? await atTheLimit() : (loaded!.envelope as unknown as JsonEnvelope);
  let validation: unknown = null;
  if (loaded) {
    const next = afterCommit(env);
    const ctx = { attachedAssets: loaded.attachedAssets };
    const runs = name === 'pages-100' ? 9 : name === 'pages-300' ? 5 : 3;
    validate(next, ctx); // warm-up
    const wall: number[] = [];
    const cpu: number[] = [];
    let violations = 0;
    for (let i = 0; i < runs; i++) {
      const c0 = process.cpuUsage();
      const t0 = performance.now();
      violations = validate(next, ctx).violations.length;
      wall.push(performance.now() - t0);
      const c = process.cpuUsage(c0);
      cpu.push((c.user + c.system) / 1000);
    }
    validation = { runs, wallMs: summarise(wall), cpuMs: summarise(cpu), violations };
  }
  let commits: unknown = null;
  if (loaded) {
    commits = await commitValidation(env, loaded.attachedAssets, name === 'pages-100' ? 2000 : 500);
  }
  let labels: unknown = null;
  if (loaded) {
    // One edit per sample, at a different paragraph each time; the clone is not timed.
    const runs = name === 'pages-100' ? 60 : 20;
    const table = styleTable(env.doc as unknown as TreeNode);
    const edited = Array.from({ length: runs }, (_, i) => afterCommit(env, (i + 0.5) / runs));
    computeLabels(edited[0]!.doc as unknown as TreeNode, { table }); // warm-up
    const reuse: number[] = [];
    const rebuilt: number[] = [];
    let count = 0;
    for (const e of edited) {
      const doc = e.doc as unknown as TreeNode;
      const t0 = performance.now();
      count = computeLabels(doc, { table }).lists.size;
      reuse.push(performance.now() - t0);
      const t1 = performance.now();
      computeLabels(doc);
      rebuilt.push(performance.now() - t1);
    }
    labels = {
      runs,
      numberedParagraphs: count,
      withStyleTableMs: summarise(reuse),
      withNewStyleTableMs: summarise(rebuilt),
    };
  }
  const text = JSON.stringify(env);
  const rssBefore = process.resourceUsage().maxRSS / 1024;
  const t0 = performance.now();
  const result = await new Promise<WorkerResult>((ok, fail) => {
    const w = new Worker(new URL(import.meta.url), { workerData: text });
    w.once('message', (m: WorkerResult) => {
      ok(m);
      void w.terminate();
    });
    w.once('error', fail);
  });
  const workerWallMs = performance.now() - t0;
  const rssAfter = process.resourceUsage().maxRSS / 1024;
  process.stdout.write(
    JSON.stringify({
      document: name,
      jsonBytes: encoder.encode(text).length,
      validate: validation,
      commitValidation: commits,
      labels,
      canonical: { ...result, workerWallMs, peakRssBeforeMB: rssBefore, peakRssAfterMB: rssAfter },
    }),
  );
}

if (!isMainThread) await workerMain();
else if (process.argv[2] === '--child') await child(process.argv[3]!);
else {
  const results: unknown[] = [];
  for (const name of ['pages-100', 'pages-300', 'pages-1000', 'limit-16MiB']) {
    const out = execFileSync(process.execPath, [here, '--child', name], {
      encoding: 'utf8',
      maxBuffer: 64 * MIB,
    });
    results.push(JSON.parse(out));
    console.log(out);
  }
  const id = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
  mkdirSync(join(pkg, 'test-results/model'), { recursive: true });
  const machine = {
    cpu: cpus()[0]?.model.trim(),
    logicalProcessors: cpus().length,
    memoryBytes: totalmem(),
    os: `${osType()} ${release()}`,
    node: process.version,
  };
  writeFileSync(
    join(pkg, `test-results/model/${id}.json`),
    `${JSON.stringify({ schema: 'docedit-perf-model/1', runId: id, machine, corpus: corpusStamp(), results }, null, 2)}
`,
  );
}
