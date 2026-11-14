/**
 * Spike S7 (SPK-020) timings: both candidates on corpus documents with the stub measurers, in
 * Node.js. Opt-in, because it takes about a minute: set DOCEDIT_S7_BENCH=1 and run
 * `pnpm exec vitest run --project node packages/layout/test/benchmark.test.ts`. Results go to
 * packages/layout/test-results/s7-benchmark.json with the machine they were taken on. These are
 * development-machine figures for comparing the candidates, not measurements against 13 §9.
 */
import { corpusStamp, loadDocument } from '@docedit/corpus';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  advanceTableMeasurer,
  cachingMeasurer,
  checkCoverage,
  countingMeasurer,
  fixedWidthMeasurer,
  layoutWithDocen,
  summarise,
  toFlow,
  type CdmEnvelopeLike,
  type LayoutTree,
  type TextMeasurer,
} from '../src/index.ts';
import { layoutWithEigenpal } from '../src/eigenpal.ts';

const enabled = process.env['DOCEDIT_S7_BENCH'] === '1';
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-results',
  's7-benchmark.json',
);

interface Row {
  document: string;
  engine: string;
  measurer: string;
  /** cold: a new measurer identity per pass, so no cache survives; warm: Docen's module caches kept. */
  caches: 'cold' | 'warm';
  /** The measurer is wrapped in `cachingMeasurer`; the call counts are then its misses. */
  measurerCache: boolean;
  passes: number;
  medianMs: number;
  minMs: number;
  pages: number;
  bodyLines: number;
  advanceCallsPerPass: number;
  advanceUnitsPerPass: number;
  coverageProblems: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

let passNumber = 0;

async function time(
  passes: number,
  run: (m: TextMeasurer) => Promise<LayoutTree>,
  make: () => TextMeasurer,
  caches: 'cold' | 'warm',
  measurerCache: boolean,
): Promise<{ times: number[]; tree: LayoutTree; calls: number; units: number }> {
  await run(make()); // warm-up: module initialisation and JIT
  const times: number[] = [];
  let tree: LayoutTree | null = null;
  let calls = 0;
  let units = 0;
  for (let i = 0; i < passes; i++) {
    const c = countingMeasurer(make());
    const counted = measurerCache ? cachingMeasurer(c.measurer) : c.measurer;
    // Docen keys its module caches by font string, which the adapter tags with the measurer id.
    const measurer =
      caches === 'cold' ? { ...counted, id: `${counted.id}/pass-${++passNumber}` } : counted;
    const started = performance.now();
    tree = await run(measurer);
    times.push(performance.now() - started);
    calls = c.stats.advanceCalls;
    units = c.stats.advanceUnits;
  }
  if (!tree) throw new Error('no pass ran');
  return { times, tree, calls, units };
}

describe.runIf(enabled)('S7 timings', () => {
  it('times both candidates on 20 and 100 pages', { timeout: 600_000 }, async () => {
    const rows: Row[] = [];
    const plan: [string, number, number][] = [
      ['pages-20', 5, 3],
      ['pages-100', 5, 1],
    ];
    for (const [name, docenPasses, eigenpalPasses] of plan) {
      const flow = toFlow((await loadDocument(name)).envelope as unknown as CdmEnvelopeLike);
      for (const [measurerName, make] of [
        ['fixed', () => fixedWidthMeasurer()],
        ['table', () => advanceTableMeasurer()],
      ] as const) {
        const docen = (m: TextMeasurer): Promise<LayoutTree> =>
          Promise.resolve(layoutWithDocen(flow, { measurer: m }));
        const eigenpal = async (m: TextMeasurer): Promise<LayoutTree> =>
          (await layoutWithEigenpal(flow, m)).tree;
        for (const [engine, passes, run, caches, measurerCache] of [
          ['docen', docenPasses, docen, 'cold', false],
          ['docen', docenPasses, docen, 'warm', false],
          ['eigenpal', eigenpalPasses, eigenpal, 'cold', false],
          ['eigenpal', eigenpalPasses, eigenpal, 'cold', true],
        ] as const) {
          const r = await time(passes, run, make, caches, measurerCache);
          const s = summarise(r.tree);
          rows.push({
            document: name,
            engine,
            measurer: measurerName,
            caches,
            measurerCache,
            passes,
            medianMs: Math.round(median(r.times)),
            minMs: Math.round(Math.min(...r.times)),
            pages: s.pages,
            bodyLines: s.bodyLines,
            advanceCallsPerPass: r.calls,
            advanceUnitsPerPass: r.units,
            coverageProblems: checkCoverage(flow, r.tree).length,
          });
        }
      }
    }
    const cpu = cpus()[0];
    const record = {
      spike: 'S7 (SPK-020)',
      takenAt: new Date().toISOString(),
      machine: {
        cpu: cpu?.model ?? 'unknown',
        cores: cpus().length,
        memoryGiB: Math.round(totalmem() / 2 ** 30),
        platform: platform(),
        arch: arch(),
        node: process.version,
      },
      corpus: corpusStamp(),
      method:
        'One warm-up pass, then the stated number of timed passes in one Node.js process; stub measurers; wall-clock time of the adapter call (Docen: conversion to its LayoutDoc, layout, mapping back; Eigenpal: OOXML projection and ZIP, parse, layout, mapping back). Flow conversion from CDM is excluded. cold: each pass gets a new measurer identity, so Docen re-measures; warm: the identity repeats and Docen serves widths from its module caches. measurerCache: the stub is wrapped in cachingMeasurer, a new cache per pass, and the call counts are its misses.',
      rows,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.table(rows);
    expect(rows.every((r) => r.coverageProblems === 0)).toBe(true);
  });
});

describe.skipIf(enabled)('S7 timings (skipped)', () => {
  it('runs only with DOCEDIT_S7_BENCH=1', () => {
    expect(enabled).toBe(false);
  });
});
