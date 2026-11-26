/**
 * FE-129 criterion 6, at the core: the view `paragraphFormat.options` gives the paragraph dialog
 * every option the command sets besides indents and tab stops (alignment, spacing, line spacing and
 * its rule, keep rules, widow control, borders and shading), with the CDM's defaults, and names the
 * options the selected paragraphs do not share. Node.js, the headless core.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, spikeDocument } from './fixtures.ts';
import { caret, posOf } from './support.ts';

const now = (run: () => void): void => run();
const core = (): DocumentCore => new DocumentCore({ doc: spikeDocument(), schedule: now });
const options = (c: DocumentCore) => c.paragraphFormat.get()!.options;
const set = (c: DocumentCore, patch: Record<string, unknown>): boolean =>
  c.run('setParagraphFormat', { paragraphFormat: patch });

describe('the options of the paragraph dialog (FE-129 criterion 6)', () => {
  it('are the CDM defaults for a paragraph that sets none', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 3);
    expect(options(c)).toEqual({
      align: 'start',
      spaceBefore: 0,
      spaceAfter: 0,
      lineSpacing: 1000,
      lineRule: 'multiple',
      keepNext: false,
      keepLines: false,
      pageBreakBefore: false,
      widowControl: true,
      contextualSpacing: false,
      borders: {},
      shading: null,
      mixed: [],
    });
  });

  it('follow what the command stored', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 3);
    expect(
      set(c, {
        align: 'justify',
        spaceBefore: 120,
        spaceAfter: 240,
        lineSpacing: 360,
        lineRule: 'exact',
        keepNext: true,
        keepLines: true,
        pageBreakBefore: true,
        widowControl: false,
        contextualSpacing: true,
        borders: {
          top: { style: 'single', width: 8, color: '#FF0000', space: 40 },
          left: { style: 'none' },
          between: { style: 'dashed' },
        },
        shading: { fill: '#FFF2CC' },
      }),
    ).toBe(true);
    expect(options(c)).toEqual({
      align: 'justify',
      spaceBefore: 120,
      spaceAfter: 240,
      lineSpacing: 360,
      lineRule: 'exact',
      keepNext: true,
      keepLines: true,
      pageBreakBefore: true,
      widowControl: false,
      contextualSpacing: true,
      // A side of style `none` has no border.
      borders: {
        top: { style: 'single', width: 8, color: '#FF0000', space: 40 },
        between: { style: 'dashed' },
      },
      shading: '#FFF2CC',
      mixed: [],
    });
    // Clearing gives the defaults back.
    expect(set(c, { align: null, borders: null, shading: null, widowControl: null })).toBe(true);
    expect(options(c)).toMatchObject({
      align: 'start',
      borders: {},
      shading: null,
      widowControl: true,
    });
  });

  it("name the options the selected paragraphs do not share, and give the first one's values", () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 3);
    expect(set(c, { align: 'center', keepNext: true, shading: { fill: '#FFF2CC' } })).toBe(true);
    const i = internals(c);
    const a = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    const end = posOf(i.state.doc, SPIKE_IDS.last);
    const b = end + i.state.doc.nodeAt(end)!.nodeSize - 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, a, b)));
    const o = options(c);
    expect(o.mixed).toEqual(expect.arrayContaining(['align', 'keepNext', 'shading']));
    expect(o.mixed).not.toContain('spaceBefore');
    expect(o).toMatchObject({ align: 'center', keepNext: true, shading: '#FFF2CC' });
  });
});
