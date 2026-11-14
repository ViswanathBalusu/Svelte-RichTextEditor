// The size and cost of the attribution map on large documents (spike HIS-044): one map per document
// (`AttributionMap`) against a map stored per block (`BlockAttribution`). Run from the repository
// root, with the garbage collector exposed so that memory can be measured:
//
//   node --expose-gc packages/history/scripts/attribution-size.ts [commits per page] [seed]
//
// For each corpus document of 20, 100, 300 and 1,000 pages a synthetic trace (scripts/trace.ts) of
// `commits per page` × pages commits (default 20) is made by six people and an assistant, and every
// 250 commits one region is restored to its content 250 commits earlier (planRestore, with the
// original authors kept as the hint). Both maps are kept up to date step by step. The script then
// records the number of runs, the memory of a map rebuilt from its serialised form (heap used
// before and after, with a collection each time), the serialised size raw and Zstandard-compressed
// (as checkpoints are stored, 06 §4.2), the time to apply one step (median / 95th percentile /
// maximum) and the time to answer "who wrote this" for each region.
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { zstdCompressSync } from 'node:zlib';
import { type Connection, computeAccess, regionInfos } from '@docedit/authority';
import { corpusLabel, loadDocument } from '@docedit/corpus';
import type { Node } from 'prosemirror-model';
import { Mapping } from 'prosemirror-transform';
import { AttributionMap, type Run } from '../src/attribution.ts';
import { BlockAttribution } from '../src/per-block.ts';
import { planRestore } from '../src/restore.ts';
import { TraceMaker, machine, schema, stats } from './trace.ts';

const PER_PAGE = Number(process.argv[2] ?? 20);
const SEED = Number(process.argv[3] ?? 44);
const RESTORE_EVERY = 250;
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error('run with node --expose-gc');
  process.exit(2);
}

const owner: Connection = {
  sub: 'u_alice',
  session: 's-alice',
  role: 'owner',
  groups: [],
  participantRoles: [],
  participantActive: false,
};
const perms = {
  revision: 1,
  grants: [],
  regionStates: new Map(),
  leases: [],
  documentState: 'active' as const,
  workflowActive: false,
};

function heap(): number {
  gc!();
  gc!();
  return process.memoryUsage().heapUsed;
}

function regionsOf(doc: Node): string[] {
  const out: string[] = [];
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name === 'region') out.push(String(c.attrs['id']));
  });
  return out;
}

function regionRange(doc: Node, id: string): [number, number] | null {
  const body = doc.child(doc.childCount - 1);
  let pos = doc.content.size - body.nodeSize + 1;
  for (let i = 0; i < body.childCount; i++) {
    const c = body.child(i);
    if (c.type.name === 'region' && c.attrs['id'] === id) return [pos, pos + c.nodeSize];
    pos += c.nodeSize;
  }
  return null;
}

console.log(`Machine: ${machine(cpus, totalmem(), platform(), release())}`);
console.log(
  `Corpus: ${corpusLabel()}; ${PER_PAGE} commits per page; a region restore every ${RESTORE_EVERY} commits; seed ${SEED}`,
);
console.log(
  '| Document | Commits | Restores | Map | Runs | Memory (MiB) | Serialised (KiB) | Zstandard (KiB) | Step (ms, median / p95 / max) | Who wrote this, one region (ms, median / p95) |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|');

for (const name of ['pages-20', 'pages-100', 'pages-300', 'pages-1000']) {
  const { envelope, entry } = await loadDocument(name);
  const pages = entry.pages.measured ?? entry.pages.estimated;
  const start = schema.nodeFromJSON(envelope.doc);
  const commits = PER_PAGE * Number(name.slice(6));
  const maker = new TraceMaker(start, SEED);
  const map = AttributionMap.create(start.content.size, { user: 'u_owner', seq: 0 });
  const perBlock = BlockAttribution.fromMap(map, start);
  const docTimes: number[] = [];
  const blockTimes: number[] = [];
  let doc = start;
  let previous = { seq: 0, doc: start, map: map.clone() };
  let restores = 0;
  let seq = 0;
  const regions = regionsOf(start);
  // The trace's commits, with a region restore every RESTORE_EVERY commits.
  for (let k = 1; k <= commits; k++) {
    const x = maker.next(doc, seq + 1);
    if (!x) continue;
    seq++;
    const author = {
      user: x.commit.user,
      seq,
      ...(x.commit.agent ? { agent: x.commit.agent } : {}),
    };
    for (const s of x.steps) {
      const r = s.apply(doc);
      if (!r.doc) throw new Error(`${name}: a trace step does not apply`);
      let t0 = performance.now();
      map.applyStep(s, author);
      docTimes.push(performance.now() - t0);
      t0 = performance.now();
      perBlock.applyStep(s, author, r.doc);
      blockTimes.push(performance.now() - t0);
      doc = r.doc;
    }
    if (k % RESTORE_EVERY === 0 && regions.length) {
      // The next region, in turn, that changed since the last restore point.
      const range = (d: Node, id: string) => {
        const r = regionRange(d, id);
        return r ? d.nodeAt(r[0]) : null;
      };
      let region: string | undefined;
      for (let i = 0; i < regions.length && !region; i++) {
        const id = regions[(k / RESTORE_EVERY + i) % regions.length]!;
        const was = range(previous.doc, id);
        const now = range(doc, id);
        if (was && now && !was.eq(now)) region = id;
      }
      if (!region) {
        previous = { seq, doc, map: map.clone() };
        continue;
      }
      const plan = planRestore(
        { toSeq: previous.seq, region },
        {
          schema,
          head: { seq, doc, attribution: map },
          target: () => ({ doc: previous.doc, attribution: previous.map }),
          gate: { min: 0, head: seq },
          hidden: { regions: new Set(), values: new Set(), titles: false },
          access: computeAccess(owner, regionInfos(doc), perms, 0),
          user: owner.sub,
        },
      );
      if (plan.ok && plan.plan.kind === 'steps' && !plan.plan.unchanged) {
        seq++;
        const author = { user: owner.sub, seq };
        const steps = plan.plan.steps;
        const hints = plan.plan.hint;
        const mapping = new Mapping();
        steps.forEach((s, i) => {
          const r = s.apply(doc);
          if (!r.doc) throw new Error(`${name}: a restore step does not apply`);
          let t0 = performance.now();
          map.applyStep(s, author, hints[i]);
          docTimes.push(performance.now() - t0);
          t0 = performance.now();
          perBlock.applyStep(s, author, r.doc, hints[i]);
          blockTimes.push(performance.now() - t0);
          mapping.appendMap(s.getMap());
          doc = r.doc;
        });
        maker.external(mapping);
        restores++;
      } else if (!plan.ok) throw new Error(`${name}: a restore was refused: ${plan.reason}`);
      previous = { seq, doc, map: map.clone() };
    }
  }
  if (map.size !== doc.content.size)
    throw new Error(`${name}: the map does not cover the document`);
  // The per-block map gives the same runs, apart from cuts at block edges.
  const merged = (runs: readonly Run[]) => AttributionMap.fromRuns(runs).toJSON();
  if (JSON.stringify(merged(perBlock.toMap().runs())) !== JSON.stringify(merged(map.runs())))
    throw new Error(`${name}: the per-block map differs from the document map`);
  // Memory: COPIES maps rebuilt from the serialised form between two collections, divided by
  // COPIES; the median of three such measurements.
  const COPIES = 5;
  const json = map.toJSON();
  const text = JSON.stringify(json);
  const median3 = (f: () => number) => {
    const xs = [f(), f(), f()].sort((a, b) => a - b);
    return xs[1]!;
  };
  const rebuilt = AttributionMap.fromJSON(JSON.parse(text));
  const memDoc = median3(() => {
    const before = heap();
    const keep = Array.from({ length: COPIES }, () => AttributionMap.fromJSON(JSON.parse(text)));
    const used = heap() - before;
    return keep.length ? used / COPIES : 0;
  });
  const blockJson = JSON.stringify(perBlock.toJSON());
  const rebuiltBlocks = BlockAttribution.fromMap(rebuilt, doc);
  const memBlock = median3(() => {
    const before = heap();
    const keep = Array.from({ length: COPIES }, () => BlockAttribution.fromMap(rebuilt, doc));
    const used = heap() - before;
    return keep.length ? used / COPIES : 0;
  });
  // Who wrote this, for each region: by position in the document map, by identifier per block.
  const finalRegions = regionsOf(doc);
  const askDoc: number[] = [];
  const askBlock: number[] = [];
  for (let rep = 0; rep < 5; rep++)
    for (const id of finalRegions) {
      let t0 = performance.now();
      const range = regionRange(doc, id);
      if (range) rebuilt.slice(range[0], range[1]);
      askDoc.push(performance.now() - t0);
      t0 = performance.now();
      rebuiltBlocks.runsOf(id);
      askBlock.push(performance.now() - t0);
    }
  const kib = (n: number) => (n / 1024).toFixed(1);
  const mib = (n: number) => (n / 2 ** 20).toFixed(2);
  const row = (
    label: string,
    runs: number,
    mem: number,
    raw: string,
    step: number[],
    ask: number[],
  ) =>
    console.log(
      `| ${name} (${pages} pages) | ${seq} | ${restores} | ${label} | ${runs} | ${mib(mem)} | ${kib(Buffer.byteLength(raw))} | ${kib(zstdCompressSync(Buffer.from(raw)).length)} | ${stats(step, 4)} / ${Math.max(...step).toFixed(3)} | ${stats(ask, 4)} |`,
    );
  row('per document', rebuilt.runCount, memDoc, text, docTimes, askDoc);
  row('per block', rebuiltBlocks.runCount, memBlock, blockJson, blockTimes, askBlock);
}
