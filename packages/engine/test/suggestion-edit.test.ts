/**
 * Recording edits as suggestions (FE-042 criteria 1 to 5 at the builder level, criterion 7 as a local
 * property; FE-043 criteria 1 to 3 at the builder level). Builders over a plain ProseMirror state on
 * the spike document's intro paragraph. The core's typing path, paste and composition (FE-042
 * criterion 6) and the authority's check of each commit (FE-042 criterion 7, FE-043 criterion 4) are
 * not run here.
 */
import fc from 'fast-check';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { resolveSuggestions } from '../src/suggestion-resolve.ts';
import {
  suggestDelete,
  suggestFormat,
  suggestInsert,
  suggestReplace,
} from '../src/suggestion-edit.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { microtask, posOf } from './support.ts';

const TEXT = 'Alpha bravo charlie';

function baseState(): EditorState {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  return EditorState.create({ doc: internals(c).state.doc });
}

/** The absolute position of the first character of the intro paragraph. */
function start(state: EditorState): number {
  return posOf(state.doc, SPIKE_IDS.intro) + 1;
}

/** The text runs in `[from, to)` with their marks as `type(user)` names, in order. */
function runs(doc: PMNode, from: number, to: number): { text: string; marks: string[] }[] {
  const out: { text: string; marks: string[] }[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.isText)
      out.push({
        text: node.text ?? '',
        marks: node.marks.map((m: Mark) => {
          const who = m.attrs['user'];
          return who === undefined ? m.type.name : `${m.type.name}(${String(who)})`;
        }),
      });
    return !node.isText;
  });
  return out;
}

/** The intro paragraph's leading text (up to its footnote), as it now reads. */
function introText(doc: PMNode, state: EditorState): string {
  const block = doc.nodeAt(posOf(doc, SPIKE_IDS.intro))!;
  let length = 0;
  for (let i = 0; i < block.childCount; i++) {
    const child = block.child(i);
    if (!child.isText) break;
    length += child.nodeSize;
  }
  return runs(doc, start(state), start(state) + length)
    .map((r) => r.text)
    .join('');
}

function author(user: string, ids: string[]) {
  let n = 0;
  return { user, nextId: () => `${user}-${ids[n++] ?? `s${n}`}` };
}

describe('insertion (FE-042 criterion 1)', () => {
  it('records typed text as ins with the user and a suggestion identifier of the user', () => {
    const s0 = baseState();
    const at = start(s0) + 6;
    const tr = suggestInsert(s0, at, 'XY', author('u2', ['a']));
    const s1 = s0.apply(tr);
    const inserted = runs(s1.doc, at, at + 2);
    expect(inserted).toEqual([{ text: 'XY', marks: ['ins(u2)'] }]);
    const id = s1.doc.nodeAt(at)!.marks[0]!.attrs['id'];
    expect(id).toBe('u2-a');
    expect(introText(s1.doc, s1)).toBe(TEXT.slice(0, 6) + 'XY' + TEXT.slice(6));
  });
});

describe('deletion (FE-042 criteria 2 and 3)', () => {
  it('keeps baseline text when it is deleted and gives it a del mark', () => {
    const s0 = baseState();
    const from = start(s0);
    const s1 = s0.apply(suggestDelete(s0, from, from + 5, author('u2', ['d'])).tr);
    expect(introText(s1.doc, s1)).toBe(TEXT);
    expect(runs(s1.doc, from, from + 5)).toEqual([{ text: 'Alpha', marks: ['del(u2)'] }]);
  });

  it('gives another user’s inserted text a del of the deleting user and keeps that user’s ins', () => {
    const s0 = baseState();
    const from = start(s0);
    const withIns = s0.apply(
      s0.tr.addMark(from, from + 5, s0.schema.marks['ins']!.create({ id: 'u1-x', user: 'u1' })),
    );
    const s1 = withIns.apply(suggestDelete(withIns, from, from + 5, author('u2', ['d'])).tr);
    expect(introText(s1.doc, s1)).toBe(TEXT);
    expect(runs(s1.doc, from, from + 5)).toEqual([
      { text: 'Alpha', marks: ['ins(u1)', 'del(u2)'] },
    ]);
  });

  it('removes text the user inserted themselves, as P4 allows, and leaves other text', () => {
    const s0 = baseState();
    const from = start(s0);
    const withOwn = s0.apply(
      s0.tr.addMark(from, from + 5, s0.schema.marks['ins']!.create({ id: 'u2-x', user: 'u2' })),
    );
    const s1 = withOwn.apply(suggestDelete(withOwn, from, from + 5, author('u2', ['d'])).tr);
    expect(introText(s1.doc, s1)).toBe(TEXT.slice(5));
  });
});

describe('two users on the same text (FE-042 criterion 4)', () => {
  it('keeps both del marks, because suggestion marks do not exclude one another', () => {
    const s0 = baseState();
    const from = start(s0);
    const s1 = s0.apply(suggestDelete(s0, from, from + 5, author('u1', ['a'])).tr);
    const s2 = s1.apply(suggestDelete(s1, from, from + 5, author('u2', ['b'])).tr);
    expect(runs(s2.doc, from, from + 5)).toEqual([
      { text: 'Alpha', marks: ['del(u1)', 'del(u2)'] },
    ]);
  });
});

describe('typing over a selection (FE-042 criterion 5)', () => {
  it('gives the selected text del and the new text ins, the new text after it', () => {
    const s0 = baseState();
    const from = start(s0);
    const s1 = s0.apply(suggestReplace(s0, from, from + 5, 'Zulu', author('u2', ['r'])));
    expect(introText(s1.doc, s1)).toBe('Alpha' + 'Zulu' + TEXT.slice(5));
    expect(runs(s1.doc, from, from + 5)).toEqual([{ text: 'Alpha', marks: ['del(u2)'] }]);
    expect(runs(s1.doc, from + 5, from + 9)).toEqual([{ text: 'Zulu', marks: ['ins(u2)'] }]);
  });
});

describe('local property: a user’s suggestions leave the baseline and other users’ marks alone (FE-042 criterion 7, local part)', () => {
  it('keeps the text and every mark that another user placed, over random deletions and insertions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(TEXT.length), fc.nat(TEXT.length), fc.boolean()), {
          minLength: 1,
          maxLength: 8,
        }),
        (ops) => {
          let state = baseState();
          const from = start(state);
          const other = state.schema.marks['ins']!.create({ id: 'u1-base', user: 'u1' });
          state = state.apply(state.tr.addMark(from + 2, from + 4, other));
          const before = runs(state.doc, from, from + TEXT.length);
          for (const [a, b, insert] of ops) {
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            if (insert) {
              state = state.apply(suggestInsert(state, from + lo, 'Q', author('u2', ['i'])));
            } else {
              state = state.apply(
                suggestDelete(state, from + lo, from + hi, author('u2', ['d'])).tr,
              );
            }
          }
          // The baseline text is still there: no deletion removed it, only insertions added to it.
          const kept = introText(state.doc, state);
          expect(kept.replace(/Q/g, '')).toBe(TEXT);
          // Every mark u1 placed is still on the same text.
          const u1 = runs(state.doc, from, from + TEXT.length).filter((r) =>
            r.marks.includes('ins(u1)'),
          );
          expect(u1.map((r) => r.text).join('')).toBe(
            before
              .filter((r) => r.marks.includes('ins(u1)'))
              .map((r) => r.text)
              .join(''),
          );
        },
      ),
    );
  });
});

describe('formatting suggestions (FE-043 criteria 1 to 3)', () => {
  it('applies the new mark and records the previous marks in fmt with id and user (criterion 1)', () => {
    const s0 = baseState();
    const from = start(s0);
    const bold = s0.schema.marks['bold']!;
    const s1 = s0.apply(suggestFormat(s0, from, from + 5, bold.create(), author('u2', ['f'])).tr);
    const first = s1.doc.nodeAt(from)!;
    expect(first.marks.map((m) => m.type.name).sort()).toEqual(['fmt', 'bold'].sort());
    const fmt = first.marks.find((m) => m.type.name === 'fmt')!;
    expect(fmt.attrs['user']).toBe('u2');
    expect(fmt.attrs['id']).toBe('u2-f');
    expect(fmt.attrs['before']).toEqual({ marks: [], attrs: {} });
  });

  it('keeps both fmt marks when two users format the same text (criterion 2)', () => {
    const s0 = baseState();
    const from = start(s0);
    const bold = s0.schema.marks['bold']!;
    const s1 = s0.apply(suggestFormat(s0, from, from + 5, bold.create(), author('u1', ['a'])).tr);
    const s2 = s1.apply(
      suggestFormat(s1, from, from + 5, s1.schema.marks['italic']!.create(), author('u2', ['b']))
        .tr,
    );
    const fmts = s2.doc.nodeAt(from)!.marks.filter((m) => m.type.name === 'fmt');
    expect(fmts.map((m) => m.attrs['user']).sort()).toEqual(['u1', 'u2']);
  });

  it('gives a second user the first user’s before, so the baseline does not depend on order (PRM-013)', () => {
    const s0 = baseState();
    const from = start(s0);
    const s1 = s0.apply(
      suggestFormat(s0, from, from + 5, s0.schema.marks['bold']!.create(), author('u1', ['a'])).tr,
    );
    const s2 = s1.apply(
      suggestFormat(s1, from, from + 5, s1.schema.marks['italic']!.create(), author('u2', ['b']))
        .tr,
    );
    const fmts = s2.doc.nodeAt(from)!.marks.filter((m) => m.type.name === 'fmt');
    expect(fmts).toHaveLength(2);
    // Both record the formatting before the first suggestion, not the first user's bold.
    for (const m of fmts) expect(m.attrs['before']).toEqual({ marks: [], attrs: {} });
  });

  it('rejecting a formatting suggestion puts back exactly the previous marks (criterion 3)', () => {
    const s0 = baseState();
    const from = start(s0);
    const bold = s0.schema.marks['bold']!;
    const before = runs(s0.doc, from, from + 5)[0]!.marks;
    const s1 = s0.apply(suggestFormat(s0, from, from + 5, bold.create(), author('u2', ['f'])).tr);
    const r = resolveSuggestions(s1, 'reject', { from, to: from + 5 });
    const s2 = s1.apply(r.tr);
    expect(runs(s2.doc, from, from + 5)[0]!.marks).toEqual(before);
    expect(s2.doc.nodeAt(from)!.marks.some((m) => m.type.name === 'fmt')).toBe(false);
    expect(introText(s2.doc, s2)).toBe(TEXT);
  });
});
