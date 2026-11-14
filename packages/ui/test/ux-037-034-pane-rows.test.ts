/**
 * Review pane rows (UX-037 criteria 1 and 5, model level) and the linked comment's announcement
 * (UX-034 criterion 4, model level). The pane is not rendered here; these tests cover the rows the
 * pane will draw. Node.js only.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { reviewPaneRows } from '../src/shell/review-pane-rows.ts';
import type { SuggestionKind, SuggestionRow } from '../src/shell/review-rules.ts';
import { linkedCommentAnnouncement } from '../src/shell/linked-comment.ts';

const KINDS: readonly SuggestionKind[] = ['insertion', 'deletion', 'formatting', 'block'];
const AUTHORS = ['user:u1', 'user:u2', 'assistant:a1'];

const rowArb: fc.Arbitrary<SuggestionRow> = fc.record({
  id: fc.uuid(),
  kind: fc.constantFrom(...KINDS),
  author: fc.constantFrom(...AUTHORS),
  committedAt: fc.constant('2026-11-13T09:00:00.000Z'),
  excerpt: fc.oneof(fc.constant(''), fc.string({ maxLength: 20 })),
  position: fc.integer({ min: 0, max: 50 }),
});

describe('review pane rows (UX-037 criterion 1)', () => {
  it('lists suggestions in document order with kind, author, commit time and excerpt', () => {
    const rows: SuggestionRow[] = [
      {
        id: 'b',
        kind: 'deletion',
        author: 'user:u1',
        committedAt: 't2',
        excerpt: 'old',
        position: 9,
      },
      {
        id: 'a',
        kind: 'insertion',
        author: 'user:u2',
        committedAt: 't1',
        excerpt: 'new',
        position: 3,
      },
    ];
    const got = reviewPaneRows(rows);
    expect(got.map((r) => r.id)).toEqual(['a', 'b']);
    expect(got[0]).toMatchObject({
      kind: 'insertion',
      author: 'user:u2',
      committedAt: 't1',
      excerpt: 'new',
    });
  });

  it('shows an empty excerpt as null, and keeps any other text as given', () => {
    const rows: SuggestionRow[] = [
      { id: 'x', kind: 'block', author: 'user:u1', committedAt: 't', excerpt: '', position: 1 },
      {
        id: 'y',
        kind: 'formatting',
        author: 'user:u1',
        committedAt: 't',
        excerpt: ' a ',
        position: 2,
      },
    ];
    const got = reviewPaneRows(rows);
    expect(got[0]!.excerpt).toBeNull();
    expect(got[1]!.excerpt).toBe(' a ');
  });

  it('keeps document order and never changes the input (property)', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 15 }), (rows) => {
        const before = JSON.stringify(rows);
        const got = reviewPaneRows(rows);
        expect(JSON.stringify(rows)).toBe(before);
        for (let i = 1; i < got.length; i++) {
          expect(got[i - 1]!.position).toBeLessThanOrEqual(got[i]!.position);
        }
        expect(got).toHaveLength(rows.length);
      }),
    );
  });
});

describe('review pane author filter (UX-037 criterion 2, with the pane rows)', () => {
  it('lists only the chosen author, assistants included like any author (property)', () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 15 }),
        fc.constantFrom(...AUTHORS),
        (rows, author) => {
          const got = reviewPaneRows(rows, author);
          expect(got.every((r) => r.author === author)).toBe(true);
          expect(got).toHaveLength(rows.filter((r) => r.author === author).length);
        },
      ),
    );
  });
});

describe('review pane accessible name (UX-037 criterion 5, model level)', () => {
  it('names each item with its kind, author and excerpt, and the commit time', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 10 }), (rows) => {
        for (const r of reviewPaneRows(rows)) {
          const src = rows.find((s) => s.id === r.id && s.position === r.position)!;
          expect(r.accessibleName).toEqual({
            kind: src.kind,
            author: src.author,
            committedAt: src.committedAt,
            excerpt: src.excerpt,
          });
        }
      }),
    );
  });
});

describe('linked comment announcement (UX-034 criterion 4, model level)', () => {
  it('announces the author, the time and the state, and no other part of the thread', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.uuid(),
          author: fc.string({ minLength: 1, maxLength: 12 }),
          createdAt: fc.constant('2026-11-13T10:00:00.000Z'),
          state: fc.constantFrom('open' as const, 'resolved' as const),
          replyCount: fc.integer({ min: 0, max: 9 }),
          body: fc.string({ maxLength: 30 }),
        }),
        (thread) => {
          const got = linkedCommentAnnouncement(thread);
          expect(Object.keys(got).sort()).toEqual(['author', 'createdAt', 'state']);
          expect(got).toEqual({
            author: thread.author,
            createdAt: thread.createdAt,
            state: thread.state,
          });
        },
      ),
    );
  });
});
