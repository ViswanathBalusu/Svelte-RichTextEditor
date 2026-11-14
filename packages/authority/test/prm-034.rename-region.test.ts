/**
 * PRM-034 criterion 1 at the authority (lane V-PRM-018-034): a title change on a region
 * (`region.retitle`, which needs `structure` and `edit` in the region) is accepted for a user who
 * holds both, refused for a user without `structure`, and refused for a restricted region the user
 * may not edit. An accepted change sets the new title and keeps the region's identifier and policy.
 */
import type { Node } from 'prosemirror-model';
import { AttrStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { applySteps } from '../src/rebase.ts';
import { baseDoc, posOf } from './fixtures.ts';
import { MORE, USERS, verdictOf } from './permission-fixtures.ts';

const retitle =
  (id: string, title: string) =>
  (doc: Node): Step[] => [new AttrStep(posOf(doc, id), 'title', title)];

function regionAttrs(doc: Node, id: string): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  doc.descendants((n) => {
    if (n.type.name === 'region' && n.attrs['id'] === id) out = n.attrs;
    return out === undefined;
  });
  return out;
}

describe('a region title change is checked by structure and edit (PRM-034 criterion 1)', () => {
  it('is accepted for a user with structure and edit in the region, and sets the new title', () => {
    const doc = baseDoc();
    const verdict = verdictOf(USERS.carol, doc, retitle('rNotes000000000C', 'Renamed notes'));
    expect(verdict.ok).toBe(true);
    const applied = applySteps(doc, retitle('rNotes000000000C', 'Renamed notes')(doc));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const before = regionAttrs(doc, 'rNotes000000000C')!;
    const after = regionAttrs(applied.value.doc, 'rNotes000000000C')!;
    expect(after['title']).toBe('Renamed notes');
    expect(after['id']).toBe(before['id']);
    expect(after['policy']).toBe(before['policy']);
  });

  it('is refused for a user without edit in a restricted region they have no grant for', () => {
    const doc = baseDoc();
    expect(verdictOf(MORE.rita, doc, retitle('rTerms000000000A', 'Renamed terms')).ok).toBe(false);
    expect(verdictOf(USERS.carol, doc, retitle('rLegal000000000B', 'Renamed legal')).ok).toBe(
      false,
    );
  });
});
