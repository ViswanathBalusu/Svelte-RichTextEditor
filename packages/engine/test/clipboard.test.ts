/**
 * The clipboard through the headless core (FE-050, FE-051, FE-052; 03 §4.1, §9): copy writes
 * `text/html` with the CDM fragment inside and `text/plain`; cut copies and then deletes through the
 * guard; paste uses an embedded fragment first (fresh identifiers, no bookmarks, no regions inside a
 * region, definitions only where the user may add them), and otherwise plain text.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import type { CdmFragment } from '../src/api.ts';
import {
  FRAGMENT_ATTRIBUTE,
  chooseClipboard,
  clipboardPayload,
  fragmentFromHtml,
} from '../src/clipboard.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import {
  SPIKE_IDS,
  STYLE_IDS,
  editorAccess,
  regionOnlyAccess,
  spikeDocument,
  styledDocument,
  styledEditorAccess,
} from './fixtures.ts';
import { microtask, posOf, textOfNode } from './support.ts';

/** Selects the text of the block `id` from offset `from` to offset `to`. */
function selectText(core: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(core);
  const base = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, base + from, base + to)));
}

/** Selects from offset `fromAt` of block `fromId` to offset `toAt` of block `toId`. */
function selectRange(
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

/** The number of invariant violations the document has now. */
function violationCount(core: DocumentCore): number {
  return validate(core.getContent()).violations.length;
}

/** Selects the whole node `id` (a block or a region). */
function selectNode(core: DocumentCore, id: string): void {
  const i = internals(core);
  i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, posOf(i.state.doc, id))));
}

/** Puts the caret at offset `at` in the text of the block `id`. */
function caretAt(core: DocumentCore, id: string, at = 0): void {
  selectText(core, id, at, at);
}

/** The document's text nodes that are paragraphs, in order, with their identifiers. */
function paragraphs(doc: PMNode): Array<{ id: unknown; text: string }> {
  const out: Array<{ id: unknown; text: string }> = [];
  doc.descendants((node) => {
    if (node.type.name === 'paragraph') out.push({ id: node.attrs['id'], text: node.textContent });
    return true;
  });
  return out;
}

/** A copied fragment's HTML, from a source document selection. */
function copiedHtml(source: DocumentCore): string {
  const payload = source.copySelection();
  if (!payload) throw new Error('nothing was copied');
  return payload['text/html'];
}

/** A hand-built fragment with one paragraph, for content the document does not contain. */
function singleParagraph(content: unknown[]): CdmFragment {
  return {
    cdm: 1,
    requires: [],
    defs: [],
    content: [{ type: 'paragraph', attrs: { id: 'foreignPara000001', style: null }, content }],
    openStart: 0,
    openEnd: 0,
  } as CdmFragment;
}

describe('copy writes the standard types with the fragment inside (FE-050 criterion 1)', () => {
  it('writes text/html carrying the fragment, and text/plain, and no other format', () => {
    const core = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectRange(core, STYLE_IDS.heading, 0, STYLE_IDS.plain, 5);
    const payload = core.copySelection();
    expect(payload).not.toBeNull();
    expect(Object.keys(payload!).sort()).toEqual(['text/html', 'text/plain']);
    expect(payload!['text/plain']).toBe('Introduction\nA quotation\nPlain');
    expect(payload!['text/html']).toContain(`${FRAGMENT_ATTRIBUTE}="`);
    expect(fragmentFromHtml(payload!['text/html'])).toEqual(core.getSelectionContent());
  });

  it('copies nothing from an empty selection, and changes nothing', () => {
    const core = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    caretAt(core, STYLE_IDS.plain, 2);
    const before = internals(core).state.doc;
    expect(core.copySelection()).toBeNull();
    expect(internals(core).state.doc).toBe(before);
  });
});

describe('copied HTML shows the structure and carries what it uses (FE-050 criteria 3 and 5)', () => {
  it('shows a heading as a heading and carries the definitions the heading uses', () => {
    const core = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectNode(core, STYLE_IDS.heading);
    const html = copiedHtml(core);
    expect(html).toContain('<h1>Introduction</h1>');
    const defs = fragmentFromHtml(html)!.defs.map((d) => d.attrs?.['id']);
    expect(defs).toEqual(expect.arrayContaining(['Heading1', 'Normal']));
    expect(defs).not.toContain('Chapter');
  });

  it('escapes the text and carries no script, handler or foreign markup', () => {
    const hostile = singleParagraph([
      { type: 'text', text: '<img src=x onerror="alert(1)"><script>alert(2)</script>' },
    ]);
    const html = clipboardPayload(hostile)['text/html'];
    // Only the structural elements of the copy are tags; the escaped text adds no tag or attribute.
    expect(html.replace(/<\/?(div|p|h[1-6]|strong|em)\b[^>]*>/g, '')).not.toContain('<');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;');
    // The fragment still reads back intact, so the escaped text is the text that was copied.
    expect(fragmentFromHtml(html)).toEqual(hostile);
  });

  it('shows bold and italic text with the marks as elements', () => {
    const marked = singleParagraph([
      { type: 'text', text: 'strong', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'slanted', marks: [{ type: 'italic' }] },
    ]);
    const html = clipboardPayload(marked)['text/html'];
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<em>slanted</em>');
  });
});

describe('cut copies, then deletes through the guard (FE-050 criterion 2)', () => {
  it('writes the same data as copy and deletes the selection in an editable body', () => {
    const core = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectText(core, STYLE_IDS.plain, 0, 5);
    const copied = core.copySelection();
    selectText(core, STYLE_IDS.plain, 0, 5);
    const cut = core.cutSelection();
    expect(cut.payload).toEqual(copied);
    expect(cut.deleted).toBe(true);
    expect(textOfNode(internals(core).state.doc, STYLE_IDS.plain)).toBe(' text');
  });

  it('writes the copy but deletes nothing in a region the user may not change, and says why', () => {
    const core = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    selectText(core, SPIKE_IDS.legal, 0, 2);
    const before = internals(core).state.doc;
    const cut = core.cutSelection();
    expect(cut.payload).not.toBeNull();
    expect(cut.deleted).toBe(false);
    expect(internals(core).state.doc).toBe(before);
    expect(core.refusal.get()?.scopes).toEqual([`region:${SPIKE_IDS.region}`]);
  });
});

describe('paste uses an embedded fragment first (FE-051 criteria 1 and 3)', () => {
  it('uses the fragment in preference to the HTML text and the plain text', () => {
    const source = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectText(source, STYLE_IDS.heading, 0, 12);
    const html = copiedHtml(source);
    const data = { html, text: 'Some other text' };
    expect(chooseClipboard(data).kind).toBe('fragment');
    const target = new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
    });
    caretAt(target, STYLE_IDS.after, 0);
    expect(target.pasteFromClipboard(data)).toEqual({ ok: true });
    const text = internals(target).state.doc.textContent;
    expect(text).toContain('Introduction');
    expect(text).not.toContain('Some other text');
  });

  it('maps a fragment whose definition the document already has to that definition, with no duplicate', () => {
    const source = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectNode(source, STYLE_IDS.heading);
    const target = new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
    });
    const styleDefsBefore = countNodes(internals(target).state.doc, 'style_def');
    caretAt(target, STYLE_IDS.after, 0);
    expect(target.pasteFromClipboard({ html: copiedHtml(source) })).toEqual({ ok: true });
    expect(countNodes(internals(target).state.doc, 'style_def')).toBe(styleDefsBefore);
    const pasted = paragraphs(internals(target).state.doc).filter((p) => p.text === 'Introduction');
    expect(pasted).toHaveLength(2);
  });
});

describe('paste gives fresh identifiers and keeps no bookmark (FE-051 criteria 2 and 5)', () => {
  it('gives the pasted paragraph a new identifier and leaves the original its own', () => {
    const source = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectNode(source, STYLE_IDS.heading);
    const target = new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
    });
    const before = violationCount(target);
    caretAt(target, STYLE_IDS.after, 0);
    expect(target.pasteFromClipboard({ html: copiedHtml(source) })).toEqual({ ok: true });
    const intro = paragraphs(internals(target).state.doc).filter((p) => p.text === 'Introduction');
    expect(intro.map((p) => p.id)).toContain(STYLE_IDS.heading);
    const copy = intro.find((p) => p.id !== STYLE_IDS.heading);
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe(STYLE_IDS.heading);
    // The fixture's own reserved style ids are violations before the paste; the paste adds none.
    expect(violationCount(target)).toBe(before);
  });

  it('drops an embedded bookmark and keeps the text around it', () => {
    const foreign = singleParagraph([
      { type: 'text', text: 'Before ' },
      { type: 'anchor', attrs: { name: 'bookmark-1' } },
      { type: 'text', text: 'after' },
    ]);
    const target = new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
    });
    caretAt(target, STYLE_IDS.after, 0);
    const html = clipboardPayload(foreign)['text/html'];
    expect(target.pasteFromClipboard({ html })).toEqual({ ok: true });
    const doc = internals(target).state.doc;
    expect(countNodes(doc, 'anchor')).toBe(0);
    expect(doc.textContent).toContain('Before after');
  });

  it('pastes a region from another document into a region without a nested region, and keeps it valid', () => {
    const source = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    selectNode(source, SPIKE_IDS.region);
    const html = copiedHtml(source);
    const target = new DocumentCore({
      doc: spikeDocument(),
      access: regionOnlyAccess(),
      schedule: microtask,
    });
    const regionsBefore = countNodes(internals(target).state.doc, 'region');
    caretAt(target, SPIKE_IDS.legal, 0);
    const result = target.pasteFromClipboard({ html });
    expect(result.ok).toBe(true);
    const doc = internals(target).state.doc;
    expect(countNodes(doc, 'region')).toBe(regionsBefore);
    expect(validate(target.getContent()).violations).toEqual([]);
  });
});

describe('paste refuses what the document cannot take (FE-051 criteria 4 and 6)', () => {
  it('adds no definition and pastes nothing when the fragment needs one the user may not add', () => {
    const source = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    selectNode(source, STYLE_IDS.heading);
    const html = copiedHtml(source);
    const env = styledDocument();
    type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[] };
    const defs = (env.doc as Json).content![0]!;
    defs.content = defs.content!.filter((n) => n.attrs?.['id'] !== 'Heading1');
    // styledEditorAccess lists the definitions as `view` only.
    const target = new DocumentCore({
      doc: env,
      access: styledEditorAccess(),
      schedule: microtask,
    });
    caretAt(target, STYLE_IDS.after, 0);
    const before = internals(target).state.doc;
    expect(target.pasteFromClipboard({ html })).toMatchObject({
      ok: false,
      reason: 'refused',
      refusal: 'scope',
    });
    expect(internals(target).state.doc).toBe(before);
    expect(countNodes(internals(target).state.doc, 'style_def')).toBe(
      countNodes(before, 'style_def'),
    );
  });

  it('adds no definition when a user who may edit only a region pastes a fragment that needs one', () => {
    // A style the spike document does not define, so the paste would have to add it.
    const foreign: CdmFragment = {
      cdm: 1,
      requires: [],
      defs: [
        { type: 'style_def', attrs: { id: 'ForeignStyle', kind: 'paragraph', name: 'Foreign' } },
      ],
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'foreignPara000002', style: 'ForeignStyle' },
          content: [{ type: 'text', text: 'Borrowed' }],
        },
      ],
      openStart: 0,
      openEnd: 0,
    };
    const html = clipboardPayload(foreign)['text/html'];
    const target = new DocumentCore({
      doc: spikeDocument(),
      access: regionOnlyAccess(),
      schedule: microtask,
    });
    const before = internals(target).state.doc;
    expect(styleIds(before)).not.toContain('ForeignStyle');
    caretAt(target, SPIKE_IDS.legal, 0);
    expect(target.pasteFromClipboard({ html })).toMatchObject({ ok: false, reason: 'refused' });
    expect(internals(target).state.doc).toBe(before);
    expect(styleIds(internals(target).state.doc)).not.toContain('ForeignStyle');
  });

  it('refuses a paste into a locked region, as it refuses typing', () => {
    const source = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    selectNode(source, SPIKE_IDS.region);
    const target = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    selectText(target, SPIKE_IDS.legal, 1, 1);
    const before = internals(target).state.doc;
    expect(target.pasteFromClipboard({ html: copiedHtml(source) })).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    expect(target.pasteFromClipboard({ text: 'typed' })).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    expect(internals(target).state.doc).toBe(before);
  });
});

describe('plain text from the clipboard (FE-052 criteria 1 and 3)', () => {
  it('ignores HTML that carries no fragment and pastes its plain text, one paragraph per line', () => {
    expect(chooseClipboard({ html: '<p>Hi</p>', text: 'One\nTwo' })).toEqual({
      kind: 'text',
      text: 'One\nTwo',
    });
    const target = new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
    });
    caretAt(target, STYLE_IDS.after, 0);
    expect(target.pasteFromClipboard({ html: '<p>Hi</p>', text: 'One\nTwo' })).toEqual({
      ok: true,
    });
    const doc = internals(target).state.doc;
    expect(doc.textContent).toContain('One');
    expect(doc.textContent).toContain('Two');
    expect(doc.textContent).not.toContain('<p>');
  });

  it('reports a clipboard with nothing this editor takes', () => {
    const target = new DocumentCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: microtask,
    });
    expect(chooseClipboard({})).toEqual({ kind: 'none' });
    expect(target.pasteFromClipboard({})).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('does not read a damaged fragment attribute as a fragment', () => {
    const html = `<div ${FRAGMENT_ATTRIBUTE}="%7Bnot-json">x</div>`;
    expect(fragmentFromHtml(html)).toBeNull();
    expect(chooseClipboard({ html, text: 'x' })).toEqual({ kind: 'text', text: 'x' });
  });
});

/** The identifiers of the style definitions in a document. */
function styleIds(doc: PMNode): unknown[] {
  const ids: unknown[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'style_def') ids.push(node.attrs['id']);
    return true;
  });
  return ids;
}

/** The number of nodes of a type in a document. */
function countNodes(doc: PMNode, type: string): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === type) n++;
    return true;
  });
  return n;
}
