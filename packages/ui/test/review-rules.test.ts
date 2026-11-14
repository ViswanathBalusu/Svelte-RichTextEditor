/**
 * The review rules over suggestions (UX-036 criteria 1 and 3; UX-037 criterion 2; 07 §5.2 P4).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Capability } from '../src/core-api.ts';
import {
  ACCEPT_ORIGIN,
  REJECT_ORIGIN,
  listSuggestions,
  reviewOffers,
  stepSuggestion,
  type SuggestionRow,
} from '../src/shell/review-rules.ts';

const CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
];

describe('accept and reject are offered only with edit (UX-036 criterion 3)', () => {
  it('offers neither to a user with suggest but not edit, for any suggestion', () => {
    expect(reviewOffers(['suggest'])).toEqual({ accept: false, reject: false });
    expect(reviewOffers(['suggest', 'comment'])).toEqual({ accept: false, reject: false });
  });

  it('offers both to a user with edit in the suggestion scope', () => {
    expect(reviewOffers(['suggest', 'edit'])).toEqual({ accept: true, reject: true });
  });

  it('offers accept and reject together or not at all (property)', () => {
    fc.assert(
      fc.property(fc.subarray([...CAPS]), (caps) => {
        const offers = reviewOffers(caps);
        expect(offers.accept).toBe(offers.reject);
        expect(offers.accept).toBe(caps.includes('edit'));
      }),
    );
  });

  it('names the commit origins that accept and reject record (08 §14)', () => {
    expect(ACCEPT_ORIGIN).toBe('suggestion.accept');
    expect(REJECT_ORIGIN).toBe('suggestion.reject');
  });
});

describe('next and previous suggestion (UX-036 criterion 1)', () => {
  it('returns null when there are no suggestions', () => {
    expect(stepSuggestion(0, null, 'next')).toBeNull();
    expect(stepSuggestion(0, 0, 'previous')).toBeNull();
  });

  it('starts at the first with next and at the last with previous when nothing is current', () => {
    expect(stepSuggestion(3, null, 'next')).toBe(0);
    expect(stepSuggestion(3, null, 'previous')).toBe(2);
  });

  it('wraps at both ends', () => {
    expect(stepSuggestion(3, 2, 'next')).toBe(0);
    expect(stepSuggestion(3, 0, 'previous')).toBe(2);
  });

  it('moves one step and stays in range (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 49 }),
        fc.constantFrom('next' as const, 'previous' as const),
        (count, raw, direction) => {
          const current = raw % count;
          const to = stepSuggestion(count, current, direction);
          expect(to).not.toBeNull();
          expect(to!).toBeGreaterThanOrEqual(0);
          expect(to!).toBeLessThan(count);
          const diff = direction === 'next' ? 1 : -1;
          expect((((current + diff) % count) + count) % count).toBe(to);
        },
      ),
    );
  });
});

describe('the review list: document order and the author filter (UX-037 criterion 2)', () => {
  const rows: SuggestionRow[] = [
    {
      id: 's3',
      kind: 'deletion',
      author: 'ben',
      committedAt: '2026-11-03T10:00:00Z',
      excerpt: 'old',
      position: 30,
    },
    {
      id: 's1',
      kind: 'insertion',
      author: 'ann',
      committedAt: '2026-11-01T09:00:00Z',
      excerpt: 'new',
      position: 10,
    },
    {
      id: 's2',
      kind: 'formatting',
      author: 'assistant:draft',
      committedAt: '2026-11-02T09:00:00Z',
      excerpt: 'bold',
      position: 20,
    },
  ];

  it('lists every suggestion in document order when no author is chosen', () => {
    expect(listSuggestions(rows).map((r) => r.id)).toEqual(['s1', 's2', 's3']);
  });

  it('lists only the chosen author, assistants included as authors', () => {
    expect(listSuggestions(rows, 'ben').map((r) => r.id)).toEqual(['s3']);
    expect(listSuggestions(rows, 'assistant:draft').map((r) => r.id)).toEqual(['s2']);
    expect(listSuggestions(rows, 'nobody')).toEqual([]);
  });

  it('keeps every field of a row unchanged and does not change the input (property)', () => {
    const rowArb = fc.record({
      id: fc.uuid(),
      kind: fc.constantFrom(
        'insertion' as const,
        'deletion' as const,
        'formatting' as const,
        'block' as const,
      ),
      author: fc.constantFrom('ann', 'ben', 'assistant:draft'),
      committedAt: fc.constant('2026-11-01T09:00:00Z'),
      excerpt: fc.string({ maxLength: 20 }),
      position: fc.integer({ min: 0, max: 500 }),
    });
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 25 }),
        fc.constantFrom(null, 'ann', 'ben', 'assistant:draft'),
        (input, author) => {
          const before = structuredClone(input);
          const listed = listSuggestions(input, author);
          expect(input).toEqual(before);
          expect(listed.length).toBe(
            input.filter((r) => author === null || r.author === author).length,
          );
          for (const r of listed) expect(author === null || r.author === author).toBe(true);
          for (let i = 1; i < listed.length; i++) {
            expect(listed[i - 1]!.position).toBeLessThanOrEqual(listed[i]!.position);
          }
        },
      ),
    );
  });
});
