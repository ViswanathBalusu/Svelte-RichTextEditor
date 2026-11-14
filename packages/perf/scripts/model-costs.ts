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
 * Each document is measured in a fresh child process, so that its peak resident memory
 * (`process.resourceUsage().maxRSS`) belongs to that document alone; the canonical form and hash
 * run in a `worker_threads` worker inside it. The 16 MiB document is `pages-1000` with its body's
 * blocks repeated until the canonical form is just under 16 MiB; it is only canonicalised, since
 * its repeated identifiers would not validate. Result: test-results/model/<run>.json.
 *
 * Usage: node scripts/model-costs.ts   (from packages/perf)
 */
import { corpusStamp, loadDocument } from '@docedit/corpus';
import { canonicalText, sha256HexBytes, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem, type as osType } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
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
function afterCommit(env: JsonEnvelope): JsonEnvelope {
  const copy = structuredClone(env);
  const body = copy.doc.content!.find((n) => n.type === 'body')!;
  const paragraphs = (body.content ?? []).filter(
    (n) => n.type === 'paragraph' && n.content?.some((c) => c.type === 'text'),
  );
  const t = paragraphs[Math.floor(paragraphs.length / 2)]!.content!.find(
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
    `${JSON.stringify({ schema: 'docedit-perf-model/1', runId: id, machine, corpus: corpusStamp(), results }, null, 2)}\n`,
  );
}
