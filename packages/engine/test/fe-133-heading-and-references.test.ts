/**
 * FE-133 through the core (lane w1, 2026-11-17):
 *
 * - criterion 3: following `#<identifier>` of a heading moves the caret to the start of the heading
 *   (a bookmark of that name wins; a paragraph that is no heading is no target; ADR 0377);
 * - criterion 5: a deletion that a cross-reference still names is refused with the reason
 *   `referenced` and the number of references, and `showReferences` selects them one after another.
 *
 * The shell's explanation and its button are tested in packages/ui/test/fe-133-referenced-notice.test.ts.
 */
import type { Access } from '@docedit/protocol';
import { NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { caret, microtask, posOf } from './support.ts';

describe('FE-133 criterion 3: a link to a heading moves the caret there', () => {
  function styled(): DocumentCore {
    return new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
    });
  }

  it('follows #<heading id> to the start of the heading and changes nothing else', () => {
    const c = styled();
    caret(c, STYLE_IDS.plain, 0);
    const doc = internals(c).state.doc;
    expect(c.run('followInternalLink', { href: `#${STYLE_IDS.heading}` })).toBe(true);
    const state = internals(c).state;
    expect(state.doc).toBe(doc);
    expect(state.selection.empty).toBe(true);
    expect(state.selection.head).toBe(posOf(state.doc, STYLE_IDS.heading) + 1);
  });

  it('does not take a paragraph that is no heading, or an unknown identifier, as a target', () => {
    const c = styled();
    expect(c.queryCommand('followInternalLink', { href: `#${STYLE_IDS.plain}` }).enabled).toBe(
      false,
    );
    expect(c.queryCommand('followInternalLink', { href: '#nothing_here' }).enabled).toBe(false);
    expect(c.queryCommand('followInternalLink', { href: `#${STYLE_IDS.heading}` }).enabled).toBe(
      true,
    );
  });
});

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const BOOKMARK = 'Clause9';

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

/** A document with a bookmark in the first paragraph and `refs` references to it in the second. */
function withReferences(refs: number): DocumentCore {
  const envelope: CdmEnvelope = { cdm: 1, requires: [], doc: authoringEnvelope() };
  const c = new DocumentCore({ doc: envelope, access: editorAccess(), schedule: microtask });
  const i = internals(c);
  const anchor = i.state.schema.nodes['anchor']!.create({ id: 'anc0000000000002', name: BOOKMARK });
  i.dispatch(i.state.tr.insert(posOf(i.state.doc, AUTH_IDS.p1) + 1, anchor));
  for (let n = 0; n < refs; n++) {
    const field = i.state.schema.nodes['field']!.create({
      kind: 'ref',
      target: `bookmark:${BOOKMARK}`,
      format: null,
      cached: '1',
    });
    i.dispatch(i.state.tr.insert(posOf(i.state.doc, AUTH_IDS.p2) + 1, field));
  }
  return c;
}

function deleteBookmark(c: DocumentCore): void {
  const i = internals(c);
  let at = -1;
  let size = 0;
  i.state.doc.descendants((node, pos) => {
    if (node.type.name === 'anchor' && node.attrs['name'] === BOOKMARK) {
      at = pos;
      size = node.nodeSize;
    }
    return true;
  });
  i.dispatch(i.state.tr.delete(at, at + size));
}

function refPositions(c: DocumentCore): number[] {
  const out: number[] = [];
  internals(c).state.doc.descendants((node, pos) => {
    if (node.type.name === 'field' && node.attrs['kind'] === 'ref') out.push(pos);
    return true;
  });
  return out;
}

describe('FE-133 criterion 5: a deletion a cross-reference names is explained and the references can be shown', () => {
  it('records a `referenced` refusal with the number of references, and changes nothing', () => {
    const c = withReferences(2);
    const before = internals(c).state.doc;
    const n = c.refusal.get()?.n ?? 0;
    deleteBookmark(c);
    expect(internals(c).state.doc.eq(before)).toBe(true);
    const refusal = c.refusal.get();
    expect(refusal).toMatchObject({ reason: 'referenced', count: 2, scopes: [] });
    expect(refusal!.n).toBeGreaterThan(n);
    // The notice names no bookmark and no reference (ADR 0019).
    expect(JSON.stringify(refusal)).not.toContain(BOOKMARK);
  });

  it('selects the references one after another, and the first again after the last', () => {
    const c = withReferences(2);
    deleteBookmark(c);
    const [first, second] = refPositions(c) as [number, number];
    expect(c.showReferences()).toBe(true);
    const a = internals(c).state.selection;
    expect(a instanceof NodeSelection && a.from).toBe(first);
    expect(c.showReferences()).toBe(true);
    expect(internals(c).state.selection.from).toBe(second);
    expect(c.showReferences()).toBe(true);
    expect(internals(c).state.selection.from).toBe(first);
  });

  it('shows nothing when no deletion was refused for this reason, or when the references are gone', () => {
    const c = withReferences(1);
    expect(c.showReferences()).toBe(false);
    deleteBookmark(c);
    expect(c.showReferences()).toBe(true);
    const i = internals(c);
    const [ref] = refPositions(c) as [number];
    i.dispatch(i.state.tr.delete(ref, ref + 1));
    expect(c.showReferences()).toBe(false);
  });

  it('is silent for a reference that was removed together with its target', () => {
    const c = withReferences(1);
    const n = c.refusal.get()?.n ?? 0;
    const i = internals(c);
    const [ref] = refPositions(c) as [number];
    i.dispatch(i.state.tr.delete(ref, ref + 1));
    deleteBookmark(c);
    expect(c.refusal.get()?.n ?? 0).toBe(n);
  });
});
