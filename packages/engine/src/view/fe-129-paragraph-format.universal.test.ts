/**
 * FE-129 criteria 1, 3 and 5: the paragraph format command stores the values a person sets, the web
 * view draws them, a paragraph with keep rules says they take effect in the PDF and the read view,
 * and borders and shading are stored and drawn.
 *
 * The first suite runs everywhere: the command through the editing core, and the pure CSS values.
 * The second mounts the body view and reads what the page draws; it runs in real browser engines
 * through `pnpm vitest run --project browser <this file>` (Chromium, Firefox and WebKit) and is
 * skipped in Node.js, where there is no DOM.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import { styledEditorAccess } from '../../test/fixtures.ts';
import { bodyRange } from '../body.ts';
import { spikeDocument } from '../spike-document.ts';
import { internals } from '../testing.ts';
import { paragraphCss, paragraphLayoutNote } from './paragraph-format-view.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

function newCore(): EditorCore {
  return new EditorCore({
    doc: spikeDocument() as never,
    access: styledEditorAccess(),
    schedule: (run) => queueMicrotask(run),
  });
}

/** Puts the caret in the first body paragraph and returns its position. */
function caretInFirstParagraph(core: EditorCore): number {
  const i = internals(core);
  const pos = bodyRange(i.state.doc).start + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
  return pos;
}

function attrsAt(core: EditorCore, pos: number): Record<string, unknown> {
  const doc = internals(core).state.doc;
  return { ...doc.resolve(pos).parent.attrs };
}

describe('the paragraph format command through the editing core (FE-129 criterion 1)', () => {
  it('is registered, takes its values as an argument, and is unavailable without them', () => {
    const core = newCore();
    caretInFirstParagraph(core);
    expect(core.queryCommand('setParagraphFormat').enabled).toBe(false);
    expect(
      core.queryCommand('setParagraphFormat', { paragraphFormat: { align: 'center' } }).enabled,
    ).toBe(true);
    core.destroy();
  });

  it('stores alignment, indents, spacing and line spacing with its rule as integers', () => {
    const core = newCore();
    const pos = caretInFirstParagraph(core);
    const patch = {
      align: 'justify',
      indentLeft: 720,
      indentRight: 360,
      indentFirstLine: -360,
      spaceBefore: 120,
      spaceAfter: 240,
      lineSpacing: 1500,
      lineRule: 'multiple',
    };
    expect(core.exec('setParagraphFormat', { paragraphFormat: patch })).toBe(true);
    expect(attrsAt(core, pos)).toMatchObject(patch);
    // A second rule: exact, in twips.
    expect(
      core.exec('setParagraphFormat', { paragraphFormat: { lineRule: 'exact', lineSpacing: 360 } }),
    ).toBe(true);
    expect(attrsAt(core, pos)).toMatchObject({ lineRule: 'exact', lineSpacing: 360 });
    core.destroy();
  });

  it('clears a property with null and refuses a value out of range without changing anything', () => {
    const core = newCore();
    const pos = caretInFirstParagraph(core);
    expect(core.exec('setParagraphFormat', { paragraphFormat: { indentLeft: 720 } })).toBe(true);
    expect(core.exec('setParagraphFormat', { paragraphFormat: { indentLeft: null } })).toBe(true);
    expect(attrsAt(core, pos)['indentLeft']).toBeNull();
    const before = attrsAt(core, pos);
    for (const bad of [
      { indentLeft: 40000 },
      { spaceBefore: -1 },
      { lineSpacing: 0 },
      { lineSpacing: 1.5 },
      { align: 'diagonal' },
      { lineRule: 'exactly' },
      { keepNext: 'yes' },
      { unknown: 1 },
    ])
      expect(core.exec('setParagraphFormat', { paragraphFormat: bad as never }), String(bad)).toBe(
        false,
      );
    expect(attrsAt(core, pos)).toEqual(before);
    core.destroy();
  });

  it('writes onto every selected paragraph the user may edit, and leaves the others', () => {
    const core = newCore();
    core.exec('selectAll');
    expect(core.exec('setParagraphFormat', { paragraphFormat: { spaceAfter: 480 } })).toBe(true);
    const doc = internals(core).state.doc;
    const { start, end } = bodyRange(doc);
    const set: string[] = [];
    const left: string[] = [];
    doc.nodesBetween(start, end, (node) => {
      if (node.type.name !== 'paragraph') return true;
      (node.attrs['spaceAfter'] === 480 ? set : left).push(node.textContent.slice(0, 8));
      return true;
    });
    // Body paragraphs are set. A footnote's paragraph is edited in its own panel, and a paragraph of
    // a region the user may not edit stays as it was.
    expect(set).toEqual(['Scope', 'Alpha br', 'Remote t', 'Last par']);
    expect(left).toEqual(['Footnote', 'Liabilit']);
    core.destroy();
  });
});

describe('keep rules and widow control (FE-129 criterion 3)', () => {
  it('stores them as booleans', () => {
    const core = newCore();
    const pos = caretInFirstParagraph(core);
    const patch = { keepNext: true, keepLines: true, pageBreakBefore: true, widowControl: false };
    expect(core.exec('setParagraphFormat', { paragraphFormat: patch })).toBe(true);
    expect(attrsAt(core, pos)).toMatchObject(patch);
    core.destroy();
  });

  it('says that they take effect in the PDF and the read view, and names the rules', () => {
    const note = paragraphLayoutNote({
      keepNext: true,
      keepLines: false,
      pageBreakBefore: true,
      widowControl: true,
    });
    expect(note).toContain('keep with next');
    expect(note).toContain('page break before');
    expect(note).not.toContain('keep lines together');
    expect(note).toContain('the PDF and the read view');
    expect(paragraphLayoutNote({ widowControl: false })).toContain('widow control off');
  });

  it('says nothing for a paragraph with no rule, and nothing for widow control left on', () => {
    expect(paragraphLayoutNote({})).toBeNull();
    expect(paragraphLayoutNote({ keepNext: false, widowControl: true })).toBeNull();
    expect(paragraphLayoutNote({ keepNext: null, widowControl: null })).toBeNull();
  });
});

describe('borders and shading of a paragraph (FE-129 criterion 5)', () => {
  const borders = {
    top: { style: 'single', width: 8, color: '#FF0000', space: 40 },
    bottom: { style: 'double', width: 12 },
    left: null,
  };

  it('stores borders and shading whole, and copies them', () => {
    const core = newCore();
    const pos = caretInFirstParagraph(core);
    const patch = { borders, shading: { fill: '#FFF2CC' } };
    expect(core.exec('setParagraphFormat', { paragraphFormat: patch })).toBe(true);
    const stored = attrsAt(core, pos);
    expect(stored['borders']).toEqual(borders);
    expect(stored['shading']).toEqual({ fill: '#FFF2CC' });
    // The document holds its own copy: a later change of the caller's object does not reach it.
    expect(stored['borders']).not.toBe(borders);
    expect(core.exec('setParagraphFormat', { paragraphFormat: { borders: null } })).toBe(true);
    expect(attrsAt(core, pos)['borders']).toBeNull();
    core.destroy();
  });

  it('refuses a value outside the CDM grammar', () => {
    const core = newCore();
    caretInFirstParagraph(core);
    for (const bad of [
      { borders: { top: { style: 'wavy' } } },
      { borders: { top: { style: 'single', width: 241 } } },
      { borders: { top: { style: 'single', color: 'red' } } },
      { borders: { middle: { style: 'single' } } },
      { borders: { top: { style: 'single', extra: 1 } } },
      { borders: [] },
      { shading: { fill: 'yellow' } },
      { shading: { fill: '#FFFF00', pattern: 'x' } },
      { shading: {} },
    ])
      expect(
        core.exec('setParagraphFormat', { paragraphFormat: bad as never }),
        JSON.stringify(bad),
      ).toBe(false);
    core.destroy();
  });

  it('computes the CSS of the stored values, and draws nothing from an invalid one', () => {
    expect(
      paragraphCss({
        indentLeft: 720,
        indentRight: 360,
        indentFirstLine: -360,
        spaceBefore: 120,
        spaceAfter: 240,
        lineSpacing: 1500,
        lineRule: 'multiple',
        borders,
        shading: { fill: '#FFF2CC' },
      }),
    ).toEqual({
      marginInlineStart: '36pt',
      marginInlineEnd: '18pt',
      textIndent: '-18pt',
      marginBlockStart: '6pt',
      marginBlockEnd: '12pt',
      lineHeight: '1.5',
      borderTop: '1pt solid #FF0000',
      paddingTop: '2pt',
      borderBottom: '1.5pt double currentcolor',
      backgroundColor: '#FFF2CC',
    });
    expect(paragraphCss({ lineSpacing: 360, lineRule: 'exact' }).lineHeight).toBe('18pt');
    expect(paragraphCss({ lineSpacing: 360, lineRule: 'atLeast' }).lineHeight).toBe(
      'max(1.2em, 18pt)',
    );
    expect(paragraphCss({})).toEqual({});
    expect(paragraphCss({ indentLeft: 1.5, spaceBefore: -1, lineSpacing: 0 })).toEqual({});
    expect(paragraphCss({ lineSpacing: 1000, lineRule: 'wavy' })).toEqual({});
    expect(paragraphCss({ shading: { fill: 'red; position: fixed' } })).toEqual({});
    expect(
      paragraphCss({ borders: { top: { style: 'single', color: 'red; position: fixed' } } }),
    ).toEqual({});
  });
});

describe.skipIf(!isBrowser)(
  'the body view draws the paragraph format (FE-129 criteria 1, 3, 5)',
  () => {
    it('draws the values the command stored, and removes them when they are cleared', async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const core = newCore();
      const unmount = core.mountBody(host);
      try {
        const paragraphs = (): HTMLElement[] =>
          [...host.querySelectorAll<HTMLElement>('.de-body p, .de-body h1, .de-body h2')].filter(
            (p) => p.textContent !== '',
          );
        const caretText = paragraphs()[0]!.textContent;
        caretInFirstParagraph(core);
        const first = (): HTMLElement => paragraphs().find((p) => p.textContent === caretText)!;
        expect(first().style.marginInlineStart).toBe('');
        expect(first().hasAttribute('title')).toBe(false);

        expect(
          core.exec('setParagraphFormat', {
            paragraphFormat: {
              indentLeft: 720,
              indentFirstLine: -360,
              spaceBefore: 120,
              spaceAfter: 240,
              lineSpacing: 1500,
              lineRule: 'multiple',
              keepNext: true,
              borders: { top: { style: 'single', width: 8, color: '#FF0000', space: 40 } },
              shading: { fill: '#FFF2CC' },
            },
          }),
        ).toBe(true);
        await vi.waitFor(() => expect(first().style.marginInlineStart).toBe('36pt'));
        const el = first();
        expect(el.style.textIndent).toBe('-18pt');
        expect(el.style.marginBlockStart).toBe('6pt');
        expect(el.style.marginBlockEnd).toBe('12pt');
        expect(el.style.lineHeight).toBe('1.5');
        const drawn = getComputedStyle(el);
        expect(drawn.marginLeft).not.toBe('0px');
        expect(drawn.borderTopStyle).toBe('solid');
        expect(drawn.borderTopColor).toBe('rgb(255, 0, 0)');
        expect(drawn.backgroundColor).toBe('rgb(255, 242, 204)');
        expect(drawn.paddingTop).not.toBe('0px');
        // The keep rule is stated on the paragraph, and the style is not an inline style attribute
        // written by the schema: the values were set through the CSSOM.
        expect(el.getAttribute('title')).toContain('keep with next');
        expect(el.getAttribute('title')).toContain('the PDF and the read view');
        expect(el.hasAttribute('data-de-layout')).toBe(true);

        expect(
          core.exec('setParagraphFormat', {
            paragraphFormat: {
              indentLeft: null,
              indentFirstLine: null,
              spaceBefore: null,
              spaceAfter: null,
              lineSpacing: null,
              lineRule: null,
              keepNext: null,
              borders: null,
              shading: null,
            },
          }),
        ).toBe(true);
        await vi.waitFor(() => expect(first().style.marginInlineStart).toBe(''));
        const cleared = first();
        expect(cleared.style.textIndent).toBe('');
        expect(cleared.style.lineHeight).toBe('');
        expect(cleared.style.borderTop).toBe('');
        expect(cleared.style.backgroundColor).toBe('');
        expect(cleared.hasAttribute('title')).toBe(false);
        expect(cleared.hasAttribute('data-de-layout')).toBe(false);
      } finally {
        unmount();
        core.destroy();
        host.remove();
      }
    });

    it('keeps the heading element and the alignment class when the formatting changes', async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const core = newCore();
      const unmount = core.mountBody(host);
      try {
        const heading = (): HTMLElement => host.querySelector<HTMLElement>('.de-body h1')!;
        expect(heading()).not.toBeNull();
        const text = heading().textContent;
        const i = internals(core);
        let pos = -1;
        i.state.doc.descendants((node, p) => {
          if (pos < 0 && node.type.name === 'paragraph' && node.textContent === text) pos = p + 1;
          return pos < 0;
        });
        i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
        expect(
          core.exec('setParagraphFormat', {
            paragraphFormat: { align: 'center', spaceAfter: 480 },
          }),
        ).toBe(true);
        await vi.waitFor(() => expect(heading().classList.contains('de-align-center')).toBe(true));
        expect(heading().tagName).toBe('H1');
        expect(heading().style.marginBlockEnd).toBe('24pt');
        expect(heading().textContent).toBe(text);
      } finally {
        unmount();
        core.destroy();
        host.remove();
      }
    });
  },
);
