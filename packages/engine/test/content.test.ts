/**
 * Content operations of the document API (FE-027): `getSelectionContent` reads the selection as a CDM
 * fragment, and `insertContent` inserts one at the selection through the same guards as typing.
 */
import { styleTable } from '@docedit/model';
import { CDM1, supportedFeatures } from '@docedit/model/definition';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmFragment } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import {
  STYLE_IDS,
  SPIKE_IDS,
  editorAccess,
  regionOnlyAccess,
  spikeDocument,
  styledDocument,
  styledEditorAccess,
} from './fixtures.ts';
import { microtask, posOf, textOfNode } from './support.ts';

/** Selects from `fromId` (offset into its text) to `toId` (offset into its text). */
function select(
  core: DocumentCore,
  fromId: string,
  fromAt: number,
  toId: string,
  toAt: number,
): void {
  const i = internals(core);
  const doc = i.state.doc;
  const from = posOf(doc, fromId) + 1 + fromAt;
  const to = posOf(doc, toId) + 1 + toAt;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(doc, from, to)));
}

/** Selects a whole block (a closed slice): a node selection of the block `id`. */
function selectBlock(core: DocumentCore, id: string): void {
  const i = internals(core);
  const doc = i.state.doc;
  i.dispatch(i.state.tr.setSelection(NodeSelection.create(doc, posOf(doc, id))));
}

/** Puts the caret at the end of the text of the block `id`. */
function caretAtEnd(core: DocumentCore, id: string): void {
  const i = internals(core);
  const doc = i.state.doc;
  const pos = posOf(doc, id) + 1 + textOfNode(doc, id).length;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(doc, pos)));
}

/** The identifiers of the blocks of the body that declare one (the definitions are not blocks). */
function blockIds(core: DocumentCore): string[] {
  const ids: string[] = [];
  internals(core).state.doc.lastChild!.descendants((node) => {
    if (node.isBlock && typeof node.attrs['id'] === 'string') ids.push(node.attrs['id']);
    return true;
  });
  return ids;
}

const fragmentText = (f: CdmFragment): string =>
  f.content.map((n) => (n.content ?? []).map((c) => c.text ?? '').join('')).join('\n');

describe('getSelectionContent (FE-027 criterion 1)', () => {
  it('returns the selected blocks as plain JSON, with the style definitions they use', () => {
    const core = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    select(core, STYLE_IDS.heading, 0, STYLE_IDS.plain, 5);
    const f = core.getSelectionContent();
    expect(f.cdm).toBe(1);
    expect(f.requires).toEqual([]);
    expect(f.content.map((n) => n.attrs?.['id'])).toEqual([
      STYLE_IDS.heading,
      STYLE_IDS.quote,
      STYLE_IDS.plain,
    ]);
    expect(fragmentText(f)).toBe('Introduction\nA quotation\nPlain');
    // Heading1 is based on Normal, and the plain paragraph uses the default Normal. Chapter and
    // Emphasis are not used, so they are not carried.
    const defs = f.defs.map((d) => d.attrs?.['id']);
    expect(defs).toEqual(expect.arrayContaining(['Heading1', 'Quote', 'Normal']));
    expect(defs).not.toContain('Chapter');
    expect(defs).not.toContain('Emphasis');
    // Plain JSON: it survives a round trip through text, and it is a copy, not the document.
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });

  it('gives an empty fragment for an empty selection, and changes nothing', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const i = internals(core);
    const before = i.state.doc;
    i.dispatch(
      i.state.tr.setSelection(
        TextSelection.create(i.state.doc, posOf(i.state.doc, SPIKE_IDS.intro) + 2),
      ),
    );
    expect(core.getSelectionContent()).toEqual({
      cdm: 1,
      requires: [],
      defs: [],
      content: [],
      openStart: 0,
      openEnd: 0,
    });
    expect(internals(core).state.doc).toBe(before);
  });
});

describe('insertContent (FE-027 criteria 2 and 3)', () => {
  it('inserts a block through the guards, with a fresh identifier and the style it needs', () => {
    const source = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectBlock(source, STYLE_IDS.heading);
    const fragment = source.getSelectionContent();

    // A target that lacks Heading1 (but has Normal): the fragment adds Heading1 and keeps Normal.
    type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[] };
    const env = styledDocument();
    const defs = (env.doc as Json).content![0]!;
    defs.content = defs.content!.filter((n) => n.attrs?.['id'] !== 'Heading1');
    // Adding a definition changes the definitions and the document node (the authority's scopes, 07
    // §4), so the user needs `edit` in both. This user has it.
    const access = styledEditorAccess();
    const all = ['view', 'comment', 'suggest', 'edit'] as const;
    const withDefs = {
      ...access,
      scopes: { ...access.scopes, doc: [...all], defs: [...all] },
    } as typeof access;
    const target = new DocumentCore({ doc: env, access: withDefs, schedule: microtask });
    const normalBefore = styleTable(internals(target).state.doc).styles.get('Normal');
    expect(styleTable(internals(target).state.doc).styles.has('Heading1')).toBe(false);

    const idsBefore = blockIds(target);
    caretAtEnd(target, STYLE_IDS.after);
    expect(target.insertContent(fragment)).toEqual({ ok: true });

    const doc = internals(target).state.doc;
    expect(doc.textContent).toContain('Introduction');
    // The copy is one new block, and its identifier is fresh: the copy's own identifier was not kept
    // (03 §9), even though the target has a block with that identifier of its own.
    const added = blockIds(target).filter((id) => !idsBefore.includes(id));
    expect(added).toHaveLength(1);
    expect(added[0]).not.toBe(STYLE_IDS.heading);
    expect(added[0]).toHaveLength(16);
    expect(new Set(blockIds(target)).size).toBe(blockIds(target).length);
    // Heading1 is defined now; Normal, which the document already defined, is unchanged.
    const table = styleTable(doc);
    expect(table.styles.has('Heading1')).toBe(true);
    expect(table.styles.get('Normal')).toEqual(normalBefore);
  });

  it('gives a copy made in the same document a fresh identifier, and keeps every identifier unique', () => {
    const core = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    const before = blockIds(core);
    selectBlock(core, SPIKE_IDS.after);
    const fragment = core.getSelectionContent();
    caretAtEnd(core, SPIKE_IDS.last);
    expect(core.insertContent(fragment)).toEqual({ ok: true });
    const after = blockIds(core);
    expect(after).toHaveLength(before.length + 1);
    expect(new Set(after).size).toBe(after.length);
    expect(after.filter((id) => !before.includes(id))).toHaveLength(1);
  });

  it('inserts nothing for an empty fragment, and reports ok', () => {
    const core = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    const before = internals(core).state.doc;
    expect(
      core.insertContent({ cdm: 1, requires: [], defs: [], content: [], openStart: 0, openEnd: 0 }),
    ).toEqual({ ok: true });
    expect(internals(core).state.doc).toBe(before);
  });
});

describe('insertContent refuses what the document cannot take (FE-027 criteria 4 and 5)', () => {
  const partial = (): CdmFragment => {
    const source = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    select(source, SPIKE_IDS.after, 0, SPIKE_IDS.after, 2);
    return source.getSelectionContent();
  };

  it('refuses another CDM version, unknown features and features the document does not list', () => {
    const core = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    caretAtEnd(core, SPIKE_IDS.last);
    const before = internals(core).state.doc;
    const f = partial();

    expect(core.insertContent({ ...f, cdm: 2 })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(core.insertContent({ ...f, requires: ['no-such-feature'] })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });

    // A feature this build supports, which the document does not list in `requires`.
    const supported = supportedFeatures(CDM1);
    expect(supported.length).toBeGreaterThan(0);
    const feature = supported[0]!;
    expect(core.insertContent({ ...f, requires: [feature] })).toEqual({
      ok: false,
      reason: 'unsupported',
      message: expect.stringContaining('does not list in requires'),
      missing: [feature],
    });
    expect(internals(core).state.doc).toBe(before);
  });

  it('refuses content that fails the schema, and says why', () => {
    const core = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    caretAtEnd(core, SPIKE_IDS.last);
    const before = internals(core).state.doc;
    const bad: CdmFragment = {
      cdm: 1,
      requires: [],
      defs: [],
      content: [{ type: 'no_such_node', attrs: { id: 'x' } }],
      openStart: 0,
      openEnd: 0,
    };
    expect(core.insertContent(bad)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(internals(core).state.doc).toBe(before);
  });

  it('refuses a fragment that needs a style the user may not add to the definitions', () => {
    const source = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectBlock(source, STYLE_IDS.heading);
    const fragment = source.getSelectionContent();
    type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[] };
    const env = styledDocument();
    const defs = (env.doc as Json).content![0]!;
    defs.content = defs.content!.filter((n) => n.attrs?.['id'] !== 'Heading1');
    // styledEditorAccess lists the definitions as `view` only.
    const core = new DocumentCore({ doc: env, access: styledEditorAccess(), schedule: microtask });
    caretAtEnd(core, STYLE_IDS.after);
    const before = internals(core).state.doc;
    expect(core.insertContent(fragment)).toMatchObject({
      ok: false,
      reason: 'refused',
      refusal: 'scope',
    });
    expect(internals(core).state.doc).toBe(before);
    // The authority's scopes that the change touches: the definitions, and the document node above them.
    expect(core.refusal.get()?.scopes).toEqual(['defs', 'doc']);
  });

  it('refuses insertion into a region the user may not change, and records the refusal', () => {
    const core = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    select(core, SPIKE_IDS.legal, 1, SPIKE_IDS.legal, 1);
    const before = internals(core).state.doc;
    expect(core.insertContent(partial())).toEqual({
      ok: false,
      reason: 'refused',
      message: expect.stringContaining('may not change'),
      refusal: 'scope',
    });
    expect(internals(core).state.doc).toBe(before);
    expect(core.refusal.get()?.scopes).toEqual([`region:${SPIKE_IDS.region}`]);
  });

  it('refuses insertion into the body of a user who may change only a region', () => {
    const core = new DocumentCore({
      doc: spikeDocument(),
      access: regionOnlyAccess(),
      schedule: microtask,
    });
    select(core, SPIKE_IDS.intro, 0, SPIKE_IDS.intro, 0);
    const before = internals(core).state.doc;
    expect(core.insertContent(partial())).toMatchObject({ ok: false, reason: 'refused' });
    expect(internals(core).state.doc).toBe(before);
  });

  it('inserts a block into a body the user may change, while a read-only view refuses it', () => {
    const source = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    selectBlock(source, SPIKE_IDS.after);
    const fragment = source.getSelectionContent();
    const sourceText = textOfNode(internals(source).state.doc, SPIKE_IDS.after);

    const core = new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
    });
    caretAtEnd(core, STYLE_IDS.after);
    expect(core.insertContent(fragment)).toEqual({ ok: true });
    expect(internals(core).state.doc.textContent).toContain(sourceText);

    core.setMode('view');
    caretAtEnd(core, STYLE_IDS.after);
    const before = internals(core).state.doc;
    expect(core.insertContent(fragment)).toMatchObject({
      ok: false,
      reason: 'refused',
      refusal: 'read-only',
    });
    expect(internals(core).state.doc).toBe(before);
  });
});
