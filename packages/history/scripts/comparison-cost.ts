// The cost of a comparison (spike HIS-043, criterion 2): documents of 20 and 100 pages of the shared
// corpus, ranges of 100 and 2,000 commits, both methods. Run from the repository root:
//
//   node packages/history/scripts/comparison-cost.ts [commits] [samples] [seed]
//
// A synthetic trace of `commits` commits (default 3,000) is made on each document (scripts/
// trace.ts). For each range size, `samples` ranges (default 30 of 100 commits and 10 of 2,000)
// start at random commits; each is compared once from the recorded steps (`compareSteps`) and once
// by aligning blocks (`compareStates`, with the attribution map at the later version). Times are
// wall-clock milliseconds in one process, median / 95th percentile.
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { corpusLabel, loadDocument } from '@docedit/corpus';
import { AttributionMap } from '../src/attribution.ts';
import { compareStates, compareSteps } from '../src/compare.ts';
import { generator, machine, schema, stats, trace } from './trace.ts';

const COMMITS = Number(process.argv[2] ?? 3000);
const SAMPLES = Number(process.argv[3] ?? 0);
const SEED = Number(process.argv[4] ?? 43);

console.log(`Machine: ${machine(cpus, totalmem(), platform(), release())}`);
console.log(`Corpus: ${corpusLabel()}; trace of ${COMMITS} commits per document; seed ${SEED}`);
console.log('Times in ms as median / p95.');
console.log(
  '| Document | Body children | Range (commits) | Samples | Steps method | Aligned method | Changes (median) |',
);
console.log('|---|---|---|---|---|---|---|');

for (const name of ['pages-20', 'pages-100']) {
  const { envelope } = await loadDocument(name);
  const doc = schema.nodeFromJSON(envelope.doc);
  const t = trace(doc, COMMITS, SEED);
  const docs = [doc, ...t.map((x) => x.doc)];
  const rand = generator(SEED + 1);
  for (const range of [100, 2000]) {
    if (range > t.length) continue;
    const samples = SAMPLES || (range === 100 ? 30 : 10);
    const froms = Array.from({ length: samples }, () =>
      Math.floor(rand() * (t.length - range + 1)),
    );
    // The attribution maps at the later versions, built by one pass over the trace.
    const wanted = new Set(froms.map((f) => f + range));
    const maps = new Map<number, AttributionMap>();
    const live = AttributionMap.create(doc.content.size, { user: 'u_owner', seq: 0 });
    t.forEach((x, i) => {
      for (const s of x.steps) live.applyStep(s, { user: x.commit.user, seq: x.commit.seq });
      if (wanted.has(i + 1)) maps.set(i + 1, live.clone());
    });
    const stepTimes: number[] = [];
    const alignedTimes: number[] = [];
    const changes: number[] = [];
    for (const from of froms) {
      const to = from + range;
      const commits = t.slice(from, to).map((x) => x.commit);
      let t0 = performance.now();
      const s = compareSteps({ schema, from: { seq: from, doc: docs[from]! }, commits });
      stepTimes.push(performance.now() - t0);
      t0 = performance.now();
      const a = compareStates({
        from: { seq: from, doc: docs[from]! },
        to: { seq: to, doc: docs[to]!, attribution: maps.get(to)! },
      });
      alignedTimes.push(performance.now() - t0);
      if (!s.ok || !a.ok)
        throw new Error(`${name} ${from}-${to}: ${!s.ok ? s.reason : !a.ok ? a.reason : ''}`);
      changes.push(s.comparison.changes.length);
    }
    const bodyChildren = doc.child(doc.childCount - 1).childCount;
    changes.sort((x, y) => x - y);
    console.log(
      `| ${name} | ${bodyChildren} | ${range} | ${samples} | ${stats(stepTimes, 1)} | ${stats(alignedTimes, 1)} | ${changes[Math.floor(changes.length / 2)]} |`,
    );
  }
}
