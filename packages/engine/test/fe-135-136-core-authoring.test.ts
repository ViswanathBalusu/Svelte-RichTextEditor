/**
 * The break and page-field commands through the core, as the user reaches them (FE-135 criterion 1,
 * FE-136 criterion 1). `insertBreak` and `insertField` run through `DocumentCore.run` and
 * `queryCommand`; the region guard's real `canWrite` (guard.ts) decides where the user may change the
 * document, and the story's `canEdit` decides the header. No test predicate stands in for the guard.
 */
import type { Access } from '@docedit/protocol';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { LAYOUT_IDS, layoutEnvelope } from './layout-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const READ = ['view', 'comment'] as const;
const REGION = `region:${LAYOUT_IDS.region}`;
const HEADER = `story:${LAYOUT_IDS.header}`;

/** An editor: the body, but not the restricted region, the definitions or the header (07 §4, §5.3). */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'], [REGION]: [...READ] },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

/** An owner: everything, with `structure` (P2) and the header story (07 §4). */
function ownerAccess(): Access {
  return {
    ...editorAccess(),
    docRole: 'owner',
    caps: [...EDIT, 'structure', 'manage'],
    scopes: {
      doc: [...EDIT],
      body: [...EDIT],
      defs: [...EDIT],
      [REGION]: [...EDIT],
      [HEADER]: [...EDIT],
    },
  };
}

function core(access: Access): DocumentCore {
  const doc = layoutEnvelope() as unknown as CdmJsonNode;
  const envelope: CdmEnvelope = { cdm: 1, requires: [], doc };
  return new DocumentCore({ doc: envelope, access, schedule: microtask });
}

/** The nodes of `type` in `root`, in document order. */
function ofType(root: PMNode, type: string): PMNode[] {
  const out: PMNode[] = [];
  root.descendants((node) => {
    if (node.type.name === type) out.push(node);
    return true;
  });
  return out;
}

/** The story with `id` (a top-level node of the document), or null. */
function storyNode(doc: PMNode, id: string): PMNode | null {
  const out: PMNode[] = [];
  doc.forEach((node) => {
    if (node.type.name === 'story' && node.attrs['id'] === id) out.push(node);
  });
  return out[0] ?? null;
}

/** Whether the document changed since `before` (by identity, which ProseMirror keeps on no change). */
const changedSince = (c: DocumentCore, before: PMNode): boolean =>
  internals(c).state.doc !== before;

const DISABLED = { enabled: false, active: false } as const;
const ENABLED = { enabled: true, active: false } as const;

describe('insertBreak through the core (FE-135 criterion 1)', () => {
  it('inserts a page, column and line break as `break` nodes in body text', () => {
    const c = core(editorAccess());
    for (const breakKind of ['page', 'column', 'line'] as const) {
      caret(c, LAYOUT_IDS.pB, 2);
      expect(c.queryCommand('insertBreak', { breakKind })).toEqual(ENABLED);
      const before = internals(c).state.doc;
      expect(c.run('insertBreak', { breakKind })).toBe(true);
      expect(changedSince(c, before)).toBe(true);
    }
    const kinds = ofType(internals(c).state.doc, 'break').map((b) => b.attrs['kind']);
    expect([...kinds].sort()).toEqual(['column', 'line', 'page']);
  });

  it('refuses a page or column break in a table cell and in a footnote (I10), and allows a line break', () => {
    const c = core(editorAccess());
    for (const place of [LAYOUT_IDS.cell, LAYOUT_IDS.pNote]) {
      for (const breakKind of ['page', 'column'] as const) {
        caret(c, place, 1);
        expect(c.queryCommand('insertBreak', { breakKind }).enabled).toBe(false);
        const before = internals(c).state.doc;
        expect(c.run('insertBreak', { breakKind })).toBe(false);
        expect(changedSince(c, before)).toBe(false);
      }
      caret(c, place, 1);
      const before = internals(c).state.doc;
      expect(c.run('insertBreak', { breakKind: 'line' })).toBe(true);
      expect(changedSince(c, before)).toBe(true);
    }
  });

  it('is unavailable where the real guard protects the region, and changes nothing', () => {
    const c = core(editorAccess());
    expect(c.canEdit(REGION)).toBe(false);
    caret(c, LAYOUT_IDS.inRegion, 2);
    expect(c.queryCommand('insertBreak', { breakKind: 'page' })).toEqual({
      ...DISABLED,
      reason: 'no-access',
    });
    const before = internals(c).state.doc;
    expect(c.run('insertBreak', { breakKind: 'page' })).toBe(false);
    expect(changedSince(c, before)).toBe(false);
  });

  it('is unavailable without the argument, and in view mode with the reason read-only', () => {
    const c = core(editorAccess());
    caret(c, LAYOUT_IDS.pB, 2);
    expect(c.queryCommand('insertBreak').enabled).toBe(false);
    c.setMode('view');
    expect(c.queryCommand('insertBreak', { breakKind: 'page' })).toEqual({
      ...DISABLED,
      reason: 'read-only',
    });
    expect(c.run('insertBreak', { breakKind: 'page' })).toBe(false);
  });
});

describe('insertField through the core (FE-136 criterion 1)', () => {
  /** The caret three characters into the header story's paragraph, as its sub-editor counts it. */
  const inHeader = { id: LAYOUT_IDS.header, pos: 1 + 3 };

  it('inserts a page number in the chosen format and a page count into a header story', () => {
    const c = core(ownerAccess());
    caret(c, LAYOUT_IDS.pB, 0);
    const page = { field: { kind: 'page' as const, format: 'lowerRoman', story: inHeader } };
    expect(c.queryCommand('insertField', page)).toEqual(ENABLED);
    expect(c.run('insertField', page)).toBe(true);
    const count = { field: { kind: 'pageCount' as const, story: inHeader } };
    expect(c.run('insertField', count)).toBe(true);

    const doc = internals(c).state.doc;
    const header = storyNode(doc, LAYOUT_IDS.header);
    expect(header).not.toBeNull();
    const fields = ofType(header!, 'field').map((f) => [f.attrs['kind'], f.attrs['format']]);
    expect(fields).toEqual([
      ['pageCount', null],
      ['page', 'lowerRoman'],
    ]);
    // The field is in the header, not in the body: the body holds no field node.
    expect(ofType(doc, 'field')).toHaveLength(2);
    // The core's own selection stayed in the body.
    expect(c.selectionScope().scope).toBe('body');
  });

  it('refuses a page number in body text, and a header story the user may not change', () => {
    const owner = core(ownerAccess());
    caret(owner, LAYOUT_IDS.pB, 2);
    expect(owner.queryCommand('insertField', { field: { kind: 'page' } }).enabled).toBe(false);
    const before = internals(owner).state.doc;
    expect(owner.run('insertField', { field: { kind: 'page' } })).toBe(false);
    expect(changedSince(owner, before)).toBe(false);

    const editor = core(editorAccess());
    expect(editor.canEdit(HEADER)).toBe(false);
    const page = { field: { kind: 'page' as const, story: inHeader } };
    expect(editor.queryCommand('insertField', page)).toEqual({
      ...DISABLED,
      reason: 'no-access',
    });
    const editorBefore = internals(editor).state.doc;
    expect(editor.run('insertField', page)).toBe(false);
    expect(changedSince(editor, editorBefore)).toBe(false);
  });
});
