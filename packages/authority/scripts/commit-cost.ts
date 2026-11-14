// The cost of validating, applying and checking one commit, per step type, on the shared corpus
// (FND-006), for SYN-040 criterion 1 (04 §12). Run from the repository root:
//
//   node packages/authority/scripts/commit-cost.ts [typical runs] [worst-case runs] [seed]
//
// The step types are the seven of the allow-list (04 §4). "Steps 2 to 7" of SYN-040 are the six
// types after `replace`, in the allow-list's order; each is measured on its own, and `replace`
// (the typical commit of the target: one `replace` step of one character) is measured too.
// For each document (1, 20 and 100 pages) and each type, two commits are built on a base document:
//
// - typical: one step of the type;
// - worst case: 500 steps of the type (the limit of DEFAULT_LIMITS), or the most the document
//   allows when it has fewer eligible places, which is printed as "n of 500".
//
// Some types need their targets in place first (removeMark needs bold text, removeNodeMark a
// marked paragraph, replaceAround a region to unwrap). That preparation builds the base and is
// not timed. A step the schema refuses while it is built is skipped and another place is tried.
//
// A commit is timed from its JSON to its checked outcome: `parseSteps` (validation), `applySteps`
// (apply), and `checkInvariants`. The base is the head of the log, so no rebase is measured; the
// rebase cost is SYN-010's. Times are wall-clock milliseconds taken with `performance.now()` on
// one thread in one process, not CPU time, and include whatever garbage collection falls inside
// the timed span. Each commit's cell gives the median and the 99th percentile, and the count of
// commits the authority accepted or refused, so that a refused commit is not read as a fast one.
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { loadDocument } from '@docedit/corpus';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Node } from 'prosemirror-model';
import { Slice } from 'prosemirror-model';
import { ReplaceAroundStep, Transform, type Step } from 'prosemirror-transform';
import { DEFAULT_LIMITS } from '../src/codes.ts';
import { checkInvariants } from '../src/invariants.ts';
import { applySteps } from '../src/rebase.ts';
import { ALLOWED_STEP_TYPES, parseSteps, stepsToJson } from '../src/steps.ts';

const schema = cdmSchema();
const TYPICAL_RUNS = Number(process.argv[2] ?? 300);
const WORST_RUNS = Number(process.argv[3] ?? 20);
let seed = Number(process.argv[4] ?? 1);
const DOCS = ['pages-1', 'pages-20', 'pages-100'];
const WORST_STEPS = DEFAULT_LIMITS.maxStepsPerCommit;
const INVARIANT_CONTEXT = { requires: [], retiredRegionIds: new Set<string>() };
const BENCH_MARK = () => schema.marks['del']!.create({ id: 'bench', user: 'bench' });

/** mulberry32, so that runs are repeatable for one seed. */
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Positions (before the node) of paragraphs with text, optionally only those at body level. */
function paragraphs(doc: Node, atBodyLevel: boolean): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'paragraph' && n.content.size >= 6) {
      if (!atBodyLevel || doc.resolve(pos).depth === 1) out.push(pos);
    }
    return true;
  });
  return out;
}

/** Positions (before the node) of regions at body level. */
function bodyRegions(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'region' && doc.resolve(pos).depth === 1) out.push(pos);
    return false;
  });
  return out;
}

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)]!;
}

/** One attempt at a step of `type` on `tr`; true when it added a step. */
function attempt(tr: Transform, type: string): boolean {
  const before = tr.steps.length;
  const doc = tr.doc;
  try {
    switch (type) {
      case 'replace': {
        const p = pick(paragraphs(doc, false));
        const size = doc.nodeAt(p)!.content.size;
        tr.insert(p + 1 + Math.floor(rand() * (size + 1)), schema.text('x'));
        break;
      }
      case 'replaceAround': {
        // Unwrap a region: its blocks move into the body (the shape of indexes.test.ts).
        const regions = bodyRegions(doc);
        if (!regions.length) return false;
        const p = pick(regions);
        const size = doc.nodeAt(p)!.nodeSize;
        tr.step(new ReplaceAroundStep(p, p + size, p + 1, p + size - 1, Slice.empty, 0, true));
        break;
      }
      case 'addMark':
      case 'removeMark': {
        const p = pick(paragraphs(doc, false));
        const size = doc.nodeAt(p)!.content.size;
        const from = p + 1 + Math.floor(rand() * (size - 4));
        if (type === 'addMark') tr.addMark(from, from + 5, schema.marks['bold']!.create());
        else tr.removeMark(from, from + 5, schema.marks['bold']!);
        break;
      }
      case 'addNodeMark': {
        const p = pick(paragraphs(doc, false));
        tr.addNodeMark(p, BENCH_MARK());
        break;
      }
      case 'removeNodeMark': {
        const marked = paragraphs(doc, false).filter((p) => doc.nodeAt(p)!.marks.length > 0);
        if (!marked.length) return false;
        const p = pick(marked);
        tr.removeNodeMark(p, doc.nodeAt(p)!.marks[0]!);
        break;
      }
      case 'attr': {
        const p = pick(paragraphs(doc, false));
        tr.setNodeAttribute(p, 'style', rand() < 0.5 ? 'Heading1' : 'LegalBody');
        break;
      }
      default:
        throw new Error(`no builder for ${type}`);
    }
  } catch {
    return false; // the schema refuses this step here: another place is tried
  }
  return tr.steps.length > before;
}

/**
 * Prepares the base for a type: the targets the commit changes must be in place. Not timed.
 */
function prepare(base: Node, type: string): Node {
  const tr = new Transform(base);
  if (type === 'removeMark') {
    for (const p of paragraphs(base, false)) {
      try {
        tr.addMark(p + 1, p + 1 + tr.doc.nodeAt(p)!.content.size, schema.marks['bold']!.create());
      } catch {
        // a paragraph that refuses bold keeps no mark to remove
      }
    }
  } else if (type === 'removeNodeMark') {
    for (const p of paragraphs(base, false)) {
      try {
        tr.addNodeMark(p, BENCH_MARK());
      } catch {
        // a paragraph that refuses the mark keeps none to remove
      }
    }
  } else if (type === 'replaceAround') {
    const counter = { n: 0 };
    for (const p of paragraphs(base, true)) {
      try {
        const $p = tr.doc.resolve(p);
        const range = $p.blockRange(tr.doc.resolve(p + tr.doc.nodeAt(p)!.nodeSize));
        if (!range) continue;
        counter.n++;
        tr.wrap(range, [{ type: schema.nodes['region']!, attrs: { id: `bench-${counter.n}` } }]);
      } catch {
        // the schema does not wrap this paragraph in a region
      }
    }
  }
  return tr.doc;
}

/** A commit of `count` steps of `type` on `base`, or fewer when the document has no more places. */
function buildCommit(base: Node, type: string, count: number): { steps: Step[]; achieved: number } {
  const tr = new Transform(base);
  let attempts = 0;
  const limit = count * 4 + 200;
  while (tr.steps.length < count && attempts < limit) {
    attempts++;
    attempt(tr, type);
  }
  return { steps: [...tr.steps], achieved: tr.steps.length };
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Times the server path for one commit, several times on the same base, after a short warm-up. */
function measure(
  base: Node,
  steps: Step[],
  runs: number,
): {
  median: number;
  p99: number;
  accepted: number;
  refused: number;
  reason: string;
} {
  const json = stepsToJson(steps);
  const times: number[] = [];
  let accepted = 0;
  let refused = 0;
  let reason = '';
  const warmup = Math.min(10, runs);
  for (let i = 0; i < runs + warmup; i++) {
    const recording = i >= warmup;
    let why = '';
    const t0 = performance.now();
    const parsed = parseSteps(schema, json, DEFAULT_LIMITS);
    if (!parsed.ok) why = parsed.code;
    else {
      const applied = applySteps(base, parsed.value);
      if (!applied.ok) why = applied.code;
      else {
        const checked = checkInvariants(
          base,
          applied.value.doc,
          parsed.value,
          applied.value.docs,
          INVARIANT_CONTEXT,
        );
        if (!checked.ok) why = checked.code;
      }
    }
    const elapsed = performance.now() - t0;
    if (!recording) continue;
    times.push(elapsed);
    if (why === '') accepted++;
    else {
      refused++;
      reason ||= why;
    }
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    accepted,
    refused,
    reason,
  };
}

const cpu = cpus();
console.log(
  `Machine: ${cpu[0]?.model ?? 'unknown'}, ${cpu.length} logical cores, ${(totalmem() / 2 ** 30).toFixed(0)} GiB, ${platform()} ${release()}, Node.js ${process.version}`,
);
console.log(
  `Corpus documents ${DOCS.join(', ')}; typical runs ${TYPICAL_RUNS}, worst-case runs ${WORST_RUNS}; seed ${process.argv[4] ?? 1}`,
);
console.log('Times are wall-clock milliseconds per commit (median and 99th percentile).');
console.log('| Document | Step type | Commit | Steps | Median ms | p99 ms | Accepted / refused |');
console.log('|---|---|---|---|---|---|---|');

const types = ['replace', ...ALLOWED_STEP_TYPES.filter((t) => t !== 'replace')];
for (const name of DOCS) {
  const { envelope } = await loadDocument(name);
  const base = schema.nodeFromJSON(envelope.doc);
  for (const type of types) {
    const prepared = prepare(base, type);
    const typical = buildCommit(prepared, type, 1);
    const worst = buildCommit(prepared, type, WORST_STEPS);
    const rows: Array<[string, { steps: Step[]; achieved: number }, number]> = [
      ['typical', typical, TYPICAL_RUNS],
      ['worst case', worst, WORST_RUNS],
    ];
    for (const [label, built, runs] of rows) {
      if (built.steps.length === 0) {
        console.log(`| ${name} | ${type} | ${label} | 0 | n/a | n/a | no eligible place |`);
        continue;
      }
      const m = measure(prepared, built.steps, runs);
      const stepsCell =
        built.achieved === (label === 'typical' ? 1 : WORST_STEPS)
          ? String(built.achieved)
          : `${built.achieved} of ${WORST_STEPS}`;
      const outcome = m.refused
        ? `${m.accepted} / ${m.refused} (refused: ${m.reason})`
        : `${m.accepted} / 0`;
      console.log(
        `| ${name} | ${type} | ${label} | ${stepsCell} | ${m.median.toFixed(3)} | ${m.p99.toFixed(3)} | ${outcome} |`,
      );
    }
  }
}
