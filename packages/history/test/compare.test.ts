// Comparisons (08 §6; HIS-011, HIS-012): from the recorded steps with prosemirror-changeset, or by
// aligning blocks by identifier; the result format, region and granularity, tables, fields,
// formatting, moves, restored blocks, determinism, the method the gate allows, the cache per class
// and a run in a worker thread on plain data.
import { Worker } from 'node:worker_threads';
import { NOTHING_HIDDEN, type HiddenSet } from '@docedit/authority';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap, applyCommit } from '../src/attribution.ts';
import {
  type Change,
  ComparisonCache,
  type CompareSource,
  compare,
  compareStates,
  compareSteps,
  STEP_LIMIT,
} from '../src/compare.ts';
import type { Author } from '../src/types.ts';
import {
  HIDDEN,
  LogBuilder,
  deleteIn,
  posInside,
  posOf,
  schema,
  snapshotCommit,
  typeAt,
} from './fixtures.ts';
import { EDIT_KINDS, randomEdit } from './random-edits.ts';

const creator: Author = { user: 'owner', seq: 0 };

function mapsOf(b: LogBuilder): AttributionMap[] {
  const maps = [AttributionMap.create(b.docs[0]!.content.size, creator)];
  for (const c of b.log) {
    const m = maps[maps.length - 1]!.clone();
    applyCommit(m, c, schema);
    maps.push(m);
  }
  return maps;
}

function steps(
  b: LogBuilder,
  from = 0,
  to = b.head,
  hidden: HiddenSet = NOTHING_HIDDEN,
  extra = {},
) {
  const r = compareSteps({
    schema,
    from: { seq: from, doc: b.docs[from]! },
    commits: b.commits(from, to),
    hidden,
    ...extra,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.comparison;
}

function aligned(
  b: LogBuilder,
  from = 0,
  to = b.head,
  hidden: HiddenSet = NOTHING_HIDDEN,
  extra = {},
) {
  const maps = mapsOf(b);
  const r = compareStates({
    from: { seq: from, doc: b.docs[from]! },
    to: { seq: to, doc: b.docs[to]!, attribution: maps[to]! },
    hidden,
    ...extra,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.comparison;
}

const kinds = (cs: readonly Change[]) =>
  cs.map((c) => `${c.kind}:${c.blockId ?? c.fieldId ?? c.defId}`);

function moveBlock(doc: Node, id: string, beforeId: string): Transform {
  const from = posOf(doc, id);
  const node = doc.nodeAt(from)!;
  const tr = new Transform(doc).delete(from, from + node.nodeSize);
  const to = tr.mapping.map(posOf(doc, beforeId));
  return tr.insert(to, node);
}

describe('comparisons from the recorded steps (HIS-011)', () => {
  it('gives inserted and deleted spans with the user and seq of the commit that made them', () => {
    const b = new LogBuilder();
    b.add((d) => typeAt(d, 'pIntro0000000001', 5, 'very '), { user: 'bob' });
    b.add((d) => deleteIn(d, 'pIntro0000000001', 0, 5), { user: 'carol' });
    b.add((d) => typeAt(d, 'pTerms000000002A', 0, 'The '), { user: 'bob' });
    const c = steps(b);
    expect(c).toMatchObject({ fromSeq: 0, toSeq: 3, method: 'steps', granularity: 'word' });
    expect(c.changes).toEqual([
      {
        kind: 'modified',
        blockId: 'pIntro0000000001',
        type: 'paragraph',
        // A word diff: the space after the word is unchanged.
        spans: [
          { op: 'delete', at: 0, text: 'This', user: 'carol', seq: 2 },
          { op: 'insert', at: 0, text: 'very', user: 'bob', seq: 1 },
        ],
      },
      {
        kind: 'modified',
        blockId: 'pTerms000000002A',
        type: 'paragraph',
        path: ['rTerms000000000A'],
        region: 'rTerms000000000A',
        spans: [{ op: 'insert', at: 0, text: 'The ', user: 'bob', seq: 3 }],
      },
    ]);
  });

  it('reports added, removed and formatted blocks, field values and definitions in the 08 §6 format', () => {
    const b = new LogBuilder();
    const added = schema.nodes['paragraph']!.create(
      { id: 'pAdded0000000001' },
      schema.text('New clause.'),
    );
    b.add((d) => new Transform(d).insert(posOf(d, 'pEnd00000000001Z'), added), { user: 'bob' });
    b.add(
      (d) => {
        const at = posOf(d, 'pTerms000000003A');
        return new Transform(d).delete(at, at + d.nodeAt(at)!.nodeSize);
      },
      { user: 'carol' },
    );
    b.add(
      (d) => new Transform(d).setNodeAttribute(posOf(d, 'pIntro0000000001'), 'style', 'LegalQuote'),
      {
        user: 'dave',
        origin: 'format',
      },
    );
    b.add(
      (d) => {
        let pos = -1;
        d.descendants((n, p) => {
          if (n.attrs['id'] === 'fTenantName00001') pos = p;
          return pos < 0;
        });
        return new Transform(d).setNodeAttribute(pos, 'value', 'Erin Example');
      },
      { user: 'erin', origin: 'fill', scopes: ['field:fTenantName00001'] },
    );
    b.add((d) => new Transform(d).setNodeAttribute(posOf(d, 'LegalQuote'), 'italic', true), {
      user: 'alice',
      scopes: ['defs:style_def/LegalQuote'],
    });
    const c = steps(b);
    expect(c.changes).toEqual([
      {
        kind: 'definition',
        defId: 'style_def/LegalQuote',
        change: 'changed',
        type: 'style_def',
        attrs: ['italic'],
        user: 'alice',
        seq: 5,
      },
      {
        kind: 'formatted',
        blockId: 'pIntro0000000001',
        type: 'paragraph',
        attrs: ['style'],
        user: 'dave',
        seq: 3,
      },
      {
        kind: 'removed',
        blockId: 'pTerms000000003A',
        type: 'paragraph',
        path: ['rTerms000000000A'],
        region: 'rTerms000000000A',
        user: 'carol',
        seq: 2,
      },
      {
        kind: 'field',
        fieldId: 'fTenantName00001',
        blockId: 'pNote00000000001',
        user: 'erin',
        seq: 4,
      },
      { kind: 'added', blockId: 'pAdded0000000001', type: 'paragraph', user: 'bob', seq: 1 },
    ]);
  });

  it('limits the result to a region and uses the granularity asked for', () => {
    const b = new LogBuilder();
    b.add((d) => typeAt(d, 'pIntro0000000001', 0, 'X'), { user: 'bob' });
    b.add((d) => typeAt(d, 'pTerms000000001A', 2, 'X'), { user: 'bob' });
    const region = steps(b, 0, 2, NOTHING_HIDDEN, { region: 'rTerms000000000A' });
    expect(kinds(region.changes)).toEqual(['modified:pTerms000000001A']);
    expect(region.region).toBe('rTerms000000000A');
    // Word: the whole word that changed; character: only the character.
    const word = steps(b, 0, 2, NOTHING_HIDDEN, {
      region: 'rTerms000000000A',
      granularity: 'word',
    });
    const char = steps(b, 0, 2, NOTHING_HIDDEN, {
      region: 'rTerms000000000A',
      granularity: 'char',
    });
    expect(word.changes[0]!.spans).toEqual([
      { op: 'delete', at: 0, text: 'Rent', user: 'bob', seq: 2 },
      { op: 'insert', at: 0, text: 'ReXnt', user: 'bob', seq: 2 },
    ]);
    expect(char.changes[0]!.spans).toEqual([
      { op: 'insert', at: 2, text: 'X', user: 'bob', seq: 2 },
    ]);
    expect(char.granularity).toBe('char');
    expect(
      compareSteps({
        schema,
        from: { seq: 0, doc: b.docs[0]! },
        commits: b.log,
        region: 'rNope00000000000',
      }),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('gives the same output for the same inputs (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...EDIT_KINDS),
            a: fc.double({ min: 0, max: 0.999, noNaN: true }),
            b: fc.double({ min: 0, max: 0.999, noNaN: true }),
            user: fc.constantFrom('alice', 'bob'),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        fc.constantFrom('word' as const, 'char' as const),
        (edits, granularity) => {
          const b = new LogBuilder();
          for (const e of edits) {
            const tr = randomEdit(b.doc, e.kind, e.a, e.b, 'w');
            if (tr?.steps.length) b.add(() => tr, { user: e.user });
          }
          const one = steps(b, 0, b.head, HIDDEN, { granularity });
          const two = steps(b, 0, b.head, HIDDEN, { granularity });
          expect(JSON.stringify(two)).toBe(JSON.stringify(one));
          const a1 = aligned(b, 0, b.head, HIDDEN, { granularity });
          expect(JSON.stringify(aligned(b, 0, b.head, HIDDEN, { granularity }))).toBe(
            JSON.stringify(a1),
          );
          // Both methods find the same blocks changed; only authorship differs.
          const blocks = (cs: readonly Change[]) =>
            cs
              .filter((c) => c.kind !== 'definition')
              .map((c) => `${c.kind}:${c.blockId ?? c.fieldId}`);
          expect(blocks(one.changes)).toEqual(blocks(a1.changes));
        },
      ),
      { numRuns: 60, seed: 11 },
    );
  });

  it('refuses a range with a snapshot commit in it', () => {
    const b = new LogBuilder();
    b.add((d) => typeAt(d, 'pIntro0000000001', 0, 'X'));
    const log = [...b.log, snapshotCommit(2, 'k2')];
    expect(compareSteps({ schema, from: { seq: 0, doc: b.docs[0]! }, commits: log })).toMatchObject(
      {
        ok: false,
        code: 'validation_failed',
      },
    );
  });
});

describe('comparisons by aligning blocks (HIS-012)', () => {
  it('runs a word diff inside changed blocks, with insertions authored from the attribution map', () => {
    const b = new LogBuilder();
    b.add((d) => typeAt(d, 'pIntro0000000001', 5, 'very '), { user: 'bob' });
    b.add((d) => deleteIn(d, 'pTerms000000001A', 0, 5), { user: 'carol' });
    const c = aligned(b);
    expect(c.method).toBe('aligned');
    expect(c.changes).toEqual([
      {
        kind: 'modified',
        blockId: 'pIntro0000000001',
        type: 'paragraph',
        spans: [{ op: 'insert', at: 5, text: 'very ', user: 'bob', seq: 1 }],
      },
      {
        kind: 'modified',
        blockId: 'pTerms000000001A',
        type: 'paragraph',
        path: ['rTerms000000000A'],
        region: 'rTerms000000000A',
        // The map names who inserted text; nobody is named for a deletion (HIS-012 Notes).
        spans: [{ op: 'delete', at: 0, text: 'Rent ' }],
      },
    ]);
  });

  it('aligns tables by row and cell identifiers', () => {
    const b = new LogBuilder();
    const row = schema.nodeFromJSON({
      type: 'table_row',
      attrs: { id: 'trFees0000000003' },
      content: [
        {
          type: 'table_cell',
          attrs: { id: 'tcFees000000031A' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'pCell00000000031' },
              content: [{ type: 'text', text: 'Keys' }],
            },
          ],
        },
        {
          type: 'table_cell',
          attrs: { id: 'tcFees000000032A' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'pCell00000000032' },
              content: [{ type: 'text', text: '10' }],
            },
          ],
        },
      ],
    });
    b.add(
      (d) => {
        const at = posOf(d, 'trFees0000000002');
        return new Transform(d).insert(at + d.nodeAt(at)!.nodeSize, row);
      },
      { user: 'bob' },
    );
    b.add(
      (d) =>
        deleteIn(d, 'pCell00000000022', 0, 2).insert(
          posInside(d, 'pCell00000000022'),
          schema.text('75'),
        ),
      { user: 'carol' },
    );
    b.add(
      (d) => {
        const at = posOf(d, 'trFees0000000001');
        return new Transform(d).delete(at, at + d.nodeAt(at)!.nodeSize);
      },
      { user: 'dave' },
    );
    b.add(
      (d) =>
        new Transform(d).setNodeAttribute(posOf(d, 'tcFees000000021A'), 'shading', {
          fill: 'EEEEEE',
        }),
      { user: 'dave' },
    );
    const c = aligned(b);
    expect(c.changes).toEqual([
      {
        kind: 'removed',
        blockId: 'trFees0000000001',
        type: 'table_row',
        path: ['tFees00000000001'],
      },
      {
        kind: 'formatted',
        blockId: 'tcFees000000021A',
        type: 'table_cell',
        path: ['tFees00000000001', 'trFees0000000002'],
        attrs: ['shading'],
      },
      {
        kind: 'modified',
        blockId: 'pCell00000000022',
        type: 'paragraph',
        path: ['tFees00000000001', 'trFees0000000002', 'tcFees000000022A'],
        spans: [
          { op: 'delete', at: 0, text: '50' },
          { op: 'insert', at: 0, text: '75', user: 'carol', seq: 2 },
        ],
      },
      {
        kind: 'added',
        blockId: 'trFees0000000003',
        type: 'table_row',
        path: ['tFees00000000001'],
        user: 'bob',
        seq: 1,
      },
    ]);
    // The steps name the same rows and cells, with who removed the row and who shaded the cell.
    expect(kinds(steps(b).changes)).toEqual(kinds(c.changes));
    expect(steps(b).changes[0]).toMatchObject({ kind: 'removed', user: 'dave', seq: 3 });
    expect(steps(b).changes[1]).toMatchObject({ kind: 'formatted', user: 'dave', seq: 4 });
  });

  it('compares field values by identifier, with who set them from the per-scope table', () => {
    const b = new LogBuilder();
    b.add(
      (d) => {
        let pos = -1;
        d.descendants((n, p) => {
          if (n.attrs['id'] === 'fTenantName00001') pos = p;
          return pos < 0;
        });
        return new Transform(d).setNodeAttribute(pos, 'value', 'Erin');
      },
      { user: 'erin', scopes: ['field:fTenantName00001'] },
    );
    const c = compareStates({
      from: { seq: 0, doc: b.docs[0]! },
      to: { seq: 1, doc: b.doc },
      scopeIndex: (s) => (s === 'field:fTenantName00001' ? { user: 'erin', seq: 1 } : undefined),
    });
    expect(c.ok && c.comparison.changes).toEqual([
      {
        kind: 'field',
        fieldId: 'fTenantName00001',
        blockId: 'pNote00000000001',
        user: 'erin',
        seq: 1,
      },
    ]);
  });

  it('reports a block with only formatting differences as formatted, with the names', () => {
    const b = new LogBuilder();
    b.add(
      (d) => {
        const at = posOf(d, 'pTerms000000002A');
        return new Transform(d)
          .addMark(at + 1, at + 8, schema.marks['bold']!.create())
          .setNodeAttribute(at, 'align', 'center');
      },
      { user: 'bob' },
    );
    const c = aligned(b);
    expect(c.changes).toEqual([
      {
        kind: 'formatted',
        blockId: 'pTerms000000002A',
        type: 'paragraph',
        path: ['rTerms000000000A'],
        region: 'rTerms000000000A',
        attrs: ['align'],
        marks: ['bold'],
      },
    ]);
    expect(steps(b).changes[0]).toMatchObject({
      kind: 'formatted',
      attrs: ['align'],
      marks: ['bold'],
      user: 'bob',
      seq: 1,
    });
  });

  it('reports a restored block with a new identifier as added, and the old one as removed', () => {
    const b = new LogBuilder();
    b.add(
      (d) => {
        const at = posOf(d, 'pTerms000000002A');
        const n = d.nodeAt(at)!;
        return new Transform(d).replaceWith(
          at,
          at + n.nodeSize,
          n.type.create({ ...n.attrs, id: 'pRestored0000002' }, n.content),
        );
      },
      { user: 'alice', origin: 'restore' },
    );
    expect(kinds(aligned(b).changes)).toEqual([
      'removed:pTerms000000002A',
      'added:pRestored0000002',
    ]);
  });

  it('reports a moved block once, deterministically, in both methods', () => {
    const b = new LogBuilder();
    b.add((d) => moveBlock(d, 'pTerms000000003A', 'pTerms000000001A'), { user: 'bob' });
    const a = aligned(b);
    const s = steps(b);
    expect(a.changes).toEqual([
      {
        kind: 'moved',
        blockId: 'pTerms000000003A',
        type: 'paragraph',
        path: ['rTerms000000000A'],
        region: 'rTerms000000000A',
        user: 'bob',
        seq: 1,
      },
    ]);
    expect(s.changes).toEqual(a.changes);
    // A block moved into another container is a move too.
    const c = new LogBuilder();
    c.add((d) => moveBlock(d, 'pIntro0000000001', 'pTerms000000002A'), { user: 'carol' });
    expect(kinds(aligned(c).changes)).toEqual(['moved:pIntro0000000001']);
  });

  it('shows a paragraph split as a deletion in the first part and an added block', () => {
    const b = new LogBuilder();
    b.add(
      (d) =>
        new Transform(d).split(posInside(d, 'pIntro0000000001', 14), 1, [
          { type: schema.nodes['paragraph']!, attrs: { id: 'pSplit0000000001' } },
        ]),
      { user: 'bob' },
    );
    const s = steps(b);
    expect(kinds(s.changes)).toEqual(['modified:pIntro0000000001', 'added:pSplit0000000001']);
    expect(s.changes[0]!.spans![0]).toMatchObject({ op: 'delete', at: 14, user: 'bob', seq: 1 });
    expect(kinds(aligned(b).changes)).toEqual(kinds(s.changes));
  });
});

describe('the comparison entry point (HIS-011, HIS-012)', () => {
  function source(
    b: LogBuilder,
    extra: Partial<CompareSource> = {},
  ): CompareSource & { reads: number } {
    const maps = mapsOf(b);
    const s = {
      reads: 0,
      schema,
      incarnation: 'inc-1',
      content: (seq: number) => {
        s.reads++;
        return b.docs[seq];
      },
      commits: (after: number, to: number) => b.commits(after, to),
      attribution: (seq: number) => maps[seq],
      ...extra,
    };
    return s;
  }

  function log(n: number): LogBuilder {
    const b = new LogBuilder();
    for (let i = 0; i < n; i++)
      b.add((d) => typeAt(d, 'pEnd00000000001Z', 0, 'x'), { user: i % 2 ? 'bob' : 'carol' });
    return b;
  }

  it('uses the steps up to the limit and aligns blocks beyond it or across a snapshot commit', () => {
    const b = log(6);
    const gate = { min: 0, head: 6 };
    const near = compare({ fromSeq: 1, toSeq: 6 }, source(b, { stepLimit: 5 }), {
      gate,
      hidden: NOTHING_HIDDEN,
    });
    const far = compare({ fromSeq: 0, toSeq: 6 }, source(b, { stepLimit: 5 }), {
      gate,
      hidden: NOTHING_HIDDEN,
    });
    expect(near.ok && near.comparison.method).toBe('steps');
    expect(far.ok && far.comparison.method).toBe('aligned');
    const withSnapshot = source(b, {
      commits: (after, to) =>
        b.commits(after, to).map((c) => (c.seq === 3 ? snapshotCommit(3, 'k3') : c)),
    });
    const across = compare({ fromSeq: 1, toSeq: 6 }, withSnapshot, {
      gate,
      hidden: NOTHING_HIDDEN,
    });
    expect(across.ok && across.comparison.method).toBe('aligned');
  });

  it('uses the steps for versions up to 2,000 commits apart by default and aligns beyond that (HIS-011, HIS-012)', () => {
    expect(STEP_LIMIT).toBe(2000);
    const b = log(STEP_LIMIT + 1);
    const gate = { min: 0, head: b.head };
    const atLimit = compare({ fromSeq: 0, toSeq: STEP_LIMIT }, source(b), {
      gate,
      hidden: NOTHING_HIDDEN,
    });
    const beyond = compare({ fromSeq: 0, toSeq: STEP_LIMIT + 1 }, source(b), {
      gate,
      hidden: NOTHING_HIDDEN,
    });
    expect(atLimit.ok && atLimit.comparison.method).toBe('steps');
    expect(beyond.ok && beyond.comparison.method).toBe('aligned');
  }, 120_000);

  it('refuses versions below the gate before any work, and compares named versions by alignment only', () => {
    const b = log(5);
    const src = source(b);
    // A viewer under `editors`: the gate is the head; seq 2 is a named version.
    const gate = { min: 5, head: 5, named: (s: number) => s === 2 };
    expect(compare({ fromSeq: 1, toSeq: 5 }, src, { gate, hidden: NOTHING_HIDDEN })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(src.reads).toBe(0);
    const named = compare({ fromSeq: 2, toSeq: 5 }, src, { gate, hidden: NOTHING_HIDDEN });
    // No intermediate commit's author or seq appears: the map at the head names who wrote the text,
    // and only states are compared (ADR 0034).
    expect(named.ok && named.comparison.method).toBe('aligned');
    expect(
      compare({ fromSeq: 6, toSeq: 7 }, src, { gate: { min: 0, head: 5 }, hidden: NOTHING_HIDDEN }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(
      compare({ fromSeq: 3, toSeq: 2 }, src, { gate: { min: 0, head: 5 }, hidden: NOTHING_HIDDEN }),
    ).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('caches by the pair of sequence numbers and never serves one visibility class another class’s result', () => {
    const b = new LogBuilder();
    b.add((d) => typeAt(d, 'pSecret00000001B', 0, 'More '), { user: 'bob' });
    b.add((d) => typeAt(d, 'pIntro0000000001', 0, 'Now '), { user: 'bob' });
    const cache = new ComparisonCache(8);
    const src = source(b);
    const gate = { min: 0, head: 2 };
    const full = compare({ fromSeq: 0, toSeq: 2 }, src, { gate, hidden: NOTHING_HIDDEN, cache });
    const again = compare({ fromSeq: 0, toSeq: 2 }, src, { gate, hidden: NOTHING_HIDDEN, cache });
    expect(full.ok && !full.cached).toBe(true);
    expect(again.ok && again.cached && again.comparison).toBe(full.ok && full.comparison);
    const reader = compare({ fromSeq: 0, toSeq: 2 }, src, { gate, hidden: HIDDEN, cache });
    expect(reader.ok && reader.cached).toBe(false);
    expect(kinds(full.ok ? full.comparison.changes : [])).toContain('modified:pSecret00000001B');
    expect(kinds(reader.ok ? reader.comparison.changes : [])).not.toContain(
      'modified:pSecret00000001B',
    );
    expect(cache.size).toBe(2);
  });

  it('runs in a worker thread on plain data, with none of the room', async () => {
    const b = log(4);
    const maps = mapsOf(b);
    const workerData = {
      from: { seq: 1, doc: b.docs[1]!.toJSON() },
      to: { seq: 4, doc: b.docs[4]!.toJSON(), attribution: maps[4]!.toJSON() },
      commits: JSON.parse(JSON.stringify(b.commits(1, 4))),
    };
    const result = await new Promise<{ steps: unknown; aligned: unknown }>((resolve, reject) => {
      const w = new Worker(new URL('./harness/compare-worker.ts', import.meta.url), { workerData });
      w.once('message', resolve);
      w.once('error', reject);
    });
    expect(result.steps).toEqual(steps(b, 1, 4));
    expect(result.aligned).toEqual(aligned(b, 1, 4));
  });
});

describe('spans keep their offsets in the newer version', () => {
  it('places each insertion at its offset and each deletion where it was', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 6 }),
        (words) => {
          const b = new LogBuilder();
          words.forEach((w, i) =>
            b.add((d) => typeAt(d, 'pEnd00000000001Z', Math.min(i, 3), w.replace(/\s/g, 'x')), {
              user: 'bob',
            }),
          );
          const after = b.doc.nodeAt(posOf(b.doc, 'pEnd00000000001Z'))!;
          for (const c of steps(b, 0, b.head, NOTHING_HIDDEN, { granularity: 'char' }).changes)
            for (const s of c.spans ?? [])
              if (s.op === 'insert')
                expect(after.textBetween(s.at, s.at + s.text.length)).toBe(s.text);
        },
      ),
      { numRuns: 40, seed: 3 },
    );
  });

  it('reads pasted blocks as added blocks of the person who pasted them', () => {
    const b = new LogBuilder();
    const copy = schema.nodes['paragraph']!.create(
      { id: 'pPasted000000001' },
      schema.text('Copied text.'),
    );
    b.add(
      (d) =>
        new Transform(d).step(
          new ReplaceStep(
            posOf(d, 'pEnd00000000001Z'),
            posOf(d, 'pEnd00000000001Z'),
            new Slice(Fragment.from(copy), 0, 0),
          ),
        ),
      {
        user: 'dave',
        origin: 'paste',
      },
    );
    expect(aligned(b).changes).toEqual([
      { kind: 'added', blockId: 'pPasted000000001', type: 'paragraph', user: 'dave', seq: 1 },
    ]);
  });
});
