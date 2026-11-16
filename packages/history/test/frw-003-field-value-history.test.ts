// FRW-003 criterion 5 (lane w4; 12 §3.3): a field value is stored in the tree, so it has the same
// time travel, comparison and history as any attribute. A value is set at seq 10 and changed at
// seq 20; a paragraph's style, an ordinary attribute, is changed at seq 18 for comparison.
//
// - Content read at seq 15 (the authority's `contentAt`, replaying the log) holds the value of seq 10.
// - A comparison of seq 15 with the head reports the change of seq 20 as a change of the field,
//   attributed to its author and seq, next to the style change, by both comparison methods.
// - The field's history lists seq 20 and seq 10, newest first.
import {
  NOTHING_HIDDEN,
  contentAt,
  defaultReplayers,
  type ContentSource,
} from '@docedit/authority';
import type { Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { type CompareSource, compare } from '../src/compare.ts';
import { fieldHistory } from '../src/reader.ts';
import { LogBuilder, meta, posOf, schema, typeAt } from './fixtures.ts';

const FIELD = 'fTenantName00001';
const SCOPE = `field:${FIELD}`;
const HEAD = 25;

/** Seq 10 sets the value, seq 18 restyles the introduction, seq 20 changes the value; the rest type. */
function build(): LogBuilder {
  const b = new LogBuilder();
  for (let seq = 1; seq <= HEAD; seq++) {
    if (seq === 10 || seq === 20)
      b.add(
        (d) =>
          new Transform(d).setNodeAttribute(
            posOf(d, FIELD),
            'value',
            seq === 10 ? 'Erin Ltd' : 'Erin Holdings Ltd',
          ),
        { user: 'erin', origin: 'fill', scopes: [SCOPE] },
      );
    else if (seq === 18)
      b.add(
        (d) =>
          new Transform(d).setNodeAttribute(posOf(d, 'pIntro0000000001'), 'style', 'LegalQuote'),
        { user: 'dave' },
      );
    else b.add((d) => typeAt(d, 'pEnd00000000001Z', 0, 'x'), { user: 'bob' });
  }
  return b;
}

/** The authority's content read over the log, from the checkpoint at seq 0. */
function contentSource(b: LogBuilder): ContentSource {
  return {
    incarnation: 'inc-1',
    head: b.head,
    checkpoints: [{ seq: 0, doc: b.docs[0]! }],
    commits: (after, to) => b.commits(after, to),
    resolve: () => {
      throw new Error('no snapshot in this log');
    },
    replayers: defaultReplayers(schema),
  };
}

function compareSource(b: LogBuilder, stepLimit?: number): CompareSource {
  const content = contentSource(b);
  return {
    schema,
    incarnation: 'inc-1',
    // The comparison reads its versions through the same content read.
    content: (seq) => {
      const r = contentAt(seq, content);
      return r.ok ? r.doc : undefined;
    },
    commits: (after, to) => b.commits(after, to),
    // The latest commit in the range that touched a scope (06 §4.1), for the aligned method.
    scopeIndex: (scope, after, to) => {
      const c = b
        .commits(after, to)
        .filter((x) => x.scopes.includes(scope))
        .at(-1);
      return c ? { user: c.user, seq: c.seq } : undefined;
    },
    ...(stepLimit !== undefined ? { stepLimit } : {}),
  };
}

const valueOf = (doc: Node): unknown => doc.nodeAt(posOf(doc, FIELD))!.attrs['value'];

describe('a field value in time travel, comparison and history (FRW-003 criterion 5)', () => {
  it('content read at seq 15 holds the value set at seq 10', () => {
    const b = build();
    const at15 = contentAt(15, contentSource(b));
    expect(at15.ok).toBe(true);
    if (!at15.ok) return;
    expect(valueOf(at15.doc)).toBe('Erin Ltd');
    const head = contentAt(HEAD, contentSource(b));
    expect(head.ok && valueOf(head.doc)).toBe('Erin Holdings Ltd');
  });

  it.each([
    ['steps', undefined],
    ['aligned', 5],
  ] as const)(
    'a comparison of seq 15 with the head shows the change of seq 20 (%s)',
    (method, limit) => {
      const b = build();
      const r = compare({ fromSeq: 15, toSeq: HEAD }, compareSource(b, limit), {
        gate: { min: 0, head: HEAD },
        hidden: NOTHING_HIDDEN,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.comparison.method).toBe(method);
      const field = r.comparison.changes.filter((c) => c.kind === 'field');
      // The value change is one change of the field, by its author, at its seq.
      expect(field).toHaveLength(1);
      expect(field[0]).toMatchObject({ kind: 'field', fieldId: FIELD, user: 'erin', seq: 20 });
      // An ordinary attribute change in the same range is reported in the same list.
      const formatted = r.comparison.changes.filter((c) => c.kind === 'formatted');
      expect(formatted).toHaveLength(1);
      expect(formatted[0]).toMatchObject({ blockId: 'pIntro0000000001', attrs: ['style'] });
    },
  );

  it('a comparison that ends before seq 20 shows no change of the field', () => {
    const b = build();
    const r = compare({ fromSeq: 15, toSeq: 19 }, compareSource(b), {
      gate: { min: 0, head: HEAD },
      hidden: NOTHING_HIDDEN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.comparison.changes.filter((c) => c.kind === 'field')).toEqual([]);
  });

  it('the history of the field lists the change of seq 20 and the value set at seq 10', () => {
    const b = build();
    const r = fieldHistory(FIELD, b.log.map(meta), { min: 0, head: HEAD }, NOTHING_HIDDEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => [e.seq, e.user, e.origin])).toEqual([
      [20, 'erin', 'fill'],
      [10, 'erin', 'fill'],
    ]);
  });
});
