/**
 * Breaks, section breaks, columns and the continuous-break warning (FE-135 criteria 1, 2, 3 and 6;
 * I10; 03 §4.2, §4.4, §10). The commands run on the editing schema, without a backend.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  BREAK_KINDS,
  type BreakResult,
  SECTION_STARTS,
  type SectionBreakResult,
  insertBreak,
  insertSectionBreak,
  pageSetupNode,
  sectionWarnings,
} from '../src/breaks-sections.ts';
import { setPageSetup } from '../src/page-setup-commands.ts';
import { LAYOUT_IDS, caretIn, layoutState, posOfNode } from './layout-doc.ts';

const writable = () => true;

/** Applies a command that dispatches one transaction; returns its result and the new state. */
function dispatching<R>(
  state: EditorState,
  run: (dispatch: (tr: Transaction) => void) => R,
): { result: R; next: EditorState; dispatched: boolean } {
  let next: EditorState = state;
  let dispatched = false;
  const result = run((tr) => {
    dispatched = true;
    next = state.apply(tr);
  });
  return { result, next, dispatched };
}

/** The section breaks of the body, in order. */
function sectionBreaksOf(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'section_break') out.push(node);
    return true;
  });
  return out;
}

/** The break kinds in a document, in order. */
function breaks(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'break') out.push(String(node.attrs['kind']));
    return true;
  });
  return out;
}

/** Where the caret sits, by place. */
const PLACES = {
  body: (s: EditorState) => caretIn(s, LAYOUT_IDS.pB, 2),
  region: (s: EditorState) => caretIn(s, LAYOUT_IDS.inRegion, 2),
  cell: (s: EditorState) => caretIn(s, LAYOUT_IDS.cell, 1),
  // Inside the figure's caption: figure open, caption open, then the caption's text.
  caption: (s: EditorState) =>
    s.apply(
      s.tr.setSelection(TextSelection.create(s.doc, posOfNode(s.doc, LAYOUT_IDS.figure) + 2)),
    ),
  footnote: (s: EditorState) => caretIn(s, LAYOUT_IDS.pNote, 2),
} as const;

type Place = keyof typeof PLACES;

const at = (place: Place): EditorState => PLACES[place](layoutState());

describe('a break is inserted where the rules of I10 allow it (FE-135 criterion 1)', () => {
  it('inserts a page, column and line break in body text', () => {
    for (const kind of ['page', 'column', 'line'] as const) {
      const { result, next, dispatched } = dispatching(at('body'), (dispatch) =>
        insertBreak(at('body'), kind, { writable }, dispatch),
      );
      expect(result).toEqual({ ok: true });
      expect(dispatched).toBe(true);
      expect(breaks(next.doc)).toEqual([kind]);
    }
  });

  it('refuses a page and a column break in a table cell, a caption and a footnote, and changes nothing', () => {
    for (const place of ['cell', 'caption', 'footnote'] as const) {
      for (const kind of ['page', 'column'] as const) {
        const { result, dispatched } = dispatching(at(place), (dispatch) =>
          insertBreak(at(place), kind, { writable }, dispatch),
        );
        expect(result.ok, `${kind} in ${place}`).toBe(false);
        expect(dispatched, `${kind} in ${place}`).toBe(false);
      }
    }
  });

  it('gives the reason for each refusal', () => {
    const reasonOf = (place: Place, kind: string): BreakResult =>
      insertBreak(at(place), kind, { writable });
    expect(reasonOf('cell', 'page')).toEqual({ ok: false, reason: 'in-cell' });
    expect(reasonOf('caption', 'column')).toEqual({ ok: false, reason: 'in-caption' });
    expect(reasonOf('footnote', 'page')).toEqual({ ok: false, reason: 'in-footnote' });
  });

  it('keeps a line break allowed in the cell, the caption, the footnote, the body and the region', () => {
    for (const place of ['cell', 'caption', 'footnote', 'body', 'region'] as const) {
      expect(insertBreak(at(place), 'line', { writable }).ok, place).toBe(true);
    }
  });

  it('refuses an unknown kind and a position the guard protects', () => {
    expect(insertBreak(at('body'), 'tab', { writable })).toEqual({ ok: false, reason: 'bad-kind' });
    expect(insertBreak(at('body'), 'page', { writable: () => false })).toEqual({
      ok: false,
      reason: 'read-only',
    });
  });

  it('refuses page and column breaks exactly in cells, captions and footnotes, for every kind and place (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BREAK_KINDS),
        fc.constantFrom<Place>('body', 'region', 'cell', 'caption', 'footnote'),
        (kind, place) => {
          const result = insertBreak(at(place), kind, { writable });
          const refused = kind !== 'line' && place !== 'body' && place !== 'region';
          expect(result.ok).toBe(!refused);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('a section break starts a new page section (FE-135 criterion 2, the position only)', () => {
  const args = {
    start: 'continuous',
    sectionId: 'secLayout00000001',
    pageSetupId: 'ps3Layout0000000001',
    writable,
  };

  it('adds a section break as a direct child of the body after the caret paragraph, with its own page setup', () => {
    const { result, next } = dispatching(at('body'), (dispatch) =>
      insertSectionBreak(at('body'), args, dispatch),
    );
    expect(result).toEqual({ ok: true });
    const body = next.doc.child(next.doc.childCount - 1);
    const sections = sectionBreaksOf(next.doc);
    expect(sections).toHaveLength(1);
    // Directly after the caret paragraph (pB), which is the body's fifth block.
    let sectionIndex = -1;
    body.forEach((child, _offset, index) => {
      if (child.type.name === 'section_break') sectionIndex = index;
    });
    expect(body.child(sectionIndex - 1).attrs['id']).toBe(LAYOUT_IDS.pB);
    const section = sections[0]!;
    expect(section.attrs['start']).toBe('continuous');
    expect(section.attrs['pageSetup']).toBe('ps3Layout0000000001');
    // The new definition sits in `defs`, after the existing page setups.
    expect(next.doc.firstChild!.lastChild!.attrs['id']).toBe('ps3Layout0000000001');
    expect(next.doc.firstChild!.lastChild!.type.name).toBe('page_setup');
  });

  it('copies the page setup of the caret section without its header story', () => {
    let state = at('body');
    const setup = posOfNode(state.doc, LAYOUT_IDS.setup1);
    state = state.apply(state.tr.setNodeAttribute(setup, 'headerDefault', LAYOUT_IDS.header));
    state = state.apply(state.tr.setNodeAttribute(setup, 'marginLeft', 1800));
    const { result, next } = dispatching(state, (dispatch) =>
      insertSectionBreak(
        state,
        {
          start: 'nextPage',
          sectionId: 'secLayout00000002',
          pageSetupId: 'ps4Layout0000000001',
          writable,
        },
        dispatch,
      ),
    );
    expect(result).toEqual({ ok: true });
    const copy = next.doc.firstChild!.lastChild!;
    expect(copy.attrs['id']).toBe('ps4Layout0000000001');
    expect(copy.attrs['marginLeft']).toBe(1800);
    expect(copy.attrs['headerDefault']).toBeNull();
  });

  it('refuses a section break inside a region, in a table cell, with a range selected, or with a protected position', () => {
    const expectRefusal = (state: EditorState, options: typeof args): SectionBreakResult =>
      insertSectionBreak(state, options);
    expect(expectRefusal(at('region'), args)).toEqual({ ok: false, reason: 'in-region' });
    expect(expectRefusal(at('cell'), args)).toEqual({ ok: false, reason: 'not-in-body' });

    const base = at('body');
    const ranged = base.apply(
      base.tr.setSelection(
        TextSelection.create(base.doc, base.selection.from, base.selection.from + 2),
      ),
    );
    expect(expectRefusal(ranged, args)).toEqual({ ok: false, reason: 'not-a-caret' });

    const { result, dispatched } = dispatching(at('body'), (dispatch) =>
      insertSectionBreak(at('body'), { ...args, writable: () => false }, dispatch),
    );
    expect(result).toEqual({ ok: false, reason: 'read-only' });
    expect(dispatched).toBe(false);
  });

  it('refuses a bad start and a reused page setup or section identifier', () => {
    expect(insertSectionBreak(at('body'), { ...args, start: 'sideways' })).toEqual({
      ok: false,
      reason: 'bad-start',
    });
    expect(insertSectionBreak(at('body'), { ...args, pageSetupId: LAYOUT_IDS.setup1 })).toEqual({
      ok: false,
      reason: 'duplicate-id',
    });
    expect(insertSectionBreak(at('body'), { ...args, sectionId: LAYOUT_IDS.pB })).toEqual({
      ok: false,
      reason: 'duplicate-id',
    });
  });

  it('accepts every section start of the CDM (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SECTION_STARTS), (start) => {
        const { result, next } = dispatching(at('body'), (dispatch) =>
          insertSectionBreak(at('body'), { ...args, start }, dispatch),
        );
        expect(result).toEqual({ ok: true });
        const sections = sectionBreaksOf(next.doc);
        expect(sections.map((s) => s.attrs['start'])).toEqual([start]);
      }),
      { numRuns: 4 },
    );
  });
});

describe('page setup stores columns and the gap (FE-135 criterion 3)', () => {
  it('stores the number of columns and the gap on the page setup', () => {
    const state = at('body');
    const { result, next } = dispatching(state, (dispatch) =>
      setPageSetup(
        state,
        LAYOUT_IDS.setup1,
        { columns: 2, columnGap: 720 },
        { writable },
        dispatch,
      ),
    );
    expect(result.ok).toBe(true);
    const setup = pageSetupNode(next.doc, LAYOUT_IDS.setup1)!;
    expect(setup.attrs['columns']).toBe(2);
    expect(setup.attrs['columnGap']).toBe(720);
  });
});

describe('a continuous break that changes margins is flagged (FE-135 criterion 6, computed only)', () => {
  it('flags a continuous break whose following page setup changes a margin, and not a next-page one', () => {
    const continuous = dispatching(at('body'), (dispatch) =>
      insertSectionBreak(
        at('body'),
        {
          start: 'continuous',
          sectionId: 'secLayout00000006',
          pageSetupId: 'ps8Layout0000000001',
          writable,
        },
        dispatch,
      ),
    ).next;
    expect(sectionWarnings(continuous.doc)).toEqual([]);

    const pos = posOfNode(continuous.doc, 'ps8Layout0000000001');
    // 2880 twips: the CDM default margin is 1440, so a change to 1440 would change nothing.
    const changed = continuous.apply(continuous.tr.setNodeAttribute(pos, 'marginTop', 2880));
    expect(sectionWarnings(changed.doc)).toEqual([
      { sectionId: 'secLayout00000006', reason: 'continuous-margin-change' },
    ]);

    const nextPage = dispatching(at('body'), (dispatch) =>
      insertSectionBreak(
        at('body'),
        {
          start: 'nextPage',
          sectionId: 'secLayout00000007',
          pageSetupId: 'ps9Layout0000000001',
          writable,
        },
        dispatch,
      ),
    ).next;
    const pos9 = posOfNode(nextPage.doc, 'ps9Layout0000000001');
    const tuned = nextPage.apply(nextPage.tr.setNodeAttribute(pos9, 'marginTop', 2880));
    expect(sectionWarnings(tuned.doc)).toEqual([]);
  });
});
