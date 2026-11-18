/**
 * The styles pane's core side (UX-022). Criterion 1: the styles view and the style in effect at the
 * caret, for the three kinds. Criteria 2 and 3: creating, changing and deleting a style is refused
 * to a user without `structure`, and 07 §5.3 names the region that stops a change. Node.js,
 * headless core. The suggestion case (criterion 4) is in ux-022-styles.test.ts.
 */
import { validate } from '@docedit/model/validate';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { bodyRange } from '../src/body.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';
import { caret, microtask, posOf } from './support.ts';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[] };

/** The styled document with a table style `Grid` and a table of one cell in the body. */
function tableDocument(): CdmEnvelope {
  const env = styledDocument();
  const defs = (env.doc as Json).content!.find((c) => c.type === 'defs')!;
  defs.content!.splice(1, 0, {
    type: 'style_def',
    attrs: { id: 'Grid', kind: 'table', name: 'Grid table' },
  });
  const edit = new DocumentCore({ doc: env, schedule: microtask });
  const i = internals(edit);
  const { schema } = i;
  const cell = schema.nodes['table_cell']!.create(
    null,
    schema.nodes['paragraph']!.create(null, schema.text('Cell')),
  );
  const table = schema.nodes['table']!.create({ grid: [1440], headerRows: 0 }, [
    schema.nodes['table_row']!.create(null, [cell]),
  ]);
  i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, table));
  return edit.getContent();
}

type Access = ReturnType<typeof styledEditorAccess>;

/** An editor with `structure` and `edit` in `defs`, who may not edit the restricted region. */
function structureEditor(extra: readonly string[] = []): Access {
  const base = styledEditorAccess();
  return {
    ...base,
    caps: [...base.caps, 'structure', ...extra] as Access['caps'],
    scopes: { ...base.scopes, doc: ['view', 'edit'], defs: ['view', 'edit'] },
  };
}

/** A user who may edit only the region (07 §7). */
function regionOnly(): Access {
  const base = styledEditorAccess();
  return {
    ...base,
    docRole: 'commenter',
    caps: ['view', 'comment'],
    scopes: {
      ...base.scopes,
      body: ['view', 'comment'],
      [`region:${STYLE_IDS.region}`]: ['view', 'comment', 'suggest', 'edit'],
    },
  };
}

/** The styled document whose region paragraph is in the style `Quote`, so the region uses it. */
function regionQuoteDocument(): CdmEnvelope {
  const env = styledDocument();
  const body = (env.doc as Json).content!.find((c) => c.type === 'body')!;
  const region = body.content!.find((c) => c.type === 'region')!;
  region.content![0]!.attrs!['style'] = 'Quote';
  return env;
}

function coreWith(access: Access, doc: CdmEnvelope = styledDocument()): DocumentCore {
  let n = 0;
  return new DocumentCore({
    doc,
    access,
    schedule: microtask,
    user: 'ada',
    generateId: () => `n${String(++n).padStart(15, '0')}`,
  });
}

const defsOf = (c: DocumentCore) => JSON.stringify(internals(c).state.doc.firstChild!.toJSON());

describe('UX-022 criterion 1: the styles and the style in effect at the caret', () => {
  it('lists every style of the three kinds in definition order, with name and kind', () => {
    const c = coreWith(structureEditor(), tableDocument());
    expect(c.styles.get()).toEqual([
      { id: 'Grid', name: 'Grid table', kind: 'table', basedOn: null },
      { id: 'Normal', name: 'Normal', kind: 'paragraph', basedOn: null },
      { id: 'Heading1', name: 'Heading 1', kind: 'paragraph', basedOn: 'Normal' },
      { id: 'Heading2', name: 'Heading 2', kind: 'paragraph', basedOn: 'Normal' },
      { id: 'Quote', name: 'Quote', kind: 'paragraph', basedOn: 'Normal' },
      { id: 'Chapter', name: 'Chapter', kind: 'paragraph', basedOn: 'Heading1' },
      { id: 'Emphasis', name: 'Emphasis', kind: 'character', basedOn: null },
    ]);
  });

  it('reports the paragraph, character and table style at the selection', () => {
    const c = coreWith(structureEditor(), tableDocument());
    const i = internals(c);
    caret(c, STYLE_IDS.quote, 1);
    expect(c.selection.get()).toMatchObject({
      styleId: 'Quote',
      charStyleId: null,
      tableStyleId: null,
    });
    const at = posOf(i.state.doc, STYLE_IDS.plain) + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at, at + 5)));
    expect(c.run('charStyle', { charStyle: 'Emphasis' })).toBe(true);
    expect(c.selection.get()).toMatchObject({ styleId: 'Normal', charStyleId: 'Emphasis' });
    let cell = -1;
    i.state.doc.descendants((node, pos) => {
      if (node.type.name === 'table_cell') cell = pos + 2;
      return cell < 0;
    });
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, cell)));
    expect(c.run('setTableStyle', { tableStyle: 'Grid' })).toBe(true);
    expect(c.selection.get()).toMatchObject({ tableStyleId: 'Grid', charStyleId: null });
  });
});

describe('UX-022 criterion 2: who may create, change and delete a style', () => {
  it('refuses all three to a user who may edit only a region, with a reason, and changes nothing', () => {
    const c = coreWith(regionOnly());
    const before = defsOf(c);
    for (const op of ['create', 'change', 'delete'] as const)
      expect(c.checkStyleEdit(op, 'Quote')).toEqual({
        ok: false,
        reason: 'no-access',
        regions: [],
      });
    expect(c.createStyle({ name: 'Mine', kind: 'paragraph' })).toMatchObject({
      ok: false,
      reason: 'no-access',
    });
    expect(c.changeStyle('Quote', { name: 'Quoted' })).toMatchObject({ ok: false });
    expect(c.deleteStyle('Quote')).toMatchObject({ ok: false });
    expect(defsOf(c)).toBe(before);
    // The refusal is the guard's: it names the definitions.
    expect(c.refusal.get()).toMatchObject({ reason: 'scope', scopes: ['defs'] });
  });

  it('still lets that user apply an existing style inside the region', () => {
    const c = coreWith(regionOnly());
    caret(c, STYLE_IDS.inRegion, 2);
    expect(c.run('paragraphStyle', { style: 'Quote' })).toBe(true);
    const doc = internals(c).state.doc;
    expect(doc.nodeAt(posOf(doc, STYLE_IDS.inRegion))!.attrs['style']).toBe('Quote');
  });

  it('refuses a user without structure even when the definitions are open to view', () => {
    const c = coreWith(styledEditorAccess());
    expect(c.checkStyleEdit('create')).toMatchObject({ ok: false, reason: 'no-access' });
  });

  it('refuses all three when the document is locked or the user is suggesting', () => {
    const locked = coreWith(structureEditor());
    locked.setMode('view');
    expect(locked.checkStyleEdit('create')).toMatchObject({ ok: false, reason: 'read-only' });
    const reviewing = coreWith(structureEditor());
    reviewing.setMode('review');
    expect(reviewing.checkStyleEdit('create')).toMatchObject({ ok: false, reason: 'suggestion' });
  });
});

describe('UX-022 criteria 2 and 3: creating, changing and deleting a style', () => {
  it('creates a style with a new identifier, lists it, validates, and can be applied', () => {
    const c = coreWith(structureEditor());
    const made = c.createStyle({ name: 'Callout', kind: 'paragraph', basedOn: 'Quote' });
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : '';
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.styles.get().at(-1)).toEqual({
      id,
      name: 'Callout',
      kind: 'paragraph',
      basedOn: 'Quote',
    });
    // The fixture itself reuses two reserved identifiers (`Quote`, `Emphasis`); the new style adds
    // no violation of its own.
    const codes = (env: CdmEnvelope) =>
      validate(env).violations.map((v) => `${v.code} ${v.nodeId}`);
    expect(codes(c.getContent())).toEqual(codes(styledDocument()));
    caret(c, STYLE_IDS.plain, 1);
    expect(c.run('paragraphStyle', { style: id })).toBe(true);
    expect(c.selection.get().styleId).toBe(id);
    // The new style sits before the page setup, as the CDM orders `defs`.
    const kinds: string[] = [];
    internals(c).state.doc.firstChild!.forEach((n) => kinds.push(n.type.name));
    expect(kinds.at(-1)).toBe('page_setup');
    expect(kinds.indexOf('style_def')).toBeGreaterThan(0);
  });

  it('refuses a name that is empty or taken in its kind, and a parent of another kind', () => {
    const c = coreWith(structureEditor());
    expect(c.createStyle({ name: '   ', kind: 'paragraph' })).toMatchObject({
      reason: 'bad-name',
    });
    expect(c.createStyle({ name: 'quote', kind: 'paragraph' })).toMatchObject({
      reason: 'duplicate-name',
    });
    expect(c.createStyle({ name: 'Quote', kind: 'character' }).ok).toBe(true);
    expect(c.createStyle({ name: 'Odd', kind: 'paragraph', basedOn: 'Emphasis' })).toMatchObject({
      reason: 'bad-based-on',
    });
  });

  it('renames a style and changes its parent, and refuses a built-in style, a cycle and a taken name', () => {
    const c = coreWith(structureEditor());
    expect(c.changeStyle('Quote', { name: 'Block quote' }).ok).toBe(true);
    expect(c.styles.get().find((s) => s.id === 'Quote')?.name).toBe('Block quote');
    expect(c.changeStyle('Quote', { basedOn: 'Heading2' }).ok).toBe(true);
    expect(c.changeStyle('Heading2', { name: 'Sub' })).toMatchObject({ reason: 'built-in' });
    const made = c.createStyle({ name: 'Part', kind: 'paragraph', basedOn: 'Quote' });
    const part = made.ok ? made.id : '';
    expect(c.changeStyle('Quote', { basedOn: part })).toMatchObject({ reason: 'bad-based-on' });
    expect(c.changeStyle('Chapter', { name: 'block quote' })).toMatchObject({
      reason: 'duplicate-name',
    });
    expect(c.changeStyle('nope', { name: 'X' })).toMatchObject({ reason: 'unknown-style' });
  });

  it('deletes a style nothing uses, and refuses one that is built in or still in use', () => {
    const c = coreWith(structureEditor());
    expect(c.deleteStyle('Heading1')).toMatchObject({ ok: false, reason: 'built-in' });
    expect(c.deleteStyle('Quote')).toMatchObject({ ok: false, reason: 'in-use' });
    const made = c.createStyle({ name: 'Spare', kind: 'paragraph' });
    const spare = made.ok ? made.id : '';
    expect(c.deleteStyle(spare).ok).toBe(true);
    expect(c.styles.get().some((s) => s.id === spare)).toBe(false);
  });

  it('takes a rename back with undo, like any change', () => {
    const c = coreWith(structureEditor());
    caret(c, STYLE_IDS.plain, 0);
    expect(c.changeStyle('Quote', { name: 'Block quote' }).ok).toBe(true);
    expect(c.run('undo')).toBe(true);
    expect(c.styles.get().find((s) => s.id === 'Quote')?.name).toBe('Quote');
  });

  it('names the region that stops a change to a style it uses (07 §5.3), and lets manage through', () => {
    const c = coreWith(structureEditor(), regionQuoteDocument());
    expect(c.checkStyleEdit('change', 'Quote')).toEqual({
      ok: false,
      reason: 'region',
      regions: [STYLE_IDS.region],
    });
    expect(c.changeStyle('Quote', { name: 'Block quote' })).toMatchObject({
      ok: false,
      reason: 'region',
      regions: [STYLE_IDS.region],
    });
    expect(c.styles.get().find((s) => s.id === 'Quote')?.name).toBe('Quote');
    expect(c.refusal.get()).toMatchObject({
      reason: 'scope',
      scopes: ['defs', `region:${STYLE_IDS.region}`],
    });
    // A style that no region uses needs `structure` alone.
    expect(c.checkStyleEdit('change', 'Emphasis')).toEqual({ ok: true, regions: [] });
    // With `manage`, or `edit` in the region, the check passes and lists the region.
    const owner = coreWith(structureEditor(['manage']), regionQuoteDocument());
    expect(owner.checkStyleEdit('change', 'Quote')).toEqual({
      ok: true,
      regions: [STYLE_IDS.region],
    });
    expect(owner.changeStyle('Quote', { name: 'Block quote' }).ok).toBe(true);
    const base = structureEditor();
    const withEdit = coreWith(
      {
        ...base,
        scopes: {
          ...base.scopes,
          [`region:${STYLE_IDS.region}`]: ['view', 'comment', 'suggest', 'edit'],
        },
      },
      regionQuoteDocument(),
    );
    expect(withEdit.checkStyleEdit('change', 'Quote')).toMatchObject({ ok: true });
  });

  it('keeps a built-in style as it is, whoever asks, and says so after the region check', () => {
    const owner = coreWith(structureEditor(['manage']));
    expect(owner.checkStyleEdit('change', 'Normal')).toMatchObject({
      ok: false,
      reason: 'built-in',
      regions: [STYLE_IDS.region],
    });
    const c = coreWith(structureEditor());
    expect(c.checkStyleEdit('change', 'Normal')).toMatchObject({ reason: 'region' });
  });

  it('follows a style through basedOn when it names the regions that use it', () => {
    const base = structureEditor(['manage']);
    const owner = coreWith({
      ...base,
      scopes: {
        ...base.scopes,
        [`region:${STYLE_IDS.region}`]: ['view', 'comment', 'suggest', 'edit'],
      },
    });
    const parent = owner.createStyle({ name: 'Parent', kind: 'paragraph' });
    const parentId = parent.ok ? parent.id : '';
    const child = owner.createStyle({ name: 'Child', kind: 'paragraph', basedOn: parentId });
    const childId = child.ok ? child.id : '';
    caret(owner, STYLE_IDS.inRegion, 0);
    expect(owner.run('paragraphStyle', { style: childId })).toBe(true);
    // The region's paragraph is in Child, which is based on Parent: it uses both.
    expect(owner.checkStyleEdit('change', childId)).toEqual({
      ok: true,
      regions: [STYLE_IDS.region],
    });
    expect(owner.checkStyleEdit('change', parentId)).toEqual({
      ok: true,
      regions: [STYLE_IDS.region],
    });
    // Without edit in the region, the same chain stops the user who has structure alone.
    const editor = coreWith(structureEditor(), owner.getContent());
    expect(editor.checkStyleEdit('change', parentId)).toEqual({
      ok: false,
      reason: 'region',
      regions: [STYLE_IDS.region],
    });
  });
});
