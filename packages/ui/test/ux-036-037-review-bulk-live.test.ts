/**
 * Bulk review and the live suggestion list (UX-036 criteria 2 and 4; UX-037 criterion 4). Rule level:
 * the message text, the browser run and the rendered list are not in these tests.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applySuggestionChange,
  bulkPlan,
  type SuggestionChange,
} from '../src/shell/review-bulk-live.ts';
import type { SuggestionRow } from '../src/shell/review-rules.ts';

interface Row extends SuggestionRow {
  readonly scope: string;
}

const rowOf = (id: string, position: number, author = 'ann', scope = 'body'): Row => ({
  id,
  kind: 'insertion',
  author,
  committedAt: '2026-11-01T09:00:00Z',
  excerpt: id,
  position,
  scope,
});

const rowArb: fc.Arbitrary<Row> = fc
  .record({
    id: fc.constantFrom('s1', 's2', 's3', 's4', 's5', 's6'),
    position: fc.integer({ min: 0, max: 200 }),
    author: fc.constantFrom('ann', 'ben', 'assistant:draft'),
    scope: fc.constantFrom('body', 'locked-region', 'notes'),
  })
  .map((r) => rowOf(r.id, r.position, r.author, r.scope));

describe('accept all and reject all apply to the matching rows the user may edit (UX-036 criterion 2)', () => {
  const rows = [
    rowOf('s1', 10, 'ann', 'body'),
    rowOf('s2', 20, 'ben', 'locked-region'),
    rowOf('s3', 30, 'ben', 'body'),
  ];

  it('applies to matching rows in editable scopes and counts the matching rows left pending', () => {
    const canEdit = (r: Row) => r.scope !== 'locked-region';
    expect(bulkPlan(rows, (r) => r.author === 'ben', canEdit)).toEqual({
      apply: ['s3'],
      leftPending: 1,
    });
    expect(bulkPlan(rows, () => true, canEdit)).toEqual({ apply: ['s1', 's3'], leftPending: 1 });
  });

  it('counts nothing outside the match, and leaves the input unchanged (property)', () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 30 }),
        fc.constantFrom('ann', 'ben', 'assistant:draft'),
        (input, author) => {
          const before = structuredClone(input);
          const canEdit = (r: Row) => r.scope !== 'locked-region';
          const matches = (r: Row) => r.author === author;
          const plan = bulkPlan(input, matches, canEdit);
          const matching = input.filter(matches);
          expect(plan.apply.length + plan.leftPending).toBe(matching.length);
          // The applied ids are exactly the matching rows the user may edit, in input order.
          expect(plan.apply).toEqual(matching.filter(canEdit).map((r) => r.id));
          expect(input).toEqual(before);
        },
      ),
    );
  });
});

describe('a resolve by another person updates the list without an error (UX-036 criterion 4)', () => {
  it('removes the row and keeps the rest in document order', () => {
    const rows = [rowOf('s1', 10), rowOf('s2', 20)];
    expect(applySuggestionChange(rows, { kind: 'resolve', id: 's1' }).map((r) => r.id)).toEqual([
      's2',
    ]);
  });

  it('changes nothing and throws nothing for an id the list does not hold', () => {
    const rows = [rowOf('s1', 10)];
    expect(() => applySuggestionChange(rows, { kind: 'resolve', id: 'gone' })).not.toThrow();
    expect(applySuggestionChange(rows, { kind: 'resolve', id: 'gone' }).map((r) => r.id)).toEqual([
      's1',
    ]);
  });
});

describe('the list updates live and stays in document order (UX-037 criterion 4)', () => {
  it('replaces a row whose id arrives again, and keeps order', () => {
    const rows = [rowOf('s1', 50), rowOf('s2', 20)];
    const next = applySuggestionChange(rows, { kind: 'arrive', row: rowOf('s1', 5) });
    expect(next.map((r) => [r.id, r.position])).toEqual([
      ['s1', 5],
      ['s2', 20],
    ]);
  });

  it('matches a model after any sequence of changes: same ids, no duplicates, document order (property)', () => {
    const changeArb: fc.Arbitrary<SuggestionChange<Row>> = fc.oneof(
      rowArb.map((row): SuggestionChange<Row> => ({ kind: 'arrive', row })),
      fc
        .constantFrom('s1', 's2', 's3', 's4', 's5', 's6')
        .map((id): SuggestionChange<Row> => ({ kind: 'resolve', id })),
    );
    fc.assert(
      fc.property(fc.array(changeArb, { maxLength: 40 }), (changes) => {
        let list: Row[] = [];
        const model = new Map<string, Row>();
        for (const c of changes) {
          list = applySuggestionChange(list, c);
          if (c.kind === 'arrive') model.set(c.row.id, c.row);
          else model.delete(c.id);
        }
        const ids = list.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort()).toEqual([...model.keys()].sort());
        for (let i = 1; i < list.length; i++) {
          expect(list[i - 1]!.position).toBeLessThanOrEqual(list[i]!.position);
        }
      }),
    );
  });
});
