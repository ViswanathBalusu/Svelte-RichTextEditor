/**
 * SEC-059: the fuzz targets of 10 §5 are registered, run on every change and kept as regression
 * cases. The harness is support/fuzz-harness.ts and the targets are support/fuzz-targets.ts.
 *
 * This file runs every registered target: the saved regression cases (tests/security/corpus/fuzz),
 * the seeds, then FUZZ_RUNS generated inputs (200 by default, the bounded run of a pull request; a
 * longer run sets FUZZ_RUNS). It fails if a target of 10 §5 that is due by the current phase is
 * missing, and it checks the harness itself on targets made to fail. The exhaustive authority
 * fuzzer is packages/authority/test/fuzz.test.ts.
 *
 * FUZZ_RUNS              generated inputs per target (default 200)
 * FUZZ_INPUT_LIMIT_MS    time limit for one input (default 1000; proposed, ADR 0121 item 39)
 * FUZZ_HEAP_LIMIT_MB     limit on heap growth over one input (default 256; proposed)
 * FUZZ_PHASE             the roadmap phase the build is in (default 1a)
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decodeInput,
  encodeInput,
  FuzzFailure,
  missingTargets,
  PHASES,
  runTarget,
  savedRegressions,
  SPEC_TARGETS,
  type FuzzTarget,
  type Phase,
  type RunOptions,
} from './support/fuzz-harness.ts';
import { TARGETS } from './support/fuzz-targets.ts';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);
const PHASE = (process.env['FUZZ_PHASE'] ?? '1a') as Phase;
const OPTIONS: RunOptions = {
  runs: RUNS,
  limitMs: Number(process.env['FUZZ_INPUT_LIMIT_MS'] ?? 1000),
  heapLimitBytes: Number(process.env['FUZZ_HEAP_LIMIT_MB'] ?? 256) * 1024 * 1024,
  regressionsDir: fileURLToPath(new URL('../corpus/fuzz', import.meta.url)),
  inflightDir: fileURLToPath(new URL('../corpus/fuzz-inflight', import.meta.url)),
};

describe('SEC-059 the registry against the list of 10 §5', () => {
  it('knows the phase the build is in', () => {
    expect(PHASES).toContain(PHASE);
  });

  it('has every listed target that is due by the current phase, complete', () => {
    expect(missingTargets(TARGETS, PHASE)).toEqual([]);
  });

  it('registers the targets of every phase, and nothing the list does not name', () => {
    expect(missingTargets(TARGETS, '2')).toEqual([]);
    expect(TARGETS.map((t) => t.id).sort()).toEqual(SPEC_TARGETS.map((t) => t.id).sort());
    for (const t of TARGETS)
      expect(SPEC_TARGETS.find((s) => s.id === t.id)?.phase, t.id).toBe(t.phase);
  });

  it('reports a listed target that is missing or incomplete, by phase', () => {
    const without = (id: string) => TARGETS.filter((t) => t.id !== id);
    expect(missingTargets(without('rebase'), '1a')).toEqual(['rebase']);
    // A target of a later phase is not due yet.
    expect(missingTargets(without('math-gate'), '1a')).toEqual([]);
    expect(missingTargets(without('math-gate'), '1b')).toEqual(['math-gate']);
    expect(missingTargets(without('docx-importer'), '2')).toEqual(['docx-importer']);
    // A name without a seed corpus or an oracle does not count as a target.
    const names = TARGETS.map((t) => ({ id: t.id, phase: t.phase }));
    expect(missingTargets(names, '1a')).toEqual(['envelope-parser', 'step-validation', 'rebase']);
  });
});

describe('SEC-059 every registered target runs', () => {
  for (const target of TARGETS) {
    it(
      `${target.id} (phase ${target.phase}): seeds from ${target.seedSource}, then ${RUNS} generated inputs`,
      async () => {
        expect(target.seeds().length, 'the seed corpus is not empty').toBeGreaterThan(0);
        const report = await runTarget(target, OPTIONS);
        expect(report.seeds).toBeGreaterThan(0);
        expect(report.generated).toBe(Math.ceil(RUNS / (target.cost ?? 1)));
      },
      120_000 + RUNS * 50,
    );
  }

  it('replays the saved regression cases of the rebase target', () => {
    expect(savedRegressions(OPTIONS.regressionsDir, 'rebase').length).toBeGreaterThanOrEqual(2);
  });
});

describe('SEC-059 a finding fails the run and is saved as a regression case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-fuzz-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const options = (over: Partial<RunOptions> = {}): RunOptions => {
    n += 1;
    return {
      runs: 100,
      limitMs: 5_000,
      heapLimitBytes: 1024 * 1024 * 1024,
      regressionsDir: join(dir, `regressions-${n}`),
      inflightDir: join(dir, `inflight-${n}`),
      seed: 59,
      ...over,
    };
  };
  const target = (id: string, oracle: (n: number) => void): FuzzTarget<number> => ({
    id,
    phase: '1a',
    seedSource: 'none (a target made to fail)',
    seeds: () => [0],
    arbitrary: fc.integer({ min: 0, max: 10_000 }),
    oracle,
  });
  const failure = async (t: FuzzTarget<number>, o: RunOptions): Promise<FuzzFailure> => {
    const e = await runTarget(t, o).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(FuzzFailure);
    return e as FuzzFailure;
  };

  it('a crash: the shrunk input is saved, and the next run replays it before anything else', async () => {
    const o = options();
    const crashing = target('made-to-crash', (v) => {
      if (v >= 100) throw new TypeError('boom');
    });
    const e = await failure(crashing, o);
    expect(e.kind).toBe('crash');
    expect(existsSync(e.file)).toBe(true);
    // fast-check shrinks to the smallest failing input.
    expect(savedRegressions(o.regressionsDir, 'made-to-crash').map((r) => r.input)).toEqual([100]);
    // With no generated inputs at all, the saved case alone fails the next run.
    const again = await failure(crashing, { ...o, runs: 0 });
    expect(again.file).toBe(e.file);
    // Once the code is fixed, the saved case passes and stays in the corpus.
    const fixed = await runTarget(
      target('made-to-crash', () => {}),
      o,
    );
    expect(fixed.regressions).toBe(1);
  });

  it('an oracle failure is saved and named as one', async () => {
    const o = options();
    const e = await failure(
      target('made-to-disagree', (v) => expect(v).toBeLessThan(7)),
      o,
    );
    expect(e.kind).toBe('oracle');
    expect(savedRegressions(o.regressionsDir, 'made-to-disagree').map((r) => r.input)).toEqual([7]);
  });

  it('an input slower than the time limit fails the run and is saved', async () => {
    const o = options({ limitMs: 20, runs: 30 });
    const slow = target('made-to-stall', (v) => {
      if (v < 5_000) return;
      const end = performance.now() + 60;
      while (performance.now() < end) {
        /* spin */
      }
    });
    const e = await failure(slow, o);
    expect(e.kind).toBe('hang');
    expect(savedRegressions(o.regressionsDir, 'made-to-stall')).toHaveLength(1);
  });

  it('an input that grows the heap past the limit fails the run and is saved', async () => {
    const o = options({ heapLimitBytes: 8 * 1024 * 1024, runs: 30 });
    const kept: number[][] = [];
    const greedy = target('made-to-grow', (v) => {
      // About 32 MiB that stays reachable, so a collection cannot hide it.
      if (v >= 5_000) kept.push(new Array<number>(4_000_000).fill(v));
    });
    const e = await failure(greedy, o);
    kept.length = 0;
    expect(e.kind).toBe('memory');
    expect(savedRegressions(o.regressionsDir, 'made-to-grow')).toHaveLength(1);
  });

  it('an input a killed run never returned from is saved by the next run, which fails', async () => {
    const o = options();
    // What a run leaves behind when the runner kills it in the middle of an input.
    const inflight = join(o.inflightDir, 'made-to-hang.json');
    await runTarget(
      target('made-to-hang', () => {}),
      o,
    ); // creates the folder; leaves nothing
    expect(readdirSync(o.inflightDir)).toEqual([]);
    writeFileSync(inflight, encodeInput(4242));
    const e = await failure(
      target('made-to-hang', () => {}),
      o,
    );
    expect(e.kind).toBe('hang');
    expect(existsSync(inflight)).toBe(false);
    expect(savedRegressions(o.regressionsDir, 'made-to-hang').map((r) => r.input)).toEqual([4242]);
  });

  it('saves inputs that JSON alone would lose: non-finite numbers and bytes', () => {
    const input = {
      from: Number.NaN,
      to: Number.POSITIVE_INFINITY,
      bytes: new Uint8Array([0, 255]),
    };
    expect(decodeInput(encodeInput(input))).toEqual(input);
  });
});
