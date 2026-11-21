/**
 * UX-102 at the core (lane w3, 2026-11-21): what the ruler and the paragraph dialog read and write.
 * The view `paragraphFormat` gives the indents and tab stops of the paragraphs at the selection,
 * the document's default tab interval and the PDF's page of the section; `setParagraphFormat`
 * stores indents and, new with this story, tab stops. Node.js, the headless core; the ruler itself
 * runs in the browsers (packages/ui/e2e and packages/element/e2e, ux-102-ruler.spec.ts).
 */
import fc from 'fast-check';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { validParagraphFormat } from '../src/paragraph-format.ts';
import { tabStopsOf, type TabStopInfo } from '../src/paragraph-format-info.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, spikeDocument } from './fixtures.ts';
import { caret, posOf } from './support.ts';

const now = (run: () => void): void => run();

function core(doc: CdmEnvelope = spikeDocument()): DocumentCore {
  return new DocumentCore({ doc, schedule: now });
}

const format = (c: DocumentCore) => c.paragraphFormat.get()!;
const set = (c: DocumentCore, patch: Record<string, unknown>): boolean =>
  c.run('setParagraphFormat', { paragraphFormat: patch });

/** Selects from the start of one block to the end of another. */
function select(c: DocumentCore, from: string, to: string): void {
  const i = internals(c);
  const a = posOf(i.state.doc, from) + 1;
  const end = posOf(i.state.doc, to);
  const b = end + i.state.doc.nodeAt(end)!.nodeSize - 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, a, b)));
}

const TABS: TabStopInfo[] = [
  { position: 1440, align: 'left', leader: 'none' },
  { position: 4320, align: 'decimal', leader: 'dot' },
];

describe('UX-102 criterion 1: the format of the paragraph the caret is in', () => {
  it('is zero indents, no tab stops, the default tab interval and the page of the section', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 3);
    expect(format(c)).toEqual({
      count: 1,
      indentLeft: 0,
      indentRight: 0,
      indentFirstLine: 0,
      tabs: [],
      defaultTabStop: 720,
      page: { width: 11906, marginLeft: 1440, marginRight: 1440 },
      editable: true,
    });
  });

  it('follows the paragraph: its indents, a hanging first line and its tab stops by position', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 3);
    expect(set(c, { indentLeft: 720, indentRight: 360, indentFirstLine: -360 })).toBe(true);
    // Given out of order: the view gives them by position.
    expect(set(c, { tabs: [TABS[1], TABS[0]] })).toBe(true);
    expect(format(c)).toMatchObject({
      indentLeft: 720,
      indentRight: 360,
      indentFirstLine: -360,
      tabs: TABS,
    });
    // Another paragraph has its own.
    caret(c, SPIKE_IDS.last, 0);
    expect(format(c)).toMatchObject({ indentLeft: 0, indentFirstLine: 0, tabs: [] });
    caret(c, SPIKE_IDS.intro, 0);
    expect(format(c).tabs).toEqual(TABS);
  });

  it('tells its readers when the caret moves to a paragraph that is set differently, and not otherwise', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 0);
    set(c, { indentLeft: 720 });
    let told = 0;
    c.paragraphFormat.subscribe(() => told++);
    caret(c, SPIKE_IDS.intro, 5);
    expect(told).toBe(0);
    caret(c, SPIKE_IDS.last, 0);
    expect(told).toBe(1);
    caret(c, SPIKE_IDS.after, 0);
    expect(told).toBe(1);
  });

  it('is null for a value the selected paragraphs do not share, and counts them', () => {
    const c = core();
    caret(c, SPIKE_IDS.after, 0);
    set(c, { indentLeft: 1440, tabs: TABS });
    select(c, SPIKE_IDS.after, SPIKE_IDS.last);
    expect(format(c)).toMatchObject({
      count: 2,
      indentLeft: null,
      indentRight: 0,
      indentFirstLine: 0,
      tabs: null,
    });
    // One patch sets them all; the value is then shared.
    expect(set(c, { indentLeft: 360, tabs: null })).toBe(true);
    expect(format(c)).toMatchObject({ count: 2, indentLeft: 360, tabs: [] });
  });

  it('gives the page of the section the selection starts in', () => {
    const doc = spikeDocument() as unknown as {
      doc: { content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
    };
    const defs = doc.doc.content.find((n) => n.type === 'defs')!;
    defs.content.push({
      type: 'page_setup',
      attrs: {
        id: 'ps2',
        width: 16838,
        height: 11906,
        marginLeft: 720,
        marginRight: 1080,
        gutter: 360,
      },
    });
    const body = doc.doc.content.find((n) => n.type === 'body')!;
    // A section break before the last paragraph: what follows is set on the second page setup.
    body.content.splice(body.content.length - 1, 0, {
      type: 'section_break',
      attrs: { id: 'sbTwo00000000001', pageSetup: 'ps2' },
    });
    const c = core(doc as unknown as CdmEnvelope);
    caret(c, SPIKE_IDS.after, 0);
    expect(format(c).page).toEqual({ width: 11906, marginLeft: 1440, marginRight: 1440 });
    caret(c, SPIKE_IDS.last, 0);
    // The gutter is on the inner side, which is the left of a one-sided page.
    expect(format(c).page).toEqual({ width: 16838, marginLeft: 1080, marginRight: 1080 });
    // A paragraph inside a region is in the section its region is in.
    caret(c, SPIKE_IDS.legal, 0);
    expect(format(c).page).toEqual({ width: 11906, marginLeft: 1440, marginRight: 1440 });
  });

  it('says whether the paragraphs may be changed: not in a region the user may not edit, not when viewing', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: now, access: editorAccess() });
    caret(c, SPIKE_IDS.intro, 0);
    expect(format(c).editable).toBe(true);
    // The restricted region is not the editor's to change (07 §4).
    caret(c, SPIKE_IDS.legal, 0);
    expect(format(c).editable).toBe(false);
    expect(set(c, { indentLeft: 720 })).toBe(false);
    expect(format(c).indentLeft).toBe(0);
    caret(c, SPIKE_IDS.intro, 0);
    c.setMode('view');
    expect(format(c).editable).toBe(false);
    expect(set(c, { indentLeft: 720 })).toBe(false);
    c.setMode('edit');
    expect(format(c).editable).toBe(true);
  });
});

describe('UX-102 criterion 2: tab stops are stored by the paragraph format command', () => {
  it('stores them as the CDM has them, copies them, and clears them with null', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 0);
    const mine = [{ ...TABS[0]! }];
    expect(set(c, { tabs: mine })).toBe(true);
    mine[0]!.position = 9999;
    const stored = () => {
      const i = internals(c);
      return i.state.doc.nodeAt(posOf(i.state.doc, SPIKE_IDS.intro))!.attrs['tabs'] as unknown;
    };
    expect(stored()).toEqual([TABS[0]]);
    expect(set(c, { tabs: null })).toBe(true);
    expect(stored()).toBeNull();
    expect(format(c).tabs).toEqual([]);
  });

  it('is one step of undo, like any other edit', () => {
    const c = core();
    caret(c, SPIKE_IDS.intro, 0);
    set(c, { indentLeft: 720, tabs: TABS });
    expect(format(c)).toMatchObject({ indentLeft: 720, tabs: TABS });
    expect(c.run('undo')).toBe(true);
    expect(format(c)).toMatchObject({ indentLeft: 0, tabs: [] });
  });

  it('refuses tab stops that are not of the grammar, and changes nothing', () => {
    const stop = { position: 720, align: 'left', leader: 'none' };
    const bad: unknown[] = [
      [{ ...stop, position: -1 }],
      [{ ...stop, position: 31681 }],
      [{ ...stop, position: 720.5 }],
      [{ ...stop, position: null }],
      [{ ...stop, align: 'centre' }],
      [{ ...stop, leader: 'dots' }],
      [{ position: 720, align: 'left' }],
      [{ ...stop, extra: true }],
      ['720'],
      [null],
      { 0: stop },
      'left',
      Array.from({ length: 65 }, (_, i) => ({ ...stop, position: i * 10 })),
    ];
    for (const tabs of bad)
      expect(validParagraphFormat({ tabs }), JSON.stringify(tabs)).toBe(false);
    expect(validParagraphFormat({ tabs: [] })).toBe(true);
    expect(
      validParagraphFormat({
        tabs: Array.from({ length: 64 }, (_, i) => ({ ...stop, position: i * 10 })),
      }),
    ).toBe(true);
    const c = core();
    caret(c, SPIKE_IDS.intro, 0);
    expect(set(c, { indentLeft: 720, tabs: [{ ...stop, align: 'centre' }] })).toBe(false);
    expect(format(c)).toMatchObject({ indentLeft: 0, tabs: [] });
  });

  it('reads back what was stored, for any tab stops and indents of the grammar (property)', () => {
    const tab = fc.record({
      position: fc.integer({ min: 0, max: 31680 }),
      align: fc.constantFrom('left', 'center', 'right', 'decimal'),
      leader: fc.constantFrom('none', 'dot', 'hyphen', 'underscore', 'middleDot', 'heavy'),
    });
    const c = core();
    fc.assert(
      fc.property(
        fc.uniqueArray(tab, { maxLength: 64, selector: (t) => t.position }),
        fc.integer({ min: 0, max: 31680 }),
        fc.integer({ min: 0, max: 31680 }),
        fc.integer({ min: -31680, max: 31680 }),
        (tabs, left, right, first) => {
          caret(c, SPIKE_IDS.intro, 0);
          expect(
            set(c, { indentLeft: left, indentRight: right, indentFirstLine: first, tabs }),
          ).toBe(true);
          expect(format(c)).toMatchObject({
            indentLeft: left,
            indentRight: right,
            indentFirstLine: first,
            tabs: [...tabs].sort((a, b) => a.position - b.position),
          });
        },
      ),
      { numRuns: 60 },
    );
  });

  it('leaves out of the view a stop that is not of the grammar, as a document from elsewhere may hold', () => {
    expect(
      tabStopsOf({
        tabs: [
          { position: 2000, align: 'right', leader: 'dot' },
          { position: 'x', align: 'left', leader: 'none' },
          { position: 500, align: 'left', leader: 'none' },
          { position: 900, align: 'justify', leader: 'none' },
          null,
        ],
      }),
    ).toEqual([
      { position: 500, align: 'left', leader: 'none' },
      { position: 2000, align: 'right', leader: 'dot' },
    ]);
    expect(tabStopsOf({ tabs: null })).toEqual([]);
    expect(tabStopsOf({})).toEqual([]);
  });
});
