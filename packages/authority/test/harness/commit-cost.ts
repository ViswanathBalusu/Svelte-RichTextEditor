// The cost of one commit through the room, stage by stage (SYN-040; 04 §5 steps 2 to 7, 04 §12).
//
// The harness drives the real `Room` on a corpus document (FND-006) and reads the clock around each
// stage through `RoomInit.stageProfile`. A commit is built outside the timed span; `submit` and
// `writeCompleted` are timed whole as well. Times are wall-clock milliseconds on one thread taken
// with `performance.now()`, not CPU time, and include any garbage collection inside the span: on an
// otherwise idle machine the two agree to within the clock's noise, and a measurement must say
// where it was taken (see `describeMachine`).
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { loadDocument } from '@docedit/corpus';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { ReplaceStep, type Step } from 'prosemirror-transform';
import { DEFAULT_LIMITS } from '../../src/codes.ts';
import type { PermissionState } from '../../src/permissions/model.ts';
import { Room, type CommitStage } from '../../src/room/room.ts';
import type { RoomConnection } from '../../src/room/types.ts';
import { stepsToJson } from '../../src/steps.ts';

export const STAGES: readonly CommitStage[] = [
  'dedupe',
  'base',
  'validate',
  'rebase',
  'apply',
  'invariants',
  'permissions',
];

/** Step numbers of 04 §5 for each stage; `validate` is the step-JSON check that precedes step 4. */
export const STAGE_STEP: Record<CommitStage, string> = {
  dedupe: '2',
  base: '3',
  validate: '3a',
  rebase: '4',
  apply: '5',
  invariants: '6',
  permissions: '7',
};

export type CommitKind = 'typical' | 'rebased' | 'worst';

export interface Quantiles {
  median: number;
  p99: number;
}

export interface CommitCost {
  doc: string;
  kind: CommitKind;
  steps: number;
  runs: number;
  accepted: number;
  refused: number;
  reason: string;
  /** Stages 2 to 7 (and the step-JSON check), by stage; `rebase` is zero for a commit at the head. */
  stages: Record<CommitStage, Quantiles>;
  /** The sum of the stages of one commit, then its median and 99th percentile. */
  stagesTotal: Quantiles;
  /** The whole `submit` call and the `writeCompleted` call that follows it. */
  submit: Quantiles;
  complete: Quantiles;
}

export interface CostOptions {
  docs?: readonly string[];
  /** Runs per commit kind. */
  runs?: Partial<Record<CommitKind, number>>;
  seed?: number;
  /** Commits stored between a rebased commit's base and its submission. */
  rebaseDistance?: number;
  /** Runs before the timed ones (default 5). */
  warmup?: number;
  /** Steps of the worst-case commit (the limit of DEFAULT_LIMITS by default). */
  worstSteps?: number;
}

export const DEFAULT_DOCS = ['pages-1', 'pages-20', 'pages-100'] as const;
export const DEFAULT_RUNS: Record<CommitKind, number> = { typical: 100, rebased: 20, worst: 5 };

const schema = cdmSchema();
const OWNER: RoomConnection = {
  sub: 'bench-owner',
  session: 's-bench-owner',
  role: 'owner',
  groups: [],
  participantRoles: [],
  participantActive: false,
};
const PERMS: PermissionState = {
  revision: 1,
  grants: [],
  regionStates: new Map(),
  leases: [],
  documentState: 'active',
  workflowActive: false,
};

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function quantiles(values: readonly number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), p99: quantile(sorted, 0.99) };
}

/** mulberry32, so that runs are repeatable for one seed. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Positions inside paragraphs that hold text, with room for one character. */
function insertionPoints(doc: Node): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'paragraph' && n.content.size >= 2) out.push(pos + 1);
    return true;
  });
  return out;
}

/** `count` single-character inserts at places of `doc`, each mapped over the earlier ones. */
function buildInserts(doc: Node, count: number, rand: () => number): Step[] {
  const points = insertionPoints(doc);
  const steps: Step[] = [];
  const picked = Array.from({ length: count }, () => points[Math.floor(rand() * points.length)]!);
  // From the end of the document to the start, so that no step moves the place of another.
  picked.sort((a, b) => b - a);
  for (const p of picked) {
    steps.push(new ReplaceStep(p, p, new Slice(Fragment.from(schema.text('x')), 0, 0)));
  }
  return steps;
}

let counter = 0;
const nextId = () => `0192f0c4-7b1e-7000-b000-${(++counter).toString(16).padStart(12, '0')}`;

/** Measures one commit kind on one document. */
export async function measureCommit(
  docName: string,
  kind: CommitKind,
  opts: CostOptions = {},
): Promise<CommitCost> {
  const { envelope } = await loadDocument(docName);
  const initial = schema.nodeFromJSON(envelope.doc);
  const rand = rng(opts.seed ?? 1);
  const runs = opts.runs?.[kind] ?? DEFAULT_RUNS[kind];
  const worstSteps = opts.worstSteps ?? DEFAULT_LIMITS.maxStepsPerCommit;
  const distance = opts.rebaseDistance ?? 10;
  const stepCount = kind === 'worst' ? worstSteps : 1;

  let recording = false;
  let bucket: Partial<Record<CommitStage, number>> = {};
  let clockTick = 1_790_300_000_000;
  const room = new Room({
    schema,
    initial,
    requires: envelope.requires,
    log: [],
    perms: PERMS,
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-bench',
    now: () => ++clockTick,
    stageProfile: {
      clock: () => performance.now(),
      record: (stage, ms) => {
        if (recording) bucket[stage] = (bucket[stage] ?? 0) + ms;
      },
    },
  });
  room.open('b1', OWNER);

  const stageTimes = Object.fromEntries(STAGES.map((s) => [s, [] as number[]])) as Record<
    CommitStage,
    number[]
  >;
  const totals: number[] = [];
  const submits: number[] = [];
  const completes: number[] = [];
  let accepted = 0;
  let refused = 0;
  let reason = '';

  const store = (steps: Step[], base: number): { ok: boolean; why: string } => {
    const fx = room.submit('b1', { id: nextId(), base, steps: stepsToJson(steps) });
    const rejected = fx.send.find((o) => o.msg.t === 'sync.reject');
    if (rejected || fx.write === null) {
      const msg = rejected?.msg as { code?: string } | undefined;
      return { ok: false, why: msg?.code ?? 'no write' };
    }
    return { ok: true, why: '' };
  };

  const warmup = Math.min(opts.warmup ?? 5, runs);
  for (let i = 0; i < runs + warmup; i++) {
    recording = false;
    const base = room.head;
    const doc = room.document;
    const steps = buildInserts(doc, stepCount, rand);
    if (kind === 'rebased') {
      // Commits from others reach the log first, so that this one is rebased over them.
      for (let k = 0; k < distance; k++) {
        const other = store(buildInserts(room.document, 1, rand), room.head);
        if (other.ok) room.writeCompleted({ status: 'ok' });
      }
    }
    bucket = {};
    recording = i >= warmup;
    const t0 = performance.now();
    const fx = room.submit('b1', { id: nextId(), base, steps: stepsToJson(steps) });
    const t1 = performance.now();
    const rejected = fx.send.find((o) => o.msg.t === 'sync.reject');
    if (fx.write !== null) room.writeCompleted({ status: 'ok' });
    const t2 = performance.now();
    if (!recording) continue;
    if (rejected || fx.write === null) {
      refused++;
      reason ||= (rejected?.msg as { code?: string } | undefined)?.code ?? 'no write';
    } else accepted++;
    let sum = 0;
    for (const s of STAGES) {
      const v = bucket[s] ?? 0;
      stageTimes[s].push(v);
      sum += v;
    }
    totals.push(sum);
    submits.push(t1 - t0);
    completes.push(t2 - t1);
  }

  return {
    doc: docName,
    kind,
    steps: stepCount,
    runs,
    accepted,
    refused,
    reason,
    stages: Object.fromEntries(STAGES.map((s) => [s, quantiles(stageTimes[s])])) as Record<
      CommitStage,
      Quantiles
    >,
    stagesTotal: quantiles(totals),
    submit: quantiles(submits),
    complete: quantiles(completes),
  };
}

export async function measureAll(opts: CostOptions = {}): Promise<CommitCost[]> {
  const out: CommitCost[] = [];
  for (const doc of opts.docs ?? DEFAULT_DOCS)
    for (const kind of ['typical', 'rebased', 'worst'] as const)
      out.push(await measureCommit(doc, kind, opts));
  return out;
}

export function describeMachine(): string {
  const cpu = cpus();
  return `${cpu[0]?.model ?? 'unknown CPU'}, ${cpu.length} logical cores, ${(totalmem() / 2 ** 30).toFixed(0)} GiB, ${platform()} ${release()}, Node.js ${process.version}`;
}

const f = (n: number): string => n.toFixed(3);

/** A Markdown table of the results: one row per document and commit kind. */
export function tabulate(results: readonly CommitCost[]): string {
  const head = [
    'Document',
    'Commit',
    'Steps',
    ...STAGES.map((s) => `${STAGE_STEP[s]} ${s}`),
    'Stages total',
    'submit',
    'Accepted / refused',
  ];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of results) {
    const cell = (q: Quantiles) => `${f(q.median)} / ${f(q.p99)}`;
    const outcome = r.refused ? `${r.accepted} / ${r.refused} (${r.reason})` : `${r.accepted} / 0`;
    lines.push(
      `| ${r.doc} | ${r.kind} | ${r.steps} | ${STAGES.map((s) => cell(r.stages[s])).join(' | ')} | ${cell(r.stagesTotal)} | ${cell(r.submit)} | ${outcome} |`,
    );
  }
  return lines.join('\n');
}
