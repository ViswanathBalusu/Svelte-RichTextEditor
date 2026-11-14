/**
 * FE-134 criterion 4 and FE-133 criterion 4 through the core (lane U-FE-129-141): a bookmark that a
 * cross-reference names cannot be deleted in the editor, because the core installs the reference
 * filter (`referenceGuardPlugin`, core.ts) and I4 of 03 §8 forbids leaving the reference unresolved.
 * The explanation and the list of references are the view's and are not tested here.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { microtask, posOf } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;

function envelope(): CdmEnvelope {
  return { cdm: 1, requires: [], doc: authoringEnvelope() };
}

/** An editor with the body, as authoring-commands.test.ts uses. */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'] },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

const BOOKMARK = 'Clause9';
const ANCHOR_ID = 'anc0000000000001';

/** The position of the first node of `type` whose attribute `attr` has `value`, or null. */
function find(
  doc: PMNode,
  type: string,
  attr: string,
  value: unknown,
): { pos: number; size: number } | null {
  let found: { pos: number; size: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === type && node.attrs[attr] === value) {
      found = { pos: pos, size: node.nodeSize };
      return false;
    }
    return true;
  });
  return found;
}

describe('the core refuses to delete a bookmark that a cross-reference names (FE-134 criterion 4)', () => {
  it('keeps the bookmark when its reference is still in the document, and allows it once the reference is gone', () => {
    const c = new DocumentCore({ doc: envelope(), access: editorAccess(), schedule: microtask });
    const i = internals(c);

    // The bookmark goes at the start of the first paragraph, and a ref to it at the start of the second.
    const start1 = posOf(i.state.doc, AUTH_IDS.p1) + 1;
    const anchor = i.state.schema.nodes['anchor']!.create({ id: ANCHOR_ID, name: BOOKMARK });
    i.dispatch(i.state.tr.insert(start1, anchor));

    const start2 = posOf(i.state.doc, AUTH_IDS.p2) + 1;
    const field = i.state.schema.nodes['field']!.create({
      kind: 'ref',
      target: `bookmark:${BOOKMARK}`,
      format: null,
      cached: '1',
    });
    i.dispatch(i.state.tr.insert(start2, field));
    expect(find(i.state.doc, 'anchor', 'name', BOOKMARK)).not.toBeNull();

    // Deleting the bookmark while the reference names it is refused: the document does not change.
    const before = i.state.doc;
    const found = find(i.state.doc, 'anchor', 'name', BOOKMARK)!;
    i.dispatch(i.state.tr.delete(found.pos, found.pos + found.size));
    expect(i.state.doc.eq(before)).toBe(true);
    expect(find(i.state.doc, 'anchor', 'name', BOOKMARK)).not.toBeNull();

    // Deleting the reference is allowed; then the bookmark may go.
    const ref = find(i.state.doc, 'field', 'target', `bookmark:${BOOKMARK}`)!;
    i.dispatch(i.state.tr.delete(ref.pos, ref.pos + ref.size));
    expect(find(i.state.doc, 'field', 'target', `bookmark:${BOOKMARK}`)).toBeNull();
    const anchorNow = find(i.state.doc, 'anchor', 'name', BOOKMARK)!;
    i.dispatch(i.state.tr.delete(anchorNow.pos, anchorNow.pos + anchorNow.size));
    expect(find(i.state.doc, 'anchor', 'name', BOOKMARK)).toBeNull();
  });

  it('keeps a numbered equation that a ref names as eq:energy, and allows it once the ref is gone', () => {
    const c = new DocumentCore({ doc: envelope(), access: editorAccess(), schedule: microtask });
    const i = internals(c);
    const EQ_ID = 'eqCoreDelete0001';
    const target = 'eq:energy';

    // A numbered display equation labelled `energy` goes before the second paragraph.
    const block = i.state.schema.nodes['equation_block']!.create({
      id: EQ_ID,
      latex: 'E = mc^2',
      numbered: true,
      label: 'energy',
    });
    i.dispatch(i.state.tr.insert(posOf(i.state.doc, AUTH_IDS.p2), block));
    expect(find(i.state.doc, 'equation_block', 'id', EQ_ID)).not.toBeNull();

    const start2 = posOf(i.state.doc, AUTH_IDS.p2) + 1;
    const field = i.state.schema.nodes['field']!.create({
      kind: 'ref',
      target,
      format: null,
      cached: '1',
    });
    i.dispatch(i.state.tr.insert(start2, field));
    expect(find(i.state.doc, 'field', 'target', target)).not.toBeNull();

    // Deleting the equation while the ref names its label is refused.
    const before = i.state.doc;
    const eq = find(i.state.doc, 'equation_block', 'id', EQ_ID)!;
    i.dispatch(i.state.tr.delete(eq.pos, eq.pos + eq.size));
    expect(i.state.doc.eq(before)).toBe(true);

    // Once the ref is deleted, the equation may go.
    const ref = find(i.state.doc, 'field', 'target', target)!;
    i.dispatch(i.state.tr.delete(ref.pos, ref.pos + ref.size));
    const eqNow = find(i.state.doc, 'equation_block', 'id', EQ_ID)!;
    i.dispatch(i.state.tr.delete(eqNow.pos, eqNow.pos + eqNow.size));
    expect(find(i.state.doc, 'equation_block', 'id', EQ_ID)).toBeNull();
  });
});
