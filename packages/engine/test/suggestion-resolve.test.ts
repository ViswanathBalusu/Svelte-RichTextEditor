/**
 * Accepting and rejecting suggestions (FE-047 criteria 1, 2, 3, 5 and 6; 02 §5.2; 03 §5). The tests
 * build suggestion marks on the spike document's intro paragraph in a plain ProseMirror state and
 * check the transaction that resolves them. Block marks (criterion 4) and the review tools
 * (UX-036, UX-037) are not covered here.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { resolveSuggestions } from '../src/suggestion-resolve.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { microtask, posOf } from './support.ts';

/** The intro paragraph's text starts one position inside the block. */
const TEXT = 'Alpha bravo charlie';

function baseState(): EditorState {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  return EditorState.create({ doc: internals(c).state.doc });
}

/** The absolute position of the first character of the intro paragraph. */
function start(state: EditorState): number {
  return posOf(state.doc, SPIKE_IDS.intro) + 1;
}

/** The text runs at the start of the intro paragraph, before its first non-text child (the footnote). */
function leadingRuns(doc: PMNode): PMNode[] {
  const block = doc.nodeAt(posOf(doc, SPIKE_IDS.intro))!;
  const runs: PMNode[] = [];
  let stopped = false;
  block.forEach((node) => {
    if (stopped) return;
    if (node.isText) runs.push(node);
    else stopped = true;
  });
  return runs;
}

function introText(doc: PMNode): string {
  return leadingRuns(doc)
    .map((n) => n.text ?? '')
    .join('');
}

/** The marks on each character of the intro paragraph's leading text, as sorted `type` lists. */
function marksOfIntro(doc: PMNode): string[][] {
  const out: string[][] = [];
  for (const node of leadingRuns(doc))
    for (let i = 0; i < (node.text ?? '').length; i++)
      out.push(node.marks.map((m: Mark) => m.type.name).sort());
  return out;
}

function mark(state: EditorState, name: string, attrs: Record<string, unknown>): Mark {
  return state.schema.marks[name]!.create(attrs);
}

/** A state with one suggestion mark added over `[from, from + length)` of the intro text. */
function withMark(state: EditorState, offset: number, length: number, m: Mark): EditorState {
  const from = start(state) + offset;
  return state.apply(state.tr.addMark(from, from + length, m));
}

function apply(
  state: EditorState,
  action: 'accept' | 'reject',
  scope: {
    from: number;
    to: number;
    author?: string;
    editable?: (f: number, t: number) => boolean;
  },
) {
  const r = resolveSuggestions(state, action, scope);
  return { ...r, state: state.apply(r.tr) };
}

const wholeIntro = (state: EditorState) => ({
  from: start(state),
  to: start(state) + TEXT.length,
});

describe('insertion marks (criterion 1)', () => {
  it('accepting an ins keeps the text and removes the mark', () => {
    const s0 = baseState();
    const s1 = withMark(s0, 0, 5, mark(s0, 'ins', { id: 'sIns00000001', user: 'u1' }));
    const r = apply(s1, 'accept', wholeIntro(s1));
    expect(introText(r.state.doc)).toBe(TEXT);
    expect(
      marksOfIntro(r.state.doc)
        .slice(0, 5)
        .every((m) => !m.includes('ins')),
    ).toBe(true);
    expect(r.handled).toBe(1);
  });

  it('rejecting an ins removes its text', () => {
    const s0 = baseState();
    const s1 = withMark(s0, 0, 6, mark(s0, 'ins', { id: 'sIns00000002', user: 'u1' }));
    const r = apply(s1, 'reject', wholeIntro(s1));
    expect(introText(r.state.doc)).toBe(TEXT.slice(6));
    expect(r.handled).toBe(1);
  });
});

describe('deletion marks (criterion 2)', () => {
  it('accepting a del removes the text', () => {
    const s0 = baseState();
    const s1 = withMark(s0, 6, 5, mark(s0, 'del', { id: 'sDel000000001', user: 'u1' }));
    const r = apply(s1, 'accept', wholeIntro(s1));
    expect(introText(r.state.doc)).toBe(TEXT.slice(0, 6) + TEXT.slice(11));
  });

  it('rejecting a del removes only the mark and keeps the text', () => {
    const s0 = baseState();
    const s1 = withMark(s0, 6, 5, mark(s0, 'del', { id: 'sDel000000002', user: 'u1' }));
    const r = apply(s1, 'reject', wholeIntro(s1));
    expect(introText(r.state.doc)).toBe(TEXT);
    expect(marksOfIntro(r.state.doc)[6]).toEqual([]);
  });
});

describe('formatting marks (criterion 3)', () => {
  it('accepting a fmt keeps the formatting and removes the mark', () => {
    const s0 = baseState();
    const bold = mark(s0, 'bold', {});
    const s1 = withMark(s0, 0, 5, bold);
    const s2 = withMark(
      s1,
      0,
      5,
      mark(s1, 'fmt', { id: 'sFmt00000001', user: 'u1', before: { marks: [] } }),
    );
    const r = apply(s2, 'accept', wholeIntro(s2));
    expect(marksOfIntro(r.state.doc)[0]).toEqual(['bold']);
  });

  it('rejecting a fmt returns the formatting to its recorded before', () => {
    const s0 = baseState();
    const s1 = withMark(s0, 0, 5, mark(s0, 'bold', {}));
    const s2 = withMark(
      s1,
      0,
      5,
      mark(s1, 'fmt', { id: 'sFmt00000002', user: 'u1', before: { marks: [] } }),
    );
    const r = apply(s2, 'reject', wholeIntro(s2));
    expect(marksOfIntro(r.state.doc)[0]).toEqual([]);
    expect(introText(r.state.doc)).toBe(TEXT);
  });

  it('rejecting a fmt restores an italic before when bold was the suggestion', () => {
    const s0 = baseState();
    const italic = mark(s0, 'italic', {});
    const s1 = withMark(s0, 0, 5, mark(s0, 'bold', {}));
    const s2 = withMark(
      s1,
      0,
      5,
      mark(s1, 'fmt', {
        id: 'sFmt00000003',
        user: 'u1',
        before: { marks: [italic.toJSON()] },
      }),
    );
    const r = apply(s2, 'reject', wholeIntro(s2));
    expect(marksOfIntro(r.state.doc)[0]).toEqual(['italic']);
  });

  // 03 §5: `before` records marks or attributes, so a null or attributes-only `before` is legal.
  // The baseline (`headOf` in the authority) then leaves the direct formatting as it is.
  it.each([
    ['null', null],
    ['attributes only', { attrs: {} }],
  ])('rejecting a fmt whose before is %s removes only the mark and keeps the bold', (_, before) => {
    const s0 = baseState();
    const s1 = withMark(s0, 0, 5, mark(s0, 'bold', {}));
    const s2 = withMark(s1, 0, 5, mark(s1, 'fmt', { id: 'sFmt00000004', user: 'u1', before }));
    const r = apply(s2, 'reject', wholeIntro(s2));
    expect(r.handled).toBe(1);
    expect(introText(r.state.doc)).toBe(TEXT);
    expect(marksOfIntro(r.state.doc).slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () => ['bold']),
    );
  });
});

describe('authors and selections (criterion 5)', () => {
  it('accepts only the chosen author, in one transaction', () => {
    const s0 = baseState();
    const s1 = withMark(s0, 0, 5, mark(s0, 'ins', { id: 'sIns00000010', user: 'u1' }));
    const s2 = withMark(s1, 6, 5, mark(s1, 'ins', { id: 'sIns00000011', user: 'u2' }));
    const r = apply(s2, 'accept', { ...wholeIntro(s2), author: 'u1' });
    expect(r.handled).toBe(1);
    const marks = marksOfIntro(r.state.doc);
    expect(marks[0]).toEqual([]);
    expect(marks[6]).toEqual(['ins']);
  });

  it('a single transaction carries every change of the range', () => {
    const s0 = baseState();
    const s1 = withMark(s0, 0, 5, mark(s0, 'ins', { id: 'sIns00000020', user: 'u1' }));
    const s2 = withMark(s1, 6, 5, mark(s1, 'del', { id: 'sDel00000020', user: 'u2' }));
    const r = resolveSuggestions(s2, 'accept', wholeIntro(s2));
    expect(r.tr.steps.length).toBeGreaterThan(1);
    expect(r.tr.docChanged).toBe(true);
    const applied = s2.apply(r.tr);
    expect(introText(applied.doc)).toBe(TEXT.slice(0, 6) + TEXT.slice(11));
    expect(marksOfIntro(applied.doc)[0]).toEqual([]);
  });

  it('a range with no suggestions makes no change', () => {
    const s0 = baseState();
    const r = resolveSuggestions(s0, 'accept', wholeIntro(s0));
    expect(r.handled).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.tr.docChanged).toBe(false);
  });
});

describe('scopes the user cannot edit (criterion 6)', () => {
  it('skips and counts a suggestion where the text is not editable', () => {
    const s0 = baseState();
    const s1 = withMark(s0, 0, 5, mark(s0, 'ins', { id: 'sIns00000030', user: 'u1' }));
    const s2 = withMark(s1, 6, 5, mark(s1, 'del', { id: 'sDel00000030', user: 'u1' }));
    const from = start(s2);
    const r = apply(s2, 'accept', {
      ...wholeIntro(s2),
      // Only the first five characters are editable; the deletion's text is not.
      editable: (f) => f < from + 5,
    });
    expect(r.skipped).toBe(1);
    expect(r.handled).toBe(1);
    expect(introText(r.state.doc)).toBe(TEXT);
    expect(marksOfIntro(r.state.doc)[6]).toEqual(['del']);
  });
});
