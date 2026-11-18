/**
 * FRW-028 in the editing core, in Node.js (lane w4): the pre-send checks over the document the reader
 * holds (`sendChecklist`, the authority's checklist given the participants' roles), and the move to a
 * suggestion that a failed check links to (`selectSuggestion`). The dialog and its browser run are in
 * packages/ui; the service over the workflow port is in packages/element.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { FIELD_IDS, fieldsDocument } from './frw-fields-fixture.ts';

type J = Record<string, unknown>;

const schedule = (run: () => void): void => queueMicrotask(run);

/** The fields fixture with an unassigned required field and, when asked, a suggestion. */
function sendable(options: { suggestion?: boolean; unassigned?: boolean } = {}) {
  const envelope = fieldsDocument() as unknown as {
    doc: { content: Array<{ type: string; content: J[] }> };
  };
  const body = envelope.doc.content.find((n) => n.type === 'body')!;
  const paragraph = body.content.find((n) => (n['attrs'] as J)['id'] === FIELD_IDS.paragraph)!;
  const content = paragraph['content'] as J[];
  if (options.unassigned)
    content.push({
      type: 'form_field',
      attrs: {
        id: 'fUnassigned00001',
        key: 'misc.unassigned',
        kind: 'text',
        label: 'Unassigned',
        assignee: null,
        required: true,
        value: null,
      },
    });
  if (options.suggestion)
    content.push({
      type: 'text',
      text: 'proposed',
      marks: [{ type: 'ins', attrs: { id: 'sPropose00000001', user: 'sam' } }],
    });
  return envelope as unknown as ConstructorParameters<typeof DocumentCore>[0]['doc'];
}

const open = (doc = sendable()): DocumentCore => new DocumentCore({ doc, schedule });

describe('the pre-send checks over the document (FRW-028 criteria 1 and 4)', () => {
  it('reports nothing when roles are held, fields are assigned and nothing is suggested', () => {
    const c = open();
    expect(c.sendChecklist([{ roles: ['role_tenant'] }, { roles: ['role_landlord'] }])).toEqual([]);
    c.destroy();
  });

  it('lists a role nobody holds, with its identifier', () => {
    const c = open();
    expect(c.sendChecklist([{ roles: ['role_tenant'] }])).toEqual([
      { code: 'role_without_participant', roles: ['role_landlord'] },
    ]);
    c.destroy();
  });

  it('lists a required field with no assignee by its key and an unresolved suggestion by its id', () => {
    const c = open(sendable({ unassigned: true, suggestion: true }));
    const problems = c.sendChecklist([{ roles: ['role_tenant', 'role_landlord'] }]);
    expect(problems).toEqual([
      { code: 'required_field_unassigned', keys: ['misc.unassigned'] },
      { code: 'pending_suggestions', suggestionIds: ['sPropose00000001'] },
    ]);
    c.destroy();
  });

  it('follows the document: the failure goes when the suggestion is resolved', () => {
    const c = open(sendable({ suggestion: true }));
    const both = [{ roles: ['role_tenant', 'role_landlord'] }];
    expect(c.sendChecklist(both).map((p) => p.code)).toEqual(['pending_suggestions']);
    c.destroy();
  });
});

describe('moving to a suggestion (FRW-028 criterion 2)', () => {
  it('selects the text that carries the mark', () => {
    const c = open(sendable({ suggestion: true }));
    expect(c.selectSuggestion('sPropose00000001')).toBe(true);
    const { state } = internals(c);
    const { from, to } = state.selection;
    expect(state.doc.textBetween(from, to)).toBe('proposed');
    c.destroy();
  });

  it('does nothing for an identifier no mark has', () => {
    const c = open(sendable({ suggestion: true }));
    const before = internals(c).state.selection.from;
    expect(c.selectSuggestion('sNoSuch00000001')).toBe(false);
    expect(internals(c).state.selection.from).toBe(before);
    c.destroy();
  });
});
