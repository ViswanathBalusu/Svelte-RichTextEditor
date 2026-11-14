/**
 * A copied fragment that carries numbering definitions pastes back in (FE-050 criterion 3, FE-051;
 * 03 §4.1, CDM-019, CDM-040, CDM-042). A numbering definition the target lacks is added once, at its
 * place in `defs` (after the styles, before the page setups); one the target already has is skipped.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };

const level = { format: 'decimal', text: '%1.', start: 1 };
const numberingDef = (id: string): Json => ({
  type: 'numbering_def',
  attrs: { id, levels: [level] },
});

/**
 * The styled fixture with numbering: `Num1` is referenced by the heading paragraph (a block's
 * `numbering`), `Num2` by the Heading 1 style, `Num3` by the quote paragraph only, and `Unused` by
 * nothing. With `blockNumbering` false the heading paragraph has no numbering of its own, so its
 * numbering comes from its style alone.
 */
function numberedDocument(blockNumbering = true): CdmEnvelope {
  const env = structuredClone(styledDocument()) as unknown as {
    cdm: number;
    requires: string[];
    doc: Json;
  };
  const defs = env.doc.content!.find((c) => c.type === 'defs')!;
  const firstPageSetup = defs.content!.findIndex((c) => c.type === 'page_setup');
  defs.content!.splice(
    firstPageSetup,
    0,
    numberingDef('Num1'),
    numberingDef('Num2'),
    numberingDef('Num3'),
    numberingDef('Unused'),
  );
  const heading1 = defs.content!.find((c) => c.attrs?.['id'] === 'Heading1')!;
  heading1.attrs!['numbering'] = { numberingId: 'Num2', level: 0, listId: 'LHead00000000001' };
  const body = env.doc.content!.find((c) => c.type === 'body')!;
  if (blockNumbering) {
    const para = body.content!.find((c) => c.attrs?.['id'] === STYLE_IDS.heading)!;
    para.attrs!['numbering'] = { numberingId: 'Num1', level: 0, listId: 'LNum100000000001' };
  }
  const quote = body.content!.find((c) => c.attrs?.['id'] === STYLE_IDS.quote)!;
  quote.attrs!['numbering'] = { numberingId: 'Num3', level: 0, listId: 'LNum300000000001' };
  return env as unknown as CdmEnvelope;
}

const FRESH_IDS = { only: 'pFresh0000000001' } as const;

/** A fresh document: settings, the Normal style, one page setup and one empty-ish paragraph. */
function freshDocument(): CdmEnvelope {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: FRESH_IDS.only, style: null },
              content: [{ type: 'text', text: 'Fresh' }],
            },
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

/** Selects the whole block `id`, so that the copied slice holds the paragraph and not only its text. */
function selectBlock(core: DocumentCore, id: string): void {
  const i = internals(core);
  const from = posOf(i.state.doc, id);
  const node = i.state.doc.nodeAt(from)!;
  i.dispatch(
    i.state.tr.setSelection(TextSelection.create(i.state.doc, from, from + node.nodeSize)),
  );
}

/** Puts the caret at the start of block `id`. */
function caretAt(core: DocumentCore, id: string): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at)));
}

function copiedHtml(core: DocumentCore): string {
  const payload = core.copySelection();
  expect(payload).not.toBeNull();
  return payload!['text/html'];
}

/** The type names of the `defs` children, in order, with their identifiers. */
function defsOrder(doc: PMNode): string[] {
  const out: string[] = [];
  doc.firstChild!.forEach((child) => {
    const id = child.attrs['id'];
    out.push(typeof id === 'string' ? `${child.type.name}:${id}` : child.type.name);
  });
  return out;
}

function numberingIds(doc: PMNode): string[] {
  return defsOrder(doc)
    .filter((d) => d.startsWith('numbering_def:'))
    .map((d) => d.slice('numbering_def:'.length));
}

/** Whether the `defs` children follow CDM-019 order: settings, styles, numbering, page setups, … */
function inCdmOrder(doc: PMNode): boolean {
  const rank = ['settings', 'style_def', 'numbering_def', 'page_setup'];
  let last = -1;
  for (const entry of defsOrder(doc)) {
    const r = rank.indexOf(entry.split(':')[0]!);
    const at = r === -1 ? rank.length : r;
    if (at < last) return false;
    last = at;
  }
  return true;
}

const violations = (core: DocumentCore) => validate(core.getContent()).violations;

describe('a numbered block pastes with its numbering (FE-050 criterion 3, FE-051)', () => {
  it('pastes a numbered block into a fresh document and adds each numbering definition once', () => {
    const source = new DocumentCore({ doc: numberedDocument(), schedule: microtask });
    selectBlock(source, STYLE_IDS.heading);
    const html = copiedHtml(source);
    const target = new DocumentCore({ doc: freshDocument(), schedule: microtask });
    expect(violations(target)).toEqual([]);
    caretAt(target, FRESH_IDS.only);
    expect(target.pasteFromClipboard({ html })).toEqual({ ok: true });
    const doc = internals(target).state.doc;
    // Num1 from the block, Num2 from the Heading 1 style; nothing unreferenced.
    expect(numberingIds(doc).sort()).toEqual(['Num1', 'Num2']);
    expect(inCdmOrder(doc)).toBe(true);
    expect(doc.textContent).toContain('Introduction');
    expect(violations(target)).toEqual([]);
  });

  it('pastes a numbered block into its own document without a duplicate definition', () => {
    const core = new DocumentCore({ doc: numberedDocument(), schedule: microtask });
    const before = violations(core).length;
    const numberingsBefore = numberingIds(internals(core).state.doc);
    selectBlock(core, STYLE_IDS.heading);
    const html = copiedHtml(core);
    caretAt(core, STYLE_IDS.after);
    expect(core.pasteFromClipboard({ html })).toEqual({ ok: true });
    const doc = internals(core).state.doc;
    expect(numberingIds(doc)).toEqual(numberingsBefore);
    expect(inCdmOrder(doc)).toBe(true);
    let intro = 0;
    doc.descendants((n) => {
      if (n.type.name === 'paragraph' && n.textContent === 'Introduction') intro += 1;
      return true;
    });
    expect(intro).toBe(2);
    // The styled fixture's own reserved style ids are violations before the paste; it adds none.
    expect(violations(core).length).toBe(before);
  });

  it('pastes a block whose numbering comes from its style, and the style brings its numbering', () => {
    const source = new DocumentCore({ doc: numberedDocument(false), schedule: microtask });
    selectBlock(source, STYLE_IDS.heading);
    const html = copiedHtml(source);
    const target = new DocumentCore({ doc: freshDocument(), schedule: microtask });
    caretAt(target, FRESH_IDS.only);
    expect(target.pasteFromClipboard({ html })).toEqual({ ok: true });
    const doc = internals(target).state.doc;
    expect(numberingIds(doc)).toEqual(['Num2']);
    expect(defsOrder(doc)).toContain('style_def:Heading1');
    expect(inCdmOrder(doc)).toBe(true);
    expect(violations(target)).toEqual([]);
  });

  it('pastes a style-numbered block into its own document without a duplicate definition', () => {
    const core = new DocumentCore({ doc: numberedDocument(false), schedule: microtask });
    const before = violations(core).length;
    const numberingsBefore = numberingIds(internals(core).state.doc);
    selectBlock(core, STYLE_IDS.heading);
    const html = copiedHtml(core);
    caretAt(core, STYLE_IDS.after);
    expect(core.pasteFromClipboard({ html })).toEqual({ ok: true });
    expect(numberingIds(internals(core).state.doc)).toEqual(numberingsBefore);
    expect(violations(core).length).toBe(before);
  });

  it('places a new numbering definition after the styles and before the page setups', () => {
    // The plain styled fixture has styles but no numbering definitions at all.
    const source = new DocumentCore({ doc: numberedDocument(), schedule: microtask });
    selectBlock(source, STYLE_IDS.quote);
    const html = copiedHtml(source);
    const target = new DocumentCore({ doc: styledDocument(), schedule: microtask });
    const before = violations(target).length;
    caretAt(target, STYLE_IDS.after);
    expect(target.pasteFromClipboard({ html })).toEqual({ ok: true });
    const order = defsOrder(internals(target).state.doc);
    expect(numberingIds(internals(target).state.doc)).toEqual(['Num3']);
    const at = order.indexOf('numbering_def:Num3');
    expect(order[at - 1]).toBe('style_def:Emphasis');
    expect(order[at + 1]).toBe('page_setup:ps1');
    expect(violations(target).length).toBe(before);
  });
});
