// Invariants of the numbering algorithm (CDM-042; ADR 0032), as property tests over random
// documents with three lists on one definition, restarts, regions, tables, captions and footnotes:
// - labels are stable under unrelated edits;
// - list instances are independent of one another;
// - a projection given the hidden regions' effects shows the full document's labels (SR-C3);
// - a list without restarts numbers 1, 2, 3 in document order whatever was deleted;
// - the computation is pure.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../cascade/styles.ts';
import { type DocumentLabels, computeLabels, counterEffects } from './labels.ts';

type J = Record<string, unknown>;
type List = 'A' | 'B' | 'C';

type Leaf =
  | { kind: 'item'; list: List; level: number; restart: number | null }
  | { kind: 'plain' }
  | { kind: 'seq'; name: 'Figure' | 'Table' }
  | { kind: 'note' };
type Entry = Leaf | { kind: 'region'; content: Leaf[] } | { kind: 'table'; cells: Leaf[][] };

const leaf: fc.Arbitrary<Leaf> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('item' as const),
      list: fc.constantFrom<List>('A', 'B', 'C'),
      level: fc.integer({ min: 0, max: 2 }),
      restart: fc.option(fc.integer({ min: 0, max: 30 }), { freq: 8 }),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'plain' as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('seq' as const),
      name: fc.constantFrom('Figure' as const, 'Table' as const),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'note' as const }) },
);
const entry: fc.Arbitrary<Entry> = fc.oneof(
  { weight: 6, arbitrary: leaf },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('region' as const),
      content: fc.array(leaf, { minLength: 1, maxLength: 5 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('table' as const),
      cells: fc.array(fc.array(leaf, { minLength: 1, maxLength: 3 }), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
  },
);
const entries = fc.array(entry, { minLength: 1, maxLength: 25 });

const LEVELS = [
  { format: 'decimal', text: '%1.', start: 1 },
  { format: 'lowerLetter', text: '%1.%2', start: 1, legal: true },
  { format: 'lowerRoman', text: '(%3)', start: 1, restartAfter: 0 },
];

/** Builds a CDM document; identifiers come from the entry's position, so edits can keep them. */
class Builder {
  #n = 0;
  readonly ids: string[] = [];
  next(prefix: string): string {
    const id = `${prefix}${String(this.#n++).padStart(15 - prefix.length + 1, '0')}`.slice(0, 16);
    return id.padEnd(16, 'x');
  }
}

function leafNode(l: Leaf & { id: string }): J {
  switch (l.kind) {
    case 'item':
      return {
        type: 'paragraph',
        attrs: {
          id: l.id,
          numbering: { numberingId: 'n', level: l.level, listId: `list${l.list}xxxxxxxxxxx` },
          ...(l.restart === null ? {} : { numberingRestart: l.restart }),
        },
      };
    case 'seq':
      return {
        type: 'paragraph',
        attrs: { id: l.id },
        content: [{ type: 'field', attrs: { kind: 'seq', name: l.name } }],
      };
    case 'note':
      return {
        type: 'paragraph',
        attrs: { id: l.id },
        content: [
          {
            type: 'footnote',
            attrs: { id: `f${l.id.slice(1)}` },
            content: [{ type: 'paragraph', attrs: { id: `g${l.id.slice(1)}` } }],
          },
        ],
      };
    default:
      return {
        type: 'paragraph',
        attrs: { id: l.id },
        content: [{ type: 'text', text: 'Plain.' }],
      };
  }
}

type Placed =
  | (Leaf & { id: string })
  | { kind: 'region'; id: string; content: (Leaf & { id: string })[] }
  | { kind: 'table'; id: string; cells: (Leaf & { id: string })[][] };

function place(es: readonly Entry[]): Placed[] {
  const b = new Builder();
  const withId = (l: Leaf): Leaf & { id: string } => ({ ...l, id: b.next('p') });
  return es.map((e) =>
    e.kind === 'region'
      ? { kind: 'region', id: b.next('r'), content: e.content.map(withId) }
      : e.kind === 'table'
        ? { kind: 'table', id: b.next('t'), cells: e.cells.map((c) => c.map(withId)) }
        : withId(e),
  );
}

function blockNode(p: Placed): J {
  if (p.kind === 'region')
    return { type: 'region', attrs: { id: p.id }, content: p.content.map(leafNode) };
  if (p.kind === 'table')
    return {
      type: 'table',
      attrs: { id: p.id, grid: p.cells.map(() => 1000) },
      content: [
        {
          type: 'table_row',
          attrs: { id: `w${p.id.slice(1)}` },
          content: p.cells.map((c, i) => ({
            type: 'table_cell',
            attrs: { id: `c${i}${p.id.slice(2)}` },
            content: c.map(leafNode),
          })),
        },
      ],
    };
  return leafNode(p);
}

function docOf(blocks: readonly J[]): TreeNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: {} },
          {
            type: 'style_def',
            attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
          },
          { type: 'numbering_def', attrs: { id: 'n', levels: LEVELS } },
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: blocks },
    ],
  } as unknown as TreeNode;
}

const lists = (l: DocumentLabels): Record<string, string> =>
  Object.fromEntries([...l.lists].map(([k, v]) => [k, v.text]));
const sequences = (l: DocumentLabels): Record<string, string[]> =>
  Object.fromEntries([...l.sequences].map(([k, v]) => [k, v.map((s) => s.text)]));

function leaves(placed: readonly Placed[]): (Leaf & { id: string })[] {
  return placed.flatMap((p) =>
    p.kind === 'region' ? p.content : p.kind === 'table' ? p.cells.flat() : [p],
  );
}

describe('numbering invariants (CDM-042)', () => {
  it('keeps every label when unrelated content is inserted, deleted, changed or wrapped in a region', () => {
    fc.assert(
      fc.property(
        entries,
        fc.nat(),
        fc.constantFrom('insert', 'delete', 'change', 'wrap', 'format'),
        (es, seed, edit) => {
          const placed = place(es);
          const blocks = placed.map(blockNode);
          const before = computeLabels(docOf(blocks));
          let after = blocks.slice();
          const at = seed % (after.length + 1);
          if (edit === 'insert')
            after.splice(at, 0, {
              type: 'paragraph',
              attrs: { id: 'insertedxxxxxxxx' },
              content: [{ type: 'text', text: 'New.' }],
            });
          else if (edit === 'delete' || edit === 'change') {
            const i = placed.findIndex((p, k) => k >= at % placed.length && p.kind === 'plain');
            if (i >= 0)
              if (edit === 'delete') after.splice(i, 1);
              else
                after[i] = {
                  type: 'paragraph',
                  attrs: { id: placed[i]!.id, style: 'Normal', spaceBefore: 240 },
                  content: [{ type: 'text', text: 'Changed.' }],
                };
          } else if (edit === 'wrap') {
            // Wrap a run of top-level paragraphs (no regions or tables) in a new region.
            let end = at;
            while (
              end < placed.length &&
              placed[end]!.kind !== 'region' &&
              placed[end]!.kind !== 'table' &&
              end < at + 4
            )
              end++;
            if (end > at)
              after = [
                ...after.slice(0, at),
                {
                  type: 'region',
                  attrs: { id: 'wrappedxxxxxxxxx' },
                  content: after.slice(at, end),
                },
                ...after.slice(end),
              ];
          } else {
            after = after.map((b) =>
              b['type'] === 'paragraph'
                ? { ...b, attrs: { ...(b['attrs'] as J), indentLeft: 360, align: 'center' } }
                : b,
            );
          }
          const labels = computeLabels(docOf(after));
          expect(lists(labels)).toEqual(lists(before));
          expect(sequences(labels)).toEqual(sequences(before));
          expect(Object.fromEntries(labels.footnotes)).toEqual(
            Object.fromEntries(before.footnotes),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('numbers each list instance on its own, whatever other lists on the same definition do', () => {
    fc.assert(
      fc.property(entries, fc.constantFrom<List>('A', 'B', 'C'), (es, list) => {
        const placed = place(es);
        const full = computeLabels(docOf(placed.map(blockNode)));
        const only = leaves(placed).filter((l) => l.kind === 'item' && l.list === list);
        const alone = computeLabels(docOf(only.map(leafNode)));
        expect(lists(alone)).toEqual(
          Object.fromEntries(only.map((l) => [l.id, lists(full)[l.id]])),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("gives a projection the full document's labels when the hidden regions' effects are applied", () => {
    fc.assert(
      fc.property(entries, fc.array(fc.boolean(), { maxLength: 25 }), (es, hideMask) => {
        const placed = place(es);
        const full = docOf(placed.map(blockNode));
        const hidden = placed
          .filter((p, i) => p.kind === 'region' && hideMask[i] === true)
          .map((p) => p.id);
        const projection = docOf(
          placed.map((p) =>
            hidden.includes(p.id) ? { type: 'hidden_region', attrs: { id: p.id } } : blockNode(p),
          ),
        );
        const effects = counterEffects(full, hidden);
        const shown = computeLabels(projection, { effects });
        const truth = computeLabels(full);
        for (const [id, text] of Object.entries(lists(shown)))
          expect(text, id).toBe(lists(truth)[id]);
        for (const [id, texts] of Object.entries(sequences(shown)))
          expect(texts, id).toEqual(sequences(truth)[id]);
        for (const [id, mark] of shown.footnotes) expect(mark, id).toBe(truth.footnotes.get(id));
        // Every visible numbered paragraph is labelled in both.
        const visible = leaves(placed.filter((p) => !hidden.includes(p.id))).filter(
          (l) => l.kind === 'item',
        );
        expect(visible.every((l) => shown.lists.has(l.id))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('numbers a list without restarts 1, 2, 3 in document order, whatever was deleted', () => {
    fc.assert(
      fc.property(entries, fc.array(fc.boolean(), { maxLength: 60 }), (es, keep) => {
        const placed = place(
          es.map((e) =>
            e.kind === 'item'
              ? { ...e, level: 0, restart: null }
              : e.kind === 'region'
                ? {
                    ...e,
                    content: e.content.map((l) =>
                      l.kind === 'item' ? { ...l, level: 0, restart: null } : l,
                    ),
                  }
                : e.kind === 'table'
                  ? {
                      ...e,
                      cells: e.cells.map((c) =>
                        c.map((l) => (l.kind === 'item' ? { ...l, level: 0, restart: null } : l)),
                      ),
                    }
                  : e,
          ),
        );
        let k = 0;
        const kept = placed.filter(
          (p) => p.kind !== 'item' || keep[k++ % Math.max(keep.length, 1)] !== false,
        );
        const labels = computeLabels(docOf(kept.map(blockNode)));
        const a = leaves(kept).filter((l) => l.kind === 'item' && l.list === 'A');
        expect(a.map((l) => labels.lists.get(l.id)?.text)).toEqual(a.map((_, i) => `${i + 1}.`));
      }),
      { numRuns: 200 },
    );
  });

  it('is pure: the same document gives the same labels, and the document is not changed', () => {
    fc.assert(
      fc.property(entries, (es) => {
        const doc = docOf(place(es).map(blockNode));
        const text = JSON.stringify(doc);
        const a = computeLabels(doc);
        const b = computeLabels(doc);
        expect(lists(a)).toEqual(lists(b));
        expect(JSON.stringify(doc)).toBe(text);
      }),
      { numRuns: 100 },
    );
  });
});
