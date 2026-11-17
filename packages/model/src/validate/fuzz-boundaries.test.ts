// CDM-015 criterion 1, the boundary sizes: documents built at, just under and just over the limits of
// I7 (500 regions, 63 table columns, nesting depth 12, 16 MiB in canonical form), with very many
// repeated marks and very long strings, are read and validated to a result or a typed error within a
// time limit, with no uncaught exception and with bounded memory. The random trees are in
// `fuzz.test.ts`; a failing input is saved as a regression in the format of CDM-014, as there.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '../../fixtures/kitchen-sink.json' with { type: 'json' };
import { readDocument } from './read.ts';
import { LIMITS, validate } from './validate.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

declare module 'vitest' {
  interface TaskMeta {
    /** What a boundary run measured: the slowest case and the largest heap growth, with the input. */
    boundary?: { slowestMs: number; largestHeapGrowthBytes: number; largestInputBytes: number };
  }
}

const MIB = 1024 * 1024;
const LIMIT_BYTES = LIMITS.canonicalBytes;
/**
 * The time limit of one read and one validation. A document just under 16 MiB is walked in full, so
 * the limit is wider than the 2 s of the random trees in `fuzz.test.ts`.
 */
const TIME_LIMIT_MS = 10_000;
/**
 * The bound on the heap a read and a validation may add, as a multiple of the input's JSON size,
 * plus a fixed allowance for small inputs. The heap is read with `process.memoryUsage()` before
 * and after, without forcing a collection, so the figure includes garbage not yet collected.
 */
const HEAP_FACTOR = 4;
const HEAP_ALLOWANCE_BYTES = 128 * MIB;
const SEEDS = [20261115, 7, 1234];
const regressions = resolve(import.meta.dirname, '../../fixtures/invariants/regressions');
const seeds = [example, kitchenSink] as Json[];

/** The depth of the text of a paragraph in the body: document, body, paragraph, text. */
const PLAIN_DEPTH = 4;

function regionsIn(node: Json): number {
  const own = node['type'] === 'region' ? 1 : 0;
  const content = (node['content'] ?? []) as Json[];
  return content.reduce((sum, child) => sum + regionsIn(child), own);
}
/** The regions each seed document already has; they count towards the limit of I7. */
const seedRegions = seeds.map((d) => regionsIn(d['doc'] as Json));

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(15, '0')}`;

const paragraph = (n: number, text: string, marks: Json[] = []): Json => ({
  type: 'paragraph',
  attrs: { id: id('p', n) },
  content: [{ type: 'text', text, ...(marks.length ? { marks } : {}) }],
});

interface Case {
  seed: number;
  /** Regions added to the body, beside those of the seed document. */
  regions: number;
  /** Columns of one added table. */
  columns: number;
  /**
   * The depth of the deepest node, counted from the document node: a chain of regions around a
   * paragraph. Without a chain the paragraph's text is at depth 4. Regions may not nest, so a chain
   * of two or more is refused for that; the depth limit is a separate violation.
   */
  depth: number;
  /** Repeated marks on one text node. */
  marks: number;
  /** The length of one very long string, as text. */
  long: number;
  /** Bytes added as paragraphs of text, to bring the document near the size limit. */
  fill: number;
  /** Integers in an array inside an `ext` value. */
  extItems: number;
}

/** A value at a limit, one under it or one over it. */
const around = (limit: number): fc.Arbitrary<number> =>
  fc.constantFrom(limit - 1, limit, limit + 1);

const caseArb: fc.Arbitrary<Case> = fc.record({
  seed: fc.constantFrom(0, 1),
  regions: fc.oneof(fc.constant(0), around(LIMITS.regions - 1), fc.constant(2000)),
  columns: fc.oneof(fc.constant(1), around(LIMITS.tableColumns), fc.constant(1000)),
  depth: fc.oneof(fc.constant(PLAIN_DEPTH), around(LIMITS.depth), fc.constant(5000)),
  marks: fc.constantFrom(0, 1, 100, 20_000),
  long: fc.constantFrom(0, 1, 65_536, 4 * MIB),
  fill: fc.oneof(
    { weight: 3, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.constantFrom(8 * MIB, LIMIT_BYTES - 2 * MIB, LIMIT_BYTES + MIB) },
  ),
  extItems: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(0, 10, 1000) },
    { weight: 1, arbitrary: fc.constantFrom(MIB, 8 * MIB) },
  ),
});

function build(c: Case): Json {
  const d = structuredClone(seeds[c.seed]!) as Json;
  const body = d['doc'].content.find((n: Json) => n.type === 'body').content as Json[];
  let n = 0;
  for (let i = 0; i < c.regions; i++)
    body.push({
      type: 'region',
      attrs: { id: id('r', i), title: `Region ${i}` },
      content: [paragraph(n++, 'in a region')],
    });
  body.push({
    type: 'table',
    attrs: { id: id('t', 0), grid: Array.from({ length: c.columns }, () => 720) },
    content: [
      {
        type: 'table_row',
        attrs: { id: id('w', 0) },
        content: Array.from({ length: c.columns }, (_, col) => ({
          type: 'table_cell',
          attrs: { id: id('c', col) },
          content: [paragraph(n++, 'cell')],
        })),
      },
    ],
  });
  let deep: Json = paragraph(n++, 'deep');
  for (let i = 0; i < c.depth - PLAIN_DEPTH; i++)
    deep = { type: 'region', attrs: { id: id('d', i) }, content: [deep] };
  body.push(deep);
  body.push(
    paragraph(
      n++,
      'marked',
      Array.from({ length: c.marks }, () => ({ type: 'bold' })),
    ),
  );
  if (c.long > 0) body.push(paragraph(n++, 'z'.repeat(c.long)));
  const chunk = 'f'.repeat(64 * 1024);
  for (let left = c.fill; left > 0; left -= chunk.length) body.push(paragraph(n++, chunk));
  if (c.extItems > 0) {
    const holder = paragraph(n++, 'ext');
    holder['attrs'].ext = { 'vendor.example:list': Array.from({ length: c.extItems }, () => 7) };
    body.push(holder);
  }
  return d;
}

function save(name: string, doc: Json, error: string): void {
  mkdirSync(regressions, { recursive: true });
  writeFileSync(
    resolve(regressions, `${name}.json`),
    `${JSON.stringify({ name, doc: `fuzz failure: ${error}`, base: doc, steps: [], context: {}, expected: [] })}\n`,
  );
}

/**
 * The size of the input as JSON text. A chain of thousands of regions is deeper than
 * `JSON.stringify` can walk, so its size is counted from its parts.
 */
function sizeOf(doc: Json, c: Case): number {
  if (c.depth <= 1000) return JSON.stringify(doc).length;
  const shallow = JSON.stringify(build({ ...c, depth: PLAIN_DEPTH })).length;
  return shallow + c.depth * 70;
}

/** One read and one validation, with the time and the heap growth they took. */
function measure(doc: Json): {
  ms: number;
  heap: number;
  valid: boolean;
  codes: string[];
  read: string;
} {
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const r = validate(doc, { mathGate: () => null });
  const read = readDocument(doc);
  const ms = performance.now() - start;
  const heap = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  return {
    ms,
    heap,
    valid: r.valid,
    codes: r.violations.map((v) => v.code),
    read: read.ok ? 'ok' : read.code,
  };
}

describe('documents at the boundary sizes of I7 (CDM-015 criterion 1)', () => {
  it.for(SEEDS)(
    'end in a result or a typed error within the time limit and the memory bound (seed %i)',
    { timeout: 180_000 },
    (seed, { task }) => {
      const seen = { slowestMs: 0, largestHeapGrowthBytes: 0, largestInputBytes: 0 };
      const run = fc.check(
        fc.property(caseArb, (c) => {
          const doc = build(c);
          const inputBytes = sizeOf(doc, c);
          const m = measure(doc);
          seen.slowestMs = Math.max(seen.slowestMs, m.ms);
          seen.largestHeapGrowthBytes = Math.max(seen.largestHeapGrowthBytes, m.heap);
          seen.largestInputBytes = Math.max(seen.largestInputBytes, inputBytes);
          expect(m.ms).toBeLessThan(TIME_LIMIT_MS);
          expect(m.heap).toBeLessThan(HEAP_FACTOR * inputBytes + HEAP_ALLOWANCE_BYTES);
          // A result or a typed error: every violation has a code, and a refused read has one too.
          for (const code of m.codes) expect(code).toMatch(/^[a-z0-9_]+$/);
          expect(m.read).toMatch(/^[a-z0-9_]+$/);
          if (!m.valid) expect(m.read).not.toBe('ok');
          // Past a limit of I7 the document is never valid.
          const chain = Math.max(0, c.depth - PLAIN_DEPTH);
          const over =
            c.regions + chain + seedRegions[c.seed]! > LIMITS.regions ||
            c.columns > LIMITS.tableColumns ||
            c.depth > LIMITS.depth ||
            c.fill > LIMIT_BYTES ||
            c.extItems >= MIB;
          if (over) expect(m.valid).toBe(false);
        }),
        { seed, numRuns: 25, interruptAfterTimeLimit: 120_000 },
      );
      task.meta.boundary = seen;
      if (run.failed && run.counterexample) {
        // The shrunk case is saved without its filler and its deepest chain, which a regression
        // fixture cannot hold.
        const first = run.counterexample[0];
        const small = {
          ...first,
          fill: 0,
          long: 0,
          extItems: 0,
          depth: Math.min(first.depth, LIMITS.depth + 1),
        };
        save(`fuzz-boundary-${seed}`, build(small), String(run.errorInstance));
      }
      expect(run.failed, fc.defaultReportMessage(run) ?? '').toBe(false);
      console.info(
        `CDM-015 boundary run, seed ${seed}: slowest ${Math.round(seen.slowestMs)} ms, ` +
          `largest heap growth ${Math.round(seen.largestHeapGrowthBytes / MIB)} MiB, ` +
          `largest input ${Math.round(seen.largestInputBytes / MIB)} MiB`,
      );
    },
  );

  it('each limit on its own: at the limit is accepted, one over is refused, both in time', () => {
    const base: Case = {
      seed: 0,
      regions: 0,
      columns: 1,
      depth: PLAIN_DEPTH,
      marks: 0,
      long: 0,
      fill: 0,
      extItems: 0,
    };
    const slowest = { ms: 0 };
    const at = (over: Partial<Case>) => {
      const m = measure(build({ ...base, ...over }));
      slowest.ms = Math.max(slowest.ms, m.ms);
      return m;
    };
    expect(at({}).codes).toEqual([]);
    // The seed's own regions count towards the limit.
    const room = LIMITS.regions - seedRegions[0]!;
    expect(at({ regions: room }).codes, 'regions at the limit').toEqual([]);
    expect(at({ regions: room + 1 }).codes, 'one region over').toContain('too_many_regions');
    expect(at({ columns: LIMITS.tableColumns }).codes, 'columns at the limit').toEqual([]);
    expect(at({ columns: LIMITS.tableColumns + 1 }).codes, 'one column over').toContain(
      'limit_exceeded',
    );
    // Regions may not nest, so a chain is refused for that at any length; the depth limit is its
    // own violation, reported from one level past the limit.
    expect(at({ depth: LIMITS.depth }).codes).not.toContain('nesting_too_deep');
    expect(at({ depth: LIMITS.depth + 1 }).codes).toContain('nesting_too_deep');
    // Very many repeated marks and a very long string are within the grammar's reach, not a crash.
    expect(typeof at({ marks: 20_000 }).valid).toBe('boolean');
    expect(at({ long: 4 * MIB }).codes).toEqual([]);
    // Just under 16 MiB is walked in full and accepted; just over is refused.
    expect(at({ fill: LIMIT_BYTES - 2 * MIB }).codes).toEqual([]);
    expect(at({ fill: LIMIT_BYTES + MIB }).codes).toContain('canonical_too_large');
    // An array of a million integers in `ext` is past the attribute's own limit.
    // It is reported once, at the attribute, and is not walked item by item.
    expect(at({ extItems: MIB }).codes).toEqual(['attribute_invalid']);
    expect(slowest.ms).toBeLessThan(TIME_LIMIT_MS);
  }, 120_000);
});
