/**
 * The fuzz harness of SEC-059 (10 §5).
 *
 * - `SPEC_TARGETS` is the list of 10 §5 with the phase each target is due in (the story's phases).
 * - A registered target has a seed corpus, a generator and an oracle. `missingTargets` names the
 *   listed targets due by a phase that are not registered or not complete.
 * - `runTarget` replays the saved regression cases, then the seeds, then generated inputs. Every
 *   input runs under a guard: an exception (a crash or an oracle failure), an input slower than the
 *   time limit and an input that grows the heap past the memory limit all fail the run, and the
 *   input is saved under the regression directory, where the next run replays it first.
 * - The input being run is also written to an in-flight file. A hang that never returns cannot be
 *   stopped from inside the process; the runner kills it, the file stays, and the next run that
 *   sees the file saves that input as a regression case and fails.
 *
 * The limits are not set by the spec (SEC-059 Notes; ADR 0121 item 39). The defaults here are
 * proposed values: 1,000 ms per input (as fuzz-time-limit.test.ts) and 256 MiB of heap growth.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';

export type Phase = '1a' | '1b' | '2';
export const PHASES: readonly Phase[] = ['1a', '1b', '2'];

/** The fuzz targets of 10 §5, with the phase in which each must exist (SEC-059 criterion 1). */
export const SPEC_TARGETS: readonly { id: string; phase: Phase }[] = [
  { id: 'envelope-parser', phase: '1a' },
  { id: 'step-validation', phase: '1a' },
  { id: 'rebase', phase: '1a' },
  { id: 'typed-emitters', phase: '1b' },
  { id: 'math-gate', phase: '1b' },
  { id: 'rules-evaluator', phase: '2' },
  { id: 'docx-importer', phase: '2' },
];

export interface FuzzTarget<I = unknown> {
  readonly id: string;
  readonly phase: Phase;
  /** Where the seeds come from, as a path from the repository root. */
  readonly seedSource: string;
  /** The seed corpus. Read when the target runs. */
  seeds(): I[];
  /** The generator of further inputs. */
  readonly arbitrary: fc.Arbitrary<I>;
  /** Throws, or rejects, when the code under test misbehaves on `input`. */
  oracle(input: I): void | Promise<void>;
  /** Divides the number of generated inputs, for a target whose inputs are costly. */
  readonly cost?: number;
}

/**
 * The listed targets due by `phase` that are missing from `registry`, or registered without a seed
 * source, a generator or an oracle (SEC-059 criterion 5).
 */
export function missingTargets(
  registry: readonly Partial<FuzzTarget>[],
  phase: Phase,
  spec: readonly { id: string; phase: Phase }[] = SPEC_TARGETS,
): string[] {
  const due = PHASES.slice(0, PHASES.indexOf(phase) + 1);
  const missing: string[] = [];
  for (const s of spec) {
    if (!due.includes(s.phase)) continue;
    const t = registry.find((r) => r.id === s.id);
    const complete =
      !!t &&
      !!t.seedSource &&
      typeof t.seeds === 'function' &&
      !!t.arbitrary &&
      typeof t.oracle === 'function';
    if (!complete) missing.push(s.id);
  }
  return missing;
}

// ---- inputs as JSON --------------------------------------------------------------------------

/** JSON that keeps non-finite numbers and byte arrays, which JSON.stringify would lose. */
export function encodeInput(input: unknown): string {
  return JSON.stringify(
    input,
    (_k, v: unknown) => {
      if (typeof v === 'number' && !Number.isFinite(v)) return { $number: String(v) };
      if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('base64') };
      return v;
    },
    1,
  );
}

export function decodeInput(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      const o = v as { $number?: unknown; $bytes?: unknown };
      const keys = Object.keys(o);
      if (keys.length === 1 && typeof o.$number === 'string') return Number(o.$number);
      if (keys.length === 1 && typeof o.$bytes === 'string')
        return new Uint8Array(Buffer.from(o.$bytes, 'base64'));
    }
    return v;
  });
}

// ---- running ---------------------------------------------------------------------------------

export type FailureKind = 'crash' | 'oracle' | 'hang' | 'memory';

export interface RunOptions {
  /** Generated inputs, before the target's `cost` divides it. */
  runs: number;
  /** Wall-clock limit for one input, in milliseconds. */
  limitMs: number;
  /** Limit on the growth of the used heap over one input, in bytes. */
  heapLimitBytes: number;
  /** Where regression cases are kept, one folder per target. */
  regressionsDir: string;
  /** Where the input being run is written. */
  inflightDir: string;
  /** fast-check seed, for a run that must repeat. */
  seed?: number;
}

export interface RunReport {
  regressions: number;
  seeds: number;
  generated: number;
}

export class FuzzFailure extends Error {
  override name = 'FuzzFailure';
  readonly kind: FailureKind;
  readonly file: string;
  constructor(target: string, kind: FailureKind, file: string, detail: string) {
    super(`fuzz target ${target}: ${kind}: ${detail}; input saved at ${file}`);
    this.kind = kind;
    this.file = file;
  }
}

function save(dir: string, target: string, kind: string, detail: string, input: unknown): string {
  const encoded = encodeInput(input);
  const digest = createHash('sha256').update(encoded).digest('hex').slice(0, 16);
  const folder = join(dir, target);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${digest}.json`);
  if (!existsSync(file))
    writeFileSync(
      file,
      `{"target":${JSON.stringify(target)},"kind":${JSON.stringify(kind)},"detail":${JSON.stringify(detail.slice(0, 400))},"input":${encoded}}\n`,
    );
  return file;
}

/** The regression cases saved for a target, oldest name first. */
export function savedRegressions(dir: string, target: string): { file: string; input: unknown }[] {
  const folder = join(dir, target);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => {
      const file = join(folder, n);
      return { file, input: (decodeInput(readFileSync(file, 'utf8')) as { input: unknown }).input };
    });
}

function kindOf(e: unknown): FailureKind {
  const name = e instanceof Error ? e.name : '';
  return name === 'AssertionError' || name === 'OracleFailure' ? 'oracle' : 'crash';
}

/** What a guard found wrong with one input, or null. */
async function examine<I>(
  target: FuzzTarget<I>,
  input: I,
  o: RunOptions,
  inflight: string,
): Promise<{ kind: FailureKind; detail: string } | null> {
  writeFileSync(inflight, encodeInput(input));
  const heap = process.memoryUsage().heapUsed;
  const start = performance.now();
  try {
    await target.oracle(input);
  } catch (e) {
    rmSync(inflight, { force: true });
    return { kind: kindOf(e), detail: e instanceof Error ? e.message : String(e) };
  }
  const elapsed = performance.now() - start;
  const grown = process.memoryUsage().heapUsed - heap;
  rmSync(inflight, { force: true });
  if (elapsed > o.limitMs)
    return {
      kind: 'hang',
      detail: `${elapsed.toFixed(0)} ms on one input (limit ${o.limitMs} ms)`,
    };
  if (grown > o.heapLimitBytes)
    return {
      kind: 'memory',
      detail: `the heap grew by ${grown} bytes on one input (limit ${o.heapLimitBytes})`,
    };
  return null;
}

/**
 * Runs one target. Rejects with a `FuzzFailure` on the first failing input, after saving it; the
 * generated input saved is the one fast-check shrank the failure to.
 */
export async function runTarget<I>(target: FuzzTarget<I>, o: RunOptions): Promise<RunReport> {
  mkdirSync(o.inflightDir, { recursive: true });
  const inflight = join(o.inflightDir, `${target.id}.json`);
  if (existsSync(inflight)) {
    // The last run died while this input was running: a hang or a kill.
    const input = decodeInput(readFileSync(inflight, 'utf8'));
    rmSync(inflight, { force: true });
    const detail = 'the previous run did not return from this input';
    throw new FuzzFailure(
      target.id,
      'hang',
      save(o.regressionsDir, target.id, 'hang', detail, input),
      detail,
    );
  }
  const fail = (f: { kind: FailureKind; detail: string }, input: unknown): never => {
    throw new FuzzFailure(
      target.id,
      f.kind,
      save(o.regressionsDir, target.id, f.kind, f.detail, input),
      f.detail,
    );
  };
  const regressions = savedRegressions(o.regressionsDir, target.id);
  const seeds = target.seeds();
  // One unmeasured call, so that lazy loading is not counted against the first input.
  if (seeds.length) await Promise.resolve(target.oracle(seeds[0] as I)).catch(() => {});
  for (const r of regressions) {
    const f = await examine(target, r.input as I, o, inflight);
    if (f) fail(f, r.input);
  }
  for (const s of seeds) {
    const f = await examine(target, s, o, inflight);
    if (f) fail(f, s);
  }
  const numRuns = Math.max(0, Math.ceil(o.runs / (target.cost ?? 1)));
  if (numRuns > 0) {
    let last: { kind: FailureKind; detail: string } | null = null;
    const out = await fc.check(
      fc.asyncProperty(target.arbitrary, async (input) => {
        const f = await examine(target, input, o, inflight);
        if (f) last = f;
        return f === null;
      }),
      { numRuns, ...(o.seed === undefined ? {} : { seed: o.seed }) },
    );
    if (out.failed) {
      const input = out.counterexample?.[0];
      // `last` is the finding on the last input that failed, which is the shrunk counterexample.
      fail(last ?? { kind: 'crash', detail: 'the property failed' }, input);
    }
  }
  return { regressions: regressions.length, seeds: seeds.length, generated: numRuns };
}

/** Walks a JSON value, parents before children. */
export function walkJson(value: unknown, visit: (v: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) for (const x of value) walkJson(x, visit);
  else if (value && typeof value === 'object')
    for (const x of Object.values(value)) walkJson(x, visit);
}
