// The cost of sending commits to visibility classes and of mapping readers' steps back, per commit
// and per class, on the shared corpus (FND-006), for spike S12 (SPK-029) and SYN-050 to SYN-052.
// Run from the repository root:
//
//   node packages/authority/scripts/projection-cost.ts [commits] [seed]
//
// For every corpus document with regions or form fields, two visibility classes are measured: half
// of the regions and values hidden, and all of them hidden with titles shown. Each commit types one
// character at a random text position of the full document (inside hidden regions too). Per commit
// and class it times:
//
// - outgoing, as the gateway does it now (`projectCommit`: the commit's own steps mapped to the
//   class's positions, nothing for a change inside a hidden region, a diff only as the fallback),
//   which also yields the class's projection after the commit;
// - outgoing as the spike did it, for comparison in the same run: the projection after the commit
//   plus one diff step between the projections;
// - incoming: mapping one character typed by a reader of that class to full positions, from the
//   class's projection (its hidden spans), as the gateway does.
//
// It prints the machine it ran on and one row per document and class, in milliseconds, and then the
// worst class against the authority's budget (04 §12: validating and applying a typical commit costs
// well under a millisecond of CPU), taken here as `BUDGET_MS` for a class's outgoing work per commit
// (SYN-050 criterion 4). The reference machine is the one of ADR 0037 (FND-007).
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { corpusLabel, documentNames, loadDocument } from '@docedit/corpus';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Mapping, Transform } from 'prosemirror-transform';
import {
  type HiddenSet,
  type Projection,
  type StepRoute,
  diffStep,
  fullToProj,
  project,
  projectCommit,
  projectionSchema,
  toFullSteps,
} from '../src/projection/projection.ts';

const schema = cdmSchema();
const pschema = projectionSchema();
const COMMITS = Number(process.argv[2] ?? 300);
/** 04 §12 gives no number below "well under a millisecond"; one millisecond is the ceiling checked. */
const BUDGET_MS = 1;
/** The class with the highest median outgoing cost, and the one with the highest 95th percentile. */
const worst = { median: 0, medianOf: '', p95: 0, p95Of: '', classes: 0 };
const quantile = (xs: number[], f: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0;
};
let seed = Number(process.argv[3] ?? 1);

/** mulberry32: a small deterministic generator, so that runs are repeatable. */
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function stats(xs: number[]): string {
  if (!xs.length) return 'n/a';
  const s = [...xs].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))]!;
  const r = (x: number) => x.toFixed(3);
  return `${r(q(0.5))} / ${r(q(0.95))} / ${r(s[s.length - 1]!)}`;
}

const cpu = cpus();
console.log(
  `Machine: ${cpu[0]?.model ?? 'unknown'}, ${cpu.length} logical cores, ${(totalmem() / 2 ** 30).toFixed(0)} GiB, ${platform()} ${release()}, Node.js ${process.version}`,
);
console.log(
  `Corpus: ${corpusLabel()}; ${COMMITS} commits per document; seed ${process.argv[3] ?? 1}`,
);
console.log('Times in ms as median / p95 / max.');
console.log(
  '| Document | Body children | Class | Hidden regions, values | Cold projection | Apply on full (baseline) | Outgoing: mapped steps (now) | Outgoing: projection + diff (spike) | Incoming: map one step | Routes: mapped, inside, diff | Empty commits |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|');

for (const name of documentNames) {
  const { envelope } = await loadDocument(name);
  let doc = schema.nodeFromJSON(envelope.doc);
  const regions: string[] = [];
  const fields: string[] = [];
  const blocks: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'region') regions.push(String(n.attrs['id']));
    if (n.type.name === 'form_field') fields.push(String(n.attrs['id']));
    if (n.isTextblock) blocks.push(pos);
    return true;
  });
  const bodyChildren = doc.child(doc.childCount - 1).childCount;
  if (!regions.length && !fields.length) {
    console.log(
      `| ${name} | ${bodyChildren} | none | 0, 0 | nothing to hide: readers share the full document | | | | | | |`,
    );
    continue;
  }
  const classes: Array<{ label: string; hidden: HiddenSet }> = [
    {
      label: 'half hidden',
      hidden: {
        regions: new Set(regions.filter((_, i) => i % 2 === 0)),
        values: new Set(fields.filter((_, i) => i % 2 === 0)),
        titles: false,
      },
    },
    {
      label: 'all hidden',
      hidden: { regions: new Set(regions), values: new Set(fields), titles: true },
    },
  ];
  const views: Projection[] = [];
  const cold = classes.map((c) => {
    const t = performance.now();
    views.push(project(doc, c.hidden, pschema));
    return performance.now() - t;
  });
  const apply: number[] = [];
  const outgoing = classes.map(() => [] as number[]);
  const spike = classes.map(() => [] as number[]);
  const incoming = classes.map(() => [] as number[]);
  const routes = classes.map(() => new Map<StepRoute, number>());
  const empty = classes.map(() => 0);
  const mapping = new Mapping();
  for (let i = 0; i < COMMITS; i++) {
    const start = mapping.map(blocks[Math.floor(rand() * blocks.length)]!, 1);
    const block = doc.nodeAt(start);
    if (!block?.isTextblock) continue;
    const at = start + 1 + Math.floor(rand() * (block.content.size + 1));
    const t0 = performance.now();
    const tr = new Transform(doc);
    try {
      tr.insert(at, schema.text('x'));
    } catch {
      continue;
    }
    apply.push(performance.now() - t0);
    if (!tr.steps.length) continue;
    mapping.appendMapping(tr.mapping);
    const next = tr.doc;
    classes.forEach((c, ci) => {
      // Now: the commit's steps for this class, from the class's projection before it.
      const t1 = performance.now();
      const r = projectCommit(views[ci]!, doc, tr.steps, c.hidden, pschema);
      outgoing[ci]!.push(performance.now() - t1);
      views[ci] = r.view;
      for (const route of r.routes) routes[ci]!.set(route, (routes[ci]!.get(route) ?? 0) + 1);
      if (r.steps.length === 0) empty[ci]!++;
      // The spike: the projection after the commit and one diff step.
      const t2 = performance.now();
      const before = project(doc, c.hidden, pschema).doc;
      const after = project(next, c.hidden, pschema);
      diffStep(before, after.doc);
      spike[ci]!.push(performance.now() - t2);
      // A reader of this class types one character at the same place, when they can see it.
      const q = fullToProj(r.view, at + 1);
      if (q === null) return;
      const steps = new Transform(r.view.doc).insert(q, pschema.text('y')).steps;
      const t3 = performance.now();
      const m = toFullSteps(steps, next, c.hidden, pschema, schema, r.view);
      incoming[ci]!.push(performance.now() - t3);
      if (!m.ok) throw new Error(`${name}: a visible edit was refused: ${m.reason}`);
    });
    doc = next;
  }
  classes.forEach((c, ci) => {
    const rt = routes[ci]!;
    const med = quantile(outgoing[ci]!, 0.5);
    const p95 = quantile(outgoing[ci]!, 0.95);
    worst.classes++;
    if (med > worst.median) Object.assign(worst, { median: med, medianOf: `${name}, ${c.label}` });
    if (p95 > worst.p95) Object.assign(worst, { p95, p95Of: `${name}, ${c.label}` });
    console.log(
      `| ${name} | ${bodyChildren} | ${c.label} | ${c.hidden.regions.size}, ${c.hidden.values.size} | ${cold[ci]!.toFixed(1)} | ${stats(apply)} | ${stats(outgoing[ci]!)} | ${stats(spike[ci]!)} | ${stats(incoming[ci]!)} | ${rt.get('mapped') ?? 0}, ${rt.get('inside') ?? 0}, ${rt.get('diff') ?? 0} | ${empty[ci]} of ${outgoing[ci]!.length} |`,
    );
  });
}

console.log(
  `Budget (04 §12): under ${BUDGET_MS} ms of CPU per commit. Outgoing work per class and commit over ${worst.classes} classes: highest median ${worst.median.toFixed(3)} ms (${worst.medianOf}), highest p95 ${worst.p95.toFixed(3)} ms (${worst.p95Of}): ${worst.median < BUDGET_MS ? 'the median is within the budget' : 'the median is OVER the budget'}; ${worst.p95 < BUDGET_MS ? 'the p95 is within it' : 'the p95 is over it'}.`,
);
