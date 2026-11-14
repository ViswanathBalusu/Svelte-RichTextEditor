/**
 * The mention picker's rules (UX-031 criteria 2 and 3; criterion 6 rule only; 05 §8.1).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  START_MENTION_SEARCH,
  acceptResults,
  issueQuery,
  mentionNode,
  mentionsOffered,
  type MentionSearch,
} from '../src/shell/mention-search.ts';

type Event = { readonly kind: 'query' } | { readonly kind: 'result'; readonly pick: number };

const EVENTS: fc.Arbitrary<Event> = fc.oneof(
  fc.constant<Event>({ kind: 'query' }),
  fc.nat(20).map((pick): Event => ({ kind: 'result', pick })),
);

describe('stale results are ignored (UX-031 criterion 2)', () => {
  it('shows the results of the newest query and drops an older one', () => {
    const first = issueQuery(START_MENTION_SEARCH);
    const second = issueQuery(first.search);
    expect(acceptResults(second.search, first.id).show).toBe(false);
    const late = acceptResults(second.search, second.id);
    expect(late.show).toBe(true);
    expect(late.search.shown).toBe(second.id);
  });

  it('never shows a result for a query that a newer one has superseded (property)', () => {
    fc.assert(
      fc.property(fc.array(EVENTS, { maxLength: 60 }), (events) => {
        let search: MentionSearch = START_MENTION_SEARCH;
        const issued: number[] = [];
        for (const event of events) {
          if (event.kind === 'query') {
            const next = issueQuery(search);
            search = next.search;
            issued.push(next.id);
            continue;
          }
          // The result for a query issued earlier, chosen by index; a result may come back late.
          if (issued.length === 0) continue;
          const id = issued[event.pick % issued.length] ?? 0;
          const outcome = acceptResults(search, id);
          const newest = issued[issued.length - 1];
          expect(outcome.show).toBe(id === newest);
          search = outcome.search;
        }
      }),
    );
  });

  it('keeps the query counter strictly increasing (property)', () => {
    fc.assert(
      fc.property(fc.nat(50), (n) => {
        let search: MentionSearch = START_MENTION_SEARCH;
        let last = 0;
        for (let i = 0; i < n; i++) {
          const next = issueQuery(search);
          expect(next.id).toBeGreaterThan(last);
          last = next.id;
          search = next.search;
        }
      }),
    );
  });
});

describe('a mention node stores only the principal identifier (UX-031 criterion 3)', () => {
  it('stores the principal and no name', () => {
    const node = mentionNode('user:ann');
    expect(node).toEqual({ type: 'mention', principal: 'user:ann' });
    expect(Object.keys(node ?? {}).sort()).toEqual(['principal', 'type']);
  });

  it('accepts user and group identifiers and refuses any other form (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('user', 'group'),
        fc.stringMatching(/^[a-z0-9-]{1,20}$/),
        (kind, id) => {
          expect(mentionNode(`${kind}:${id}`)).toEqual({
            type: 'mention',
            principal: `${kind}:${id}`,
          });
        },
      ),
    );
    expect(mentionNode('Ann Lee')).toBeNull();
    expect(mentionNode('user:')).toBeNull();
    expect(mentionNode('team:x')).toBeNull();
  });
});

describe('mentions need a host search (UX-031 criterion 6, rule only)', () => {
  it('is offered exactly when the host provides searchPrincipals', () => {
    expect(mentionsOffered(true)).toBe(true);
    expect(mentionsOffered(false)).toBe(false);
  });
});
