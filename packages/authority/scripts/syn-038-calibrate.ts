// Measurements for SYN-038 (calibrate the sync defaults of 04 §12 and §16). Run from the repository
// root on the reference machine (ADR 0037), with the garbage collector exposed so that memory can
// be read:
//
//   node --expose-gc packages/authority/scripts/syn-038-calibrate.ts [section] [seed]
//
// `section` is one of `hash`, `rebase`, `stale`, `cost`, `catchup`, `typing` or `all` (default). The output
// is Markdown tables. What is measured and what is simulated is said above each table:
//
// - hash, rebase, cost, catchup: wall-clock times of the authority's own functions on the shared
//   corpus (FND-006), taken with `performance.now()` in one process on one thread. They include
//   whatever garbage collection falls inside the timed span. A table says how many runs it has.
// - typing: a simulation of a synthetic typing trace. The trace is a model with stated parameters,
//   not a recording. Its results are as good as those parameters.
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { loadDocument } from '@docedit/corpus';
import {
  canonicalNode,
  documentHash,
  sha256Hex,
  canonicalize,
  type JsonEnvelope,
  type JsonNode,
} from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Node } from 'prosemirror-model';
import { Transform, type Step, type StepMap } from 'prosemirror-transform';
import { DEFAULT_LIMITS } from '../src/codes.ts';
import { checkInvariants } from '../src/invariants.ts';
import { applySteps, mapsOf, rebaseOver } from '../src/rebase.ts';
import { defaultCost } from '../src/room/admission.ts';
import { parseSteps, stepsToJson } from '../src/steps.ts';

const schema = cdmSchema();
const SECTION = process.argv[2] ?? 'all';
let seed = Number(process.argv[3] ?? 1);
const CTX = { requires: [], retiredRegionIds: new Set<string>() };

/** mulberry32, so that a run is repeatable for one seed. */
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
}
function stats(xs: number[]): { med: number; p99: number; min: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  return { med: percentile(s, 0.5), p99: percentile(s, 0.99), min: s[0]!, max: s[s.length - 1]! };
}
const f = (x: number, d = 2): string => x.toFixed(d);

async function timeAsync(runs: number, fn: () => Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < Math.min(5, runs); i++) await fn();
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    out.push(performance.now() - t0);
  }
  return out;
}
function time(runs: number, fn: () => unknown): number[] {
  for (let i = 0; i < Math.min(5, runs); i++) fn();
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

/** Positions inside paragraphs that hold text (a place to type one character). */
function textPlaces(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'paragraph' && n.content.size >= 6 && n.childCount > 0) out.push(pos + 2);
    return true;
  });
  return out;
}

/** `n` one-character inserts at random places, made in order on `base`. */
function typedSteps(base: Node, n: number): { steps: Step[]; doc: Node } {
  const places = textPlaces(base);
  const tr = new Transform(base);
  if (places.length === 0) throw new Error('no place to type');
  for (let tries = 0; tr.steps.length < n && tries < n * 20; tries++) {
    const p = pick(places);
    const at = Math.min(tr.mapping.map(p), tr.doc.content.size - 1);
    try {
      tr.insert(at, schema.text('x'));
    } catch {
      /* a place the earlier inserts moved: try another */
    }
  }
  return { steps: [...tr.steps], doc: tr.doc };
}

function header(): void {
  const cpu = cpus();
  console.log(
    `Machine: ${cpu[0]?.model ?? 'unknown'}, ${cpu.length} logical cores, ${(totalmem() / 2 ** 30).toFixed(0)} GiB, ${platform()} ${release()}, Node.js ${process.version}; seed ${process.argv[3] ?? 1}\n`,
  );
}

async function load(name: string): Promise<JsonEnvelope> {
  return (await loadDocument(name)).envelope as unknown as JsonEnvelope;
}

/** The first half of the body of `pages-20` by canonical size, which stands for 10 pages. */
async function tenPages(): Promise<JsonEnvelope> {
  const env = await load('pages-20');
  const root = env.doc as unknown as JsonNode;
  const body = root.content!.find((n) => n.type === 'body')!;
  const sizes = body.content!.map((c) => canonicalize(c as never).length);
  const total = sizes.reduce((a, b) => a + b, 0);
  let acc = 0;
  let keep = 0;
  while (keep < sizes.length && acc < total / 2) acc += sizes[keep++]!;
  const copy = structuredClone(env) as JsonEnvelope;
  const b = (copy.doc as unknown as JsonNode).content!.find((n) => n.type === 'body')!;
  b.content = b.content!.slice(0, keep);
  return copy;
}

// ---------------------------------------------------------------- criterion 6: rolling hash
async function hashSection(): Promise<void> {
  console.log('## Hash of the document per commit (SYN-038 criterion 6; 04 §16)\n');
  console.log(
    'Full: `documentHash` of `@docedit/model` (canonical form, then SHA-256 by WebCrypto) of the whole document after each commit. ' +
      'Rolling: the hash of every top-level block of the body is kept; after a commit the one changed block is rehashed (canonical form of the block, SHA-256) and the block hashes are combined by one SHA-256 over their concatenation. ' +
      'The 10-page document is the first half of `pages-20` by canonical size (the corpus has no 10-page file). 30 runs each after 5 warm-ups; milliseconds.\n',
  );
  console.log(
    '| Document | Canonical bytes | Blocks | Full median | Full p99 | Rolling median | Rolling p99 |',
  );
  console.log('|---|---|---|---|---|---|---|');
  const docs: Array<[string, JsonEnvelope]> = [
    ['pages-1', await load('pages-1')],
    ['10 pages (half of pages-20)', await tenPages()],
    ['pages-20', await load('pages-20')],
    ['pages-100', await load('pages-100')],
  ];
  for (const [name, env] of docs) {
    const bytes = canonicalize(env.doc as never).length;
    const body = (env.doc as unknown as JsonNode).content!.find((n) => n.type === 'body')!;
    const blocks = body.content!.length;
    const full = stats(await timeAsync(30, () => documentHash(env)));
    const hashes = await Promise.all(
      body.content!.map((c) => sha256Hex(JSON.stringify(canonicalNode(c)))),
    );
    let k = 0;
    const roll = stats(
      await timeAsync(30, async () => {
        const i = k++ % blocks;
        hashes[i] = await sha256Hex(JSON.stringify(canonicalNode(body.content![i]!)));
        return sha256Hex(hashes.join(''));
      }),
    );
    console.log(
      `| ${name} | ${bytes} | ${blocks} | ${f(full.med)} | ${f(full.p99)} | ${f(roll.med)} | ${f(roll.p99)} |`,
    );
  }
  console.log('');
}

// ---------------------------------------------------------------- criterion 2: maxRebaseSteps
async function rebaseSection(): Promise<void> {
  console.log('## Rebase distance (SYN-038 criterion 2; 04 §5, §12)\n');
  console.log(
    'A commit of 1 step (and of 50 steps) is made on a base of `pages-20`; `D` one-character inserts by others follow. ' +
      "Time: `rebaseOver` of the commit over the maps of the `D` steps (the room's step 3), 15 runs, milliseconds. " +
      'Memory: the heap kept by `D` step maps alone (the room keeps one per accepted commit step), read after `gc()` as the difference of `heapUsed`; the median of 5 readings.\n',
  );
  const env = await load('pages-20');
  const base = schema.nodeFromJSON(env.doc);
  console.log(
    '| D (steps since base) | Rebase 1 step median | p99 | Rebase 50 steps median | p99 | Heap of the maps (KiB) | Bytes per step map |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const D of [100, 500, 1000, 5000, 10000, 20000]) {
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    // Only the maps are kept: the steps and the document that made them are dropped before reading.
    const readings: number[] = [];
    const held: StepMap[][] = [];
    for (let r = 0; r < 5; r++) {
      gc?.();
      const before = process.memoryUsage().heapUsed;
      held.push(((): StepMap[] => mapsOf(typedSteps(base, D).steps))());
      gc?.();
      readings.push(process.memoryUsage().heapUsed - before);
      held.pop();
    }
    const heap = [...readings].sort((x, y) => x - y)[2]!;
    const others = typedSteps(base, D);
    const maps: StepMap[] = mapsOf(others.steps);
    const row: string[] = [];
    for (const n of [1, 50]) {
      const mine = typedSteps(base, n);
      const json = stepsToJson(mine.steps);
      const parsed = parseSteps(schema, json, DEFAULT_LIMITS);
      if (!parsed.ok)
        throw new Error(
          `parse failed: ${parsed.code} ${(parsed as { reason?: string }).reason ?? ''}`,
        );
      let refused = 0;
      const t = stats(
        time(15, () => {
          const r = rebaseOver(parsed.value, maps, others.doc, 'reject');
          if (!r.ok) refused++;
        }),
      );
      row.push(`${f(t.med)}${refused ? ` (${refused} refused)` : ''}`, f(t.p99));
    }
    console.log(
      `| ${D} | ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} | ${gc ? f(heap / 1024, 0) : 'n/a'} | ${gc ? f(heap / D, 0) : 'n/a'} |`,
    );
  }
  console.log(
    '\nTime until a client that is `L` seconds behind exceeds `maxRebaseSteps` = 5,000 (a model, not a measurement: every other editor produces `r` steps per second, one step per keystroke):\n',
  );
  console.log('| Other editors | r = 2 steps/s | r = 5 steps/s |');
  console.log('|---|---|---|');
  for (const e of [1, 5, 20, 50])
    console.log(`| ${e} | ${f(5000 / (e * 2), 0)} s | ${f(5000 / (e * 5), 0)} s |`);
  console.log('');
}

// ---------------------------------------------------------------- criterion 2: stale_base rate (simulated)
/** A normal variate (Box-Muller). */
function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
function lognormal(median: number, sigma: number): number {
  return median * Math.exp(sigma * gauss());
}
/** A Poisson variate: exact for small means, a normal approximation above 50. */
function poisson(mean: number): number {
  if (mean > 50) return Math.max(0, Math.round(mean + Math.sqrt(mean) * gauss()));
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

/**
 * The rate of `stale_base` for simulated clients. Nothing records how far real clients fall behind,
 * so the lag of each client class is a stated model (see the output), not a measurement. The
 * distance of a commit is the number of steps by other editors since its base; the room refuses it
 * with `stale_base` when that exceeds `maxRebaseSteps` (room.ts, the check on steps since base).
 */
function staleSection(): void {
  console.log('## Rate of stale_base for simulated clients (SYN-038 criterion 2; 04 §5, §12)\n');
  const classes: { name: string; median: number; sigma: number }[] = [
    { name: 'fast (lag between base and submission)', median: 0.3, sigma: 0.5 },
    { name: 'slow (lag between base and submission)', median: 3, sigma: 0.8 },
    { name: 'returning after a disconnection (time away)', median: 60, sigma: 1.5 },
  ];
  const EDITORS = [5, 50];
  const LIMITS = [1000, 2500, 5000, 10000, 20000];
  const STEPS_PER_S = 2;
  const ACTIVE = 0.3;
  const N = 200_000;
  console.log(
    `Model: each other editor types ${STEPS_PER_S} steps a second while active, and ${ACTIVE * 100} % of them are active at any moment, so the room accepts \`editors x ${ACTIVE} x ${STEPS_PER_S}\` steps a second from others. ` +
      "A client class has a lag drawn from a lognormal distribution with the median and sigma shown; the distance of its commit is a Poisson count of the others' steps in that lag. " +
      `${N.toLocaleString('en-GB')} commits per cell, seed ${process.argv[3] ?? 1}. The medians and sigmas are assumptions, chosen to show a fast link, a slow link and a return after a drop; they are not recordings. ` +
      'Not modelled: `stale_base` for a base before the oldest commit the room holds, or before a snapshot commit.\n',
  );
  console.log(
    `| Client class | Median lag | Sigma | Other editors | ${LIMITS.map((l) => `stale at ${l.toLocaleString('en-GB')}`).join(' | ')} |`,
  );
  console.log(`|---|---|---|---|${LIMITS.map(() => '---').join('|')}|`);
  for (const c of classes) {
    for (const e of EDITORS) {
      const rate = e * ACTIVE * STEPS_PER_S;
      const hits = LIMITS.map(() => 0);
      for (let i = 0; i < N; i++) {
        const d = poisson(rate * lognormal(c.median, c.sigma));
        LIMITS.forEach((l, j) => {
          if (d > l) hits[j]!++;
        });
      }
      console.log(
        `| ${c.name} | ${c.median} s | ${c.sigma} | ${e} | ${hits.map((h) => `${f((100 * h) / N, 3)} %`).join(' | ')} |`,
      );
    }
  }
  console.log(
    '\nMemory of the position maps kept for a room at each limit, from the measured 120 bytes per step map (table above):\n',
  );
  console.log('| maxRebaseSteps | Maps kept per room (KiB) |');
  console.log('|---|---|');
  for (const l of LIMITS)
    console.log(`| ${l.toLocaleString('en-GB')} | ${f((l * 120) / 1024, 0)} |`);
  console.log('');
}

// ---------------------------------------------------------------- criterion 3: cost estimate
async function costSection(): Promise<void> {
  console.log('## Cost estimate against measured time (SYN-038 criterion 3; SYN-037, 04 §12)\n');
  console.log(
    'Each commit has `S` one-character inserts and a base `D` steps behind the head of a document. The measured time is what the room does for it in steps 2 to 7: `parseSteps`, `rebaseOver`, `applySteps` of the mapped steps and `checkInvariants`. ' +
      'The estimate is `defaultCost` of `src/room/admission.ts` in units (fan-out 1). 9 runs each, median; milliseconds. The last column is milliseconds per unit.\n',
  );
  console.log('| Document | S | D | Bytes | Estimate (units) | Measured median ms | ms per unit |');
  console.log('|---|---|---|---|---|---|---|');
  const rows: Array<{ name: string; ratio: number; ms: number; units: number }> = [];
  for (const name of ['pages-1', 'pages-20', 'pages-100']) {
    const base = schema.nodeFromJSON((await load(name)).doc);
    for (const [S, D] of [
      [1, 0],
      [1, 1000],
      [10, 0],
      [10, 1000],
      [100, 0],
      [100, 1000],
      [500, 0],
    ] as const) {
      const others = D > 0 ? typedSteps(base, D) : { steps: [] as Step[], doc: base };
      const mine = typedSteps(base, S);
      const json = stepsToJson(mine.steps);
      const bytes = JSON.stringify(json).length;
      const maps = mapsOf(others.steps);
      let ok = true;
      let why = '';
      const t = stats(
        time(9, () => {
          const p = parseSteps(schema, json, DEFAULT_LIMITS);
          if (!p.ok) return void ((ok = false), (why = 'parse ' + p.code));
          const r = rebaseOver(p.value, maps, others.doc, 'reject');
          if (!r.ok) return void ((ok = false), (why = 'rebase ' + r.code));
          const a = applySteps(others.doc, r.value.steps);
          if (!a.ok) return void ((ok = false), (why = 'apply ' + a.code));
          const c = checkInvariants(others.doc, a.value.doc, r.value.steps, a.value.docs, CTX);
          if (!c.ok) {
            ok = false;
            why = 'invariants ' + c.code;
          }
        }),
      );
      const units = defaultCost({ steps: mine.steps.length, rebaseSteps: D, bytes, fanOut: 1 });
      console.log(
        `| ${name} | ${mine.steps.length} | ${D} | ${bytes} | ${units} | ${f(t.med)}${ok ? '' : ' (refused: ' + why + ')'} | ${f(t.med / units, 4)} |`,
      );
      if (ok) rows.push({ name, ratio: t.med / units, ms: t.med, units });
    }
  }
  const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
  console.log(
    `\nms per unit over the ${rows.length} accepted rows: min ${f(ratios[0]!, 4)}, median ${f(percentile(ratios, 0.5), 4)}, max ${f(ratios[ratios.length - 1]!, 4)}; the largest is ${f(ratios[ratios.length - 1]! / ratios[0]!, 0)} times the smallest.\n`,
  );
}

// ---------------------------------------------------------------- criterion 4: catch-up
async function catchupSection(): Promise<void> {
  console.log('## Streaming a catch-up against reloading (SYN-038 criterion 4; 04 §9)\n');
  console.log(
    'Stream: the server serialises `k` `sync.commit` bodies (`JSON.stringify`), the client parses them and applies the steps (`applySteps`) to its document. ' +
      'Reload: the server serialises the document content, the client parses it and builds the node tree (`nodeFromJSON`). ' +
      'A commit is one one-character insert (typical) or 50 of them. Network and storage time are not included. 7 runs each, median; milliseconds.\n',
  );
  const env = await load('pages-20');
  const base = schema.nodeFromJSON(env.doc);
  const envelopes: Array<[string, JsonEnvelope]> = [
    ['pages-1', await load('pages-1')],
    ['pages-20', env],
    ['pages-100', await load('pages-100')],
  ];
  console.log('| Reload of | Content bytes | Reload ms |');
  console.log('|---|---|---|');
  const reload: Record<string, number> = {};
  for (const [name, e] of envelopes) {
    const bytes = JSON.stringify(e.doc).length;
    const t = stats(
      time(7, () => {
        const s = JSON.stringify(e.doc);
        schema.nodeFromJSON(JSON.parse(s));
      }),
    );
    reload[name] = t.med;
    console.log(`| ${name} | ${bytes} | ${f(t.med)} |`);
  }
  console.log(
    '\n| Commit | k | Stream bytes | Stream ms (server + client) | Over a limit (5,000 commits, 5 MiB) |',
  );
  console.log('|---|---|---|---|---|');
  for (const perCommit of [1, 50]) {
    for (const k of [100, 1000, 5000]) {
      const doc0 = base;
      const chain: Step[][] = [];
      let cur = doc0;
      for (let i = 0; i < k; i++) {
        const t = typedSteps(cur, perCommit);
        chain.push(t.steps);
        cur = t.doc;
      }
      const msgs = chain.map((steps, i) => ({
        t: 'sync.commit',
        ch: 1,
        d: {
          seq: i + 1,
          id: '0193a5e0-7c1e-7a3f-9a54-3f2f1f6f8a10',
          user: 'u-0193a5e0',
          time: '2026-11-17T10:00:00.000Z',
          steps: stepsToJson(steps),
        },
      }));
      const bytes = msgs.reduce((n, m) => n + JSON.stringify(m).length, 0);
      const t = stats(
        time(7, () => {
          const wire = msgs.map((m) => JSON.stringify(m));
          let d = doc0;
          for (const w of wire) {
            const m = JSON.parse(w) as { d: { steps: unknown } };
            const p = parseSteps(schema, m.d.steps, DEFAULT_LIMITS);
            if (!p.ok) throw new Error(p.code);
            const a = applySteps(d, p.value);
            if (!a.ok) throw new Error(a.code);
            d = a.value.doc;
          }
        }),
      );
      const overCount = k >= (DEFAULT_LIMITS.catchUpCommits ?? 5000);
      const overBytes = bytes >= (DEFAULT_LIMITS.catchUpBytes ?? 5 * 1024 * 1024);
      const binds =
        overCount && overBytes
          ? 'both'
          : overCount
            ? 'the commit count'
            : overBytes
              ? 'the byte limit'
              : 'neither';
      console.log(
        `| ${perCommit} step${perCommit > 1 ? 's' : ''} | ${k} | ${bytes} | ${f(t.med)} | ${binds} |`,
      );
    }
  }
  console.log('');
}

// ---------------------------------------------------------------- criteria 1 and 5: typing
interface Key {
  t: number;
}
/** A synthetic typing trace: bursts of keystrokes with lognormal gaps, then a pause. */
function typingTrace(durationMs: number): Key[] {
  const keys: Key[] = [];
  let t = 0;
  const normal = (): number => {
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  while (t < durationMs) {
    const burst = 15 + Math.floor(rand() * 46);
    for (let i = 0; i < burst && t < durationMs; i++) {
      t += Math.exp(Math.log(180) + 0.45 * normal());
      keys.push({ t });
    }
    t += 1000 + rand() * 3000;
  }
  return keys;
}

/** Bytes of one `sync.submit` message with `n` one-character steps (measured on a real step). */
function submitBytes(n: number, stepBytes: number): number {
  const overhead = JSON.stringify({
    t: 'sync.submit',
    ch: 1,
    d: { id: '0193a5e0-7c1e-7a3f-9a54-3f2f1f6f8a10', base: 12345, steps: [] },
  }).length;
  return overhead + n * (stepBytes + 1);
}

interface Sim {
  commits: number;
  bytes: number;
  meanSend: number;
  meanAck: number;
  p99Ack: number;
  meanKeys: number;
  maxKeys: number;
  maxInFlightWait: number;
}

/**
 * One client: a window opens at the first keystroke that is not yet in a commit and closes
 * `window` ms later. The commit is sent when the window closes and, with one commit in flight, no
 * earlier than the acknowledgement of the one before. Acknowledgement is `rtt` after sending.
 */
function simulate(
  keys: Key[],
  window: number,
  rtt: number,
  stepBytes: number,
  pipelined: boolean,
): Sim {
  const send: number[] = [];
  const ack: number[] = [];
  let busyUntil = 0;
  let commits = 0;
  let bytes = 0;
  const maxKeys: number[] = [];
  let i = 0;
  while (i < keys.length) {
    const open = keys[i]!.t;
    let close = open + window;
    if (!pipelined) close = Math.max(close, busyUntil);
    let j = i;
    while (j < keys.length && keys[j]!.t <= close) j++;
    const n = j - i;
    for (let k = i; k < j; k++) {
      send.push(close - keys[k]!.t);
      ack.push(close + rtt - keys[k]!.t);
    }
    busyUntil = close + rtt;
    commits++;
    bytes += submitBytes(n, stepBytes);
    maxKeys.push(n);
    i = j;
  }
  const a = [...ack].sort((x, y) => x - y);
  const minutes = (keys[keys.length - 1]!.t - keys[0]!.t) / 60000;
  return {
    commits: commits / minutes,
    bytes: bytes / minutes,
    meanSend: send.reduce((x, y) => x + y, 0) / send.length,
    meanAck: ack.reduce((x, y) => x + y, 0) / ack.length,
    p99Ack: percentile(a, 0.99),
    meanKeys: keys.length / commits,
    maxKeys: Math.max(...maxKeys),
    maxInFlightWait: 0,
  };
}

async function typingSection(): Promise<void> {
  const base = schema.nodeFromJSON((await load('pages-1')).doc);
  const one = typedSteps(base, 1);
  const stepBytes = JSON.stringify(stepsToJson(one.steps)[0]).length;
  const keys = typingTrace(10 * 60_000);
  const gaps = keys.slice(1).map((k, i) => k.t - keys[i]!.t);
  console.log('## Batching window (SYN-038 criterion 1; 04 §12)\n');
  console.log(
    `Simulation on a synthetic trace of ${keys.length} keystrokes over 10 minutes (seed ${process.argv[3] ?? 1}): bursts of 15 to 60 keys, key gaps lognormal with median 180 ms and sigma 0.45, pauses of 1 to 4 s between bursts. ` +
      `These parameters are assumptions of the model, not a recording; the trace's own median gap is ${f(
        percentile(
          [...gaps].sort((a, b) => a - b),
          0.5,
        ),
        0,
      )} ms. ` +
      `One keystroke is one \`replace\` step of ${stepBytes} bytes (measured); a submit adds the envelope. The link is 100 ms round trip; one commit in flight. ` +
      '"To ack" is the time from a keystroke to its acknowledgement, which is the wait in the window plus the round trip. "Span" is the longest run of keystrokes that attribution cannot tell apart, which is the characters in one commit.\n',
  );
  console.log(
    '| Window ms | Commits per minute | Log bytes per minute | Mean ms to ack | p99 ms to ack | Mean keys per commit | Max keys per commit (span) |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const w of [0, 25, 50, 100, 200, 400, 1000]) {
    const s = simulate(keys, w, 100, stepBytes, false);
    console.log(
      `| ${w} | ${f(s.commits, 0)} | ${f(s.bytes, 0)} | ${f(s.meanAck, 0)} | ${f(s.p99Ack, 0)} | ${f(s.meanKeys, 1)} | ${s.maxKeys} |`,
    );
  }
  console.log('\n## One commit in flight against pipelining (SYN-038 criterion 5; 04 §16)\n');
  console.log(
    'The same trace, window 100 ms. "One in flight": a commit is sent after the acknowledgement of the one before. "Pipelined": a commit is sent when its window closes whatever is in flight (the server would rebase each over the ones before it, which is not modelled here). Throughput is commits per minute; latency is from a keystroke to its acknowledgement.\n',
  );
  console.log(
    '| Round trip ms | Mode | Commits per minute | Mean ms to ack | p99 ms to ack | Mean keys per commit | Max keys per commit |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const rtt of [100, 300, 1000]) {
    for (const pipelined of [false, true]) {
      const s = simulate(keys, 100, rtt, stepBytes, pipelined);
      console.log(
        `| ${rtt} | ${pipelined ? 'pipelined' : 'one in flight'} | ${f(s.commits, 0)} | ${f(s.meanAck, 0)} | ${f(s.p99Ack, 0)} | ${f(s.meanKeys, 1)} | ${s.maxKeys} |`,
      );
    }
  }
  console.log('');
}

header();
if (SECTION === 'all' || SECTION === 'hash') await hashSection();
if (SECTION === 'all' || SECTION === 'rebase') await rebaseSection();
if (SECTION === 'all' || SECTION === 'rebase' || SECTION === 'stale') staleSection();
if (SECTION === 'all' || SECTION === 'cost') await costSection();
if (SECTION === 'all' || SECTION === 'catchup') await catchupSection();
if (SECTION === 'all' || SECTION === 'typing') await typingSection();
