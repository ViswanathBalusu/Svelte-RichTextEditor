/**
 * SEC-028 criterion 5 (part) — the fuzz targets of the authority run with a time limit per input.
 * When one input takes longer than the limit, the build fails and the input is stored as JSON in
 * `tests/security/corpus/slow/` so that it can be replayed as a regression case (10 §5).
 *
 * The limit is not given by the spec. `INPUT_LIMIT_MS` is a proposed default (1000 ms) that can be
 * raised with `FUZZ_INPUT_LIMIT_MS`; it is a budget for a single input, not a measurement, and the
 * owner should set it (docs/adr/0121-security-backlog-batch.md, item 39). The wrapper is written
 * for the three phase-1a targets of this suite (SEC-059). The exhaustive authority fuzzer in
 * packages/authority/test/fuzz.test.ts is not wrapped here: it is outside this directory.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { applySteps, DEFAULT_LIMITS, parseSteps } from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { documentWithRegions } from './support/harness.ts';

export const INPUT_LIMIT_MS = Number(process.env['FUZZ_INPUT_LIMIT_MS'] ?? 1000);
export const SLOW_DIR = fileURLToPath(new URL('../corpus/slow', import.meta.url));
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);

/** JSON that keeps non-finite numbers, which JSON.stringify would turn into null. */
const replacer = (_k: string, v: unknown): unknown =>
  typeof v === 'number' && !Number.isFinite(v) ? `${v}` : v;

/**
 * Wraps a fuzz target. It runs the target on one input, measures the wall-clock time, and when the
 * time exceeds `limitMs` it stores the input under `storeDir` and throws, so the property fails.
 * An exception from the target is not wrapped: it reaches the property as it is.
 */
export function withInputLimit<I>(
  target: string,
  fn: (input: I) => void,
  opts: { limitMs: number; storeDir: string },
): (input: I) => void {
  return (input: I): void => {
    const start = globalThis.performance.now();
    fn(input);
    const elapsedMs = globalThis.performance.now() - start;
    if (elapsedMs <= opts.limitMs) return;
    const body = JSON.stringify({ target, limitMs: opts.limitMs, elapsedMs, input }, replacer, 2);
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
    mkdirSync(opts.storeDir, { recursive: true });
    const file = join(opts.storeDir, `${target}-${digest}.json`);
    writeFileSync(file, body);
    throw new Error(
      `${target} took ${elapsedMs.toFixed(1)} ms on one input (limit ${opts.limitMs} ms); input stored at ${file}`,
    );
  };
}

/** A busy loop of about `ms` milliseconds, to make a target that is certainly slow. */
function spin(ms: number): void {
  const end = globalThis.performance.now() + ms;
  while (globalThis.performance.now() < end) {
    /* spin */
  }
}

describe('SEC-028 fuzz targets run with a time limit per input (wrapper)', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'sec028-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('an input over the limit fails the build and is stored with its input and timing', () => {
    const storeDir = join(tempDir(), 'slow');
    const target = withInputLimit<{ n: number }>('slow-target', () => spin(3), {
      limitMs: 1,
      storeDir,
    });
    expect(() => target({ n: 7 })).toThrow(/took .* ms on one input .*input stored at/);
    const files = readdirSync(storeDir);
    expect(files).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(storeDir, files[0]!), 'utf8')) as {
      target: string;
      limitMs: number;
      elapsedMs: number;
      input: { n: number };
    };
    expect(stored.target).toBe('slow-target');
    expect(stored.limitMs).toBe(1);
    expect(stored.elapsedMs).toBeGreaterThan(1);
    expect(stored.input).toEqual({ n: 7 });
  });

  it('an input within the limit passes and stores nothing', () => {
    const storeDir = join(tempDir(), 'none');
    const target = withInputLimit('quick-target', (x: number) => void x, {
      limitMs: 60_000,
      storeDir,
    });
    expect(() => target(1)).not.toThrow();
    expect(existsSync(storeDir)).toBe(false);
  });

  it('a stored input keeps non-finite numbers, which plain JSON would lose', () => {
    const storeDir = join(tempDir(), 'nonfinite');
    const target = withInputLimit<{ from: number }>('nan-target', () => spin(3), {
      limitMs: 1,
      storeDir,
    });
    expect(() => target({ from: Number.NaN })).toThrow();
    const [file] = readdirSync(storeDir);
    const stored = JSON.parse(readFileSync(join(storeDir, file!), 'utf8')) as {
      input: { from: string };
    };
    expect(stored.input.from).toBe('NaN');
  });
});

describe('SEC-028 the phase-1a authority targets run under the limit', () => {
  const schema = cdmSchema();
  const baseDoc = schema.nodeFromJSON(documentWithRegions()['doc']);
  const pos = fc.integer({ min: -5, max: 400 });
  const stepArb = fc.record({
    stepType: fc.constantFrom('replace', 'replaceAround', 'addMark', 'removeMark', 'attr', 'frob'),
    from: pos,
    to: pos,
  });

  const target = withInputLimit(
    'step-validation-and-apply',
    (steps: unknown[]) => {
      const parsed = parseSteps(schema, steps, DEFAULT_LIMITS);
      if (!parsed.ok) return;
      const applied = applySteps(baseDoc, parsed.value);
      if (applied.ok) applied.value.doc.check();
    },
    { limitMs: INPUT_LIMIT_MS, storeDir: SLOW_DIR },
  );

  it('step validation and apply finish every input within the limit (property, fast-check)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 6 }), (steps) => target(steps)),
      {
        numRuns: RUNS,
      },
    );
  });
});
