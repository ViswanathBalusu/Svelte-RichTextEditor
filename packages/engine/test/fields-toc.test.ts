/**
 * Fields, a table of contents and symbols (FE-136 criteria 1, 2, 3 and 4; 03 §4.3, §4.4; CDM-035;
 * 09 §3.2). The commands run on the editing schema, without a backend.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { type EditorState, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  INSERTABLE_FIELD_KINDS,
  type InsertableFieldKind,
  insertField,
  insertSymbol,
  insertToc,
  isSymbolCharacter,
} from '../src/fields-toc.ts';
import { LAYOUT_IDS, caretIn, layoutState, posOfNode } from './layout-doc.ts';

const writable = () => true;
const LONDON_DATE = { instant: '2026-11-06T10:00:00.000Z', timeZone: 'Europe/London' };

/** Runs a command that dispatches one transaction; returns its result and the new state. */
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

/** The `field` nodes of a document as `[kind, cached]` pairs, in order. */
function fields(doc: PMNode): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  doc.descendants((node) => {
    if (node.type.name === 'field') out.push([String(node.attrs['kind']), node.attrs['cached']]);
    return true;
  });
  return out;
}

/** The toc atoms of a document, in order. */
function tocs(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'toc') out.push(node);
    return true;
  });
  return out;
}

/** Where the caret sits, by place: the header story, body text, a footnote, or a region. */
const PLACES = {
  header: (s: EditorState) => caretIn(s, LAYOUT_IDS.pHeader, 3),
  body: (s: EditorState) => caretIn(s, LAYOUT_IDS.pB, 2),
  region: (s: EditorState) => caretIn(s, LAYOUT_IDS.inRegion, 2),
  cell: (s: EditorState) => caretIn(s, LAYOUT_IDS.cell, 1),
} as const;
type Place = keyof typeof PLACES;
const at = (place: Place): EditorState => PLACES[place](layoutState());

describe('a page or page-count field goes in a header or footer (FE-136 criterion 1)', () => {
  it('inserts a page field in the header with the chosen format, and leaves cached empty', () => {
    const { result, next } = dispatching(at('header'), (dispatch) =>
      insertField(at('header'), 'page', { format: 'lowerRoman', writable }, dispatch),
    );
    expect(result).toEqual({ ok: true, cached: null });
    expect(fields(next.doc)).toEqual([['page', null]]);
    // The chosen format is stored on the field, not only the kind.
    let stored: unknown = undefined;
    next.doc.descendants((node) => {
      if (node.type.name === 'field') stored = node.attrs['format'];
      return true;
    });
    expect(stored).toBe('lowerRoman');
    next.doc.check();
  });

  it('inserts a page-count field in the header', () => {
    const { result, next } = dispatching(at('header'), (dispatch) =>
      insertField(at('header'), 'pageCount', { writable }, dispatch),
    );
    expect(result.ok).toBe(true);
    expect(fields(next.doc)).toEqual([['pageCount', null]]);
  });

  it('refuses a page or page-count field in the body', () => {
    expect(insertField(at('body'), 'page', { writable })).toEqual({
      ok: false,
      reason: 'not-in-story',
    });
    expect(insertField(at('body'), 'pageCount', { writable })).toEqual({
      ok: false,
      reason: 'not-in-story',
    });
  });
});

describe('a date field takes its text from the shared computation (FE-136 criterion 2, the date half)', () => {
  it('stores the date in the workflow zone, with cached holding the text (CDM-035)', () => {
    // 23:30 UTC on 6 November is already 7 November in Kolkata (UTC+5:30).
    const { result, next } = dispatching(at('body'), (dispatch) =>
      insertField(
        at('body'),
        'date',
        {
          format: 'dd/MM/yyyy',
          date: { instant: '2026-11-06T23:30:00.000Z', timeZone: 'Asia/Kolkata' },
          writable,
        },
        dispatch,
      ),
    );
    expect(result).toEqual({ ok: true, cached: '07/11/2026' });
    expect(fields(next.doc)).toEqual([['date', '07/11/2026']]);
  });

  it('uses the default format when none is given', () => {
    expect(insertField(at('body'), 'date', { date: LONDON_DATE, writable })).toEqual({
      ok: true,
      cached: '2026-11-06',
    });
  });

  it('refuses a date with no server instant, a bad zone or a date in a header', () => {
    expect(insertField(at('body'), 'date', { writable })).toEqual({
      ok: false,
      reason: 'no-date-source',
    });
    expect(
      insertField(at('body'), 'date', {
        date: { instant: LONDON_DATE.instant, timeZone: 'Mars/Olympus' },
        writable,
      }),
    ).toEqual({ ok: false, reason: 'bad-date' });
    expect(insertField(at('header'), 'date', { date: LONDON_DATE, writable })).toEqual({
      ok: false,
      reason: 'not-in-body',
    });
  });
});

describe('a title field stores the title only when the caller has one (FE-136 criterion 2, the title half)', () => {
  it('leaves cached empty without a title, and holds the given title', () => {
    expect(insertField(at('body'), 'title', { writable })).toEqual({ ok: true, cached: null });
    expect(insertField(at('body'), 'title', { title: 'Report', writable })).toEqual({
      ok: true,
      cached: 'Report',
    });
  });
});

describe('field formats, the guard and the caret', () => {
  it('refuses a format outside the CDM pattern, and an empty one', () => {
    expect(insertField(at('body'), 'date', { format: '<b>', date: LONDON_DATE, writable })).toEqual(
      {
        ok: false,
        reason: 'bad-format',
      },
    );
    expect(insertField(at('header'), 'page', { format: '', writable })).toEqual({
      ok: false,
      reason: 'bad-format',
    });
  });

  it('refuses a position the guard protects, and changes nothing', () => {
    const { result, dispatched } = dispatching(at('header'), (dispatch) =>
      insertField(at('header'), 'page', { writable: () => false }, dispatch),
    );
    expect(result).toEqual({ ok: false, reason: 'read-only' });
    expect(dispatched).toBe(false);
  });

  it('refuses an unknown kind and a field in the wrong place, for every kind and place (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...INSERTABLE_FIELD_KINDS),
        fc.constantFrom<Place>('header', 'body', 'region'),
        (kind: InsertableFieldKind, place) => {
          const result = insertField(at(place), kind, { writable, date: LONDON_DATE, title: 'T' });
          const storyOnly = kind === 'page' || kind === 'pageCount';
          const expected = storyOnly ? place === 'header' : place !== 'header';
          expect(result.ok, `${kind} in ${place}`).toBe(expected);
        },
      ),
      { numRuns: 60 },
    );
    expect(insertField(at('body'), 'seq', { writable })).toEqual({ ok: false, reason: 'bad-kind' });
  });
});

describe('a table of contents goes after the caret block (FE-136 criterion 3, the insertion)', () => {
  it('inserts a toc atom after the caret paragraph in the body, with its level limits', () => {
    const { result, next } = dispatching(at('body'), (dispatch) =>
      insertToc(
        at('body'),
        'tocLayout00000001',
        { minLevel: 2, maxLevel: 4, of: 'headings' },
        { writable },
        dispatch,
      ),
    );
    expect(result).toEqual({ ok: true });
    const [toc] = tocs(next.doc);
    expect(toc!.attrs).toMatchObject({
      id: 'tocLayout00000001',
      minLevel: 2,
      maxLevel: 4,
      of: 'headings',
    });
    // The toc sits right after the paragraph the caret was in.
    const body = next.doc.child(next.doc.childCount - 1);
    let index = -1;
    body.forEach((child, _offset, i) => {
      if (child.type.name === 'toc') index = i;
    });
    expect(body.child(index - 1).attrs['id']).toBe(LAYOUT_IDS.pB);
    next.doc.check();
  });

  it('accepts a list of figures through a caption sequence name', () => {
    const { result } = dispatching(at('body'), (dispatch) =>
      insertToc(at('body'), 'tocLayout00000002', { of: 'Figure' }, { writable }, dispatch),
    );
    expect(result).toEqual({ ok: true });
  });

  it('puts a toc inside a region when the caret is in one', () => {
    const { next } = dispatching(at('region'), (dispatch) =>
      insertToc(at('region'), 'tocLayout00000003', {}, { writable }, dispatch),
    );
    const region = posOfNode(next.doc, LAYOUT_IDS.region);
    const node = next.doc.nodeAt(region)!;
    expect(node.lastChild!.type.name).toBe('toc');
  });

  it('refuses levels out of 1 to 9, a minimum above the maximum, a bad sequence name, and a header', () => {
    const base = { writable };
    expect(insertToc(at('body'), 'tocLayout00000004', { minLevel: 0 }, base)).toEqual({
      ok: false,
      reason: 'bad-levels',
    });
    expect(insertToc(at('body'), 'tocLayout00000004', { maxLevel: 10 }, base)).toEqual({
      ok: false,
      reason: 'bad-levels',
    });
    expect(insertToc(at('body'), 'tocLayout00000004', { minLevel: 4, maxLevel: 2 }, base)).toEqual({
      ok: false,
      reason: 'bad-levels',
    });
    expect(insertToc(at('body'), 'tocLayout00000004', { of: '1Figure' }, base)).toEqual({
      ok: false,
      reason: 'bad-of',
    });
    expect(insertToc(at('header'), 'tocLayout00000004', {}, base)).toEqual({
      ok: false,
      reason: 'not-in-body',
    });
  });

  it('keeps the level rules for every pair of levels (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (minLevel, maxLevel) => {
          const result = insertToc(
            at('body'),
            'tocLayout00000005',
            { minLevel, maxLevel },
            { writable },
          );
          const valid = minLevel >= 1 && maxLevel <= 9 && minLevel <= maxLevel;
          expect(result.ok).toBe(valid);
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe('a symbol is inserted as text (FE-136 criterion 4, the insertion)', () => {
  it('inserts one character, including one outside the Basic Latin block', () => {
    for (const ch of ['§', 'é', '€', '😀']) {
      const { result, next } = dispatching(at('body'), (dispatch) =>
        insertSymbol(at('body'), ch, { writable }, dispatch),
      );
      expect(result, ch).toEqual({ ok: true });
      expect(next.doc.textContent).toContain(ch);
    }
  });

  it('refuses a string of several characters, an empty one, and a control character', () => {
    for (const ch of ['ab', '', '\n', '\u0007', '\u009b']) {
      expect(isSymbolCharacter(ch), JSON.stringify(ch)).toBe(false);
      expect(insertSymbol(at('body'), ch, { writable })).toEqual({
        ok: false,
        reason: 'bad-symbol',
      });
    }
  });

  it('accepts exactly one code point (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 4 }), (text) => {
        const one = Array.from(text).length === 1;
        // Not a control character: outside C0 (0x00 to 0x1f), DEL and C1 (0x7f to 0x9f).
        const code = text.codePointAt(0) ?? -1;
        const printable = code > 0x1f && (code < 0x7f || code > 0x9f);
        expect(isSymbolCharacter(text)).toBe(one && printable);
      }),
      { numRuns: 200 },
    );
  });
});
