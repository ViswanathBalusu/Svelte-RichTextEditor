/**
 * Block formatting suggestions (FE-044 criterion 3; 03 §5; CDM-040), at the builder level over a plain
 * ProseMirror state on the spike document's intro paragraph. A change of paragraph style, alignment
 * or list level, made as an attribute step, is recorded as one `fmt` node mark whose `before` holds
 * the previous values. The core's dispatch, the authority's commit and the view's decorations are not
 * run here (FE-044 criteria 1, 2, 4 and 5 stay open; see the story Notes).
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { blockEntries, entry } from '../src/block-suggestion.ts';
import { DocumentCore } from '../src/headless.ts';
import { recordAsSuggestion } from '../src/suggestion-edit.ts';
import { suggestBlockFormat } from '../src/suggestion-block.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { microtask, posOf } from './support.ts';

function baseState(): EditorState {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  return EditorState.create({ doc: internals(c).state.doc });
}

/** The `fmt_before` violations (CDM-040) of the state's document, read as an envelope. */
function fmtBeforeViolations(state: EditorState) {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const env = { ...c.getContent(), doc: state.doc.toJSON() };
  return validate(env).violations.filter((v) => v.code === 'fmt_before');
}

/** The position of the intro paragraph (the node's own position, before its content). */
function introPos(doc: PMNode): number {
  return posOf(doc, SPIKE_IDS.intro);
}

const author = (user: string) => {
  let n = 0;
  return { user, nextId: () => `${user}-b${++n}` };
};

/** The `fmt` entries of the intro paragraph's `suggest` attribute, as { user, id, before }. */
function fmtMarks(state: EditorState) {
  const node = state.doc.nodeAt(introPos(state.doc))!;
  return blockEntries(node)
    .filter((e) => e.type === 'fmt')
    .map((e) => ({
      user: e.attrs.user,
      id: e.attrs.id,
      before: (e.attrs.before ?? null) as { attrs?: Record<string, unknown> } | null,
    }));
}

describe('block formatting suggestion (FE-044 criterion 3)', () => {
  it('records a style change as an fmt node mark whose before holds the previous style', () => {
    const s0 = baseState();
    const pos = introPos(s0.doc);
    const old = s0.doc.nodeAt(pos)!.attrs['style'];
    const tr = s0.tr.setNodeAttribute(pos, 'style', 'Quote');
    const out = recordAsSuggestion(s0, tr, author('alice'));
    expect(out).not.toBeNull();
    const s1 = s0.apply(out!);
    expect(s1.doc.nodeAt(pos)!.attrs['style']).toBe('Quote');
    expect(fmtMarks(s1)).toEqual([
      { user: 'alice', id: 'alice-b1', before: { attrs: { style: old } } },
    ]);
    // The text is untouched: a formatting suggestion on a block changes no run.
    expect(s1.doc.textContent).toBe(s0.doc.textContent);
  });

  it('records an alignment and a list level change, with both previous values in before', () => {
    const s0 = baseState();
    const pos = introPos(s0.doc);
    const node = s0.doc.nodeAt(pos)!;
    // The intro paragraph starts with the defaults: no alignment and no list (CDM-002, null).
    expect(node.attrs['align']).toBeNull();
    expect(node.attrs['numbering']).toBeNull();
    const tr = s0.tr.setNodeAttribute(pos, 'align', 'center');
    const out = recordAsSuggestion(s0, tr, author('alice'));
    expect(out).not.toBeNull();
    const s1 = s0.apply(out!);
    expect(s1.doc.nodeAt(pos)!.attrs['align']).toBe('center');
    expect(fmtMarks(s1)[0]?.before).toStrictEqual({ attrs: { align: null } });
    // The list level is the paragraph's `numbering` attribute (CDM-040, generated types).
    const inList = { numberingId: 'numDefault000001', listId: 'listIntro0000001', level: 0 };
    const listTr = s1.tr.setNodeAttribute(pos, 'numbering', inList);
    const listOut = recordAsSuggestion(s1, listTr, author('alice'));
    expect(listOut).not.toBeNull();
    const s2 = s1.apply(listOut!);
    expect(s2.doc.nodeAt(pos)!.attrs['numbering']).toStrictEqual(inList);
    // One mark per user: the second change extends the first one's before.
    expect(fmtMarks(s2)).toHaveLength(1);
    const before2 = fmtMarks(s2)[0]!.before!;
    expect(Object.keys(before2.attrs!).sort()).toStrictEqual(['align', 'numbering']);
    expect(before2).toStrictEqual({ attrs: { align: null, numbering: null } });
    // A level change by another user records the defined previous numbering, level 0.
    const deeper = { ...inList, level: 1 };
    const levelTr = s2.tr.setNodeAttribute(pos, 'numbering', deeper);
    const levelOut = recordAsSuggestion(s2, levelTr, author('bob'));
    expect(levelOut).not.toBeNull();
    const s3 = s2.apply(levelOut!);
    expect(s3.doc.nodeAt(pos)!.attrs['numbering']).toStrictEqual(deeper);
    const bob = fmtMarks(s3).find((m) => m.user === 'bob');
    expect(bob?.before).toStrictEqual({ attrs: { numbering: inList } });
    // The validator accepts both marks' before (CDM-040 names style, align and numbering).
    expect(fmtBeforeViolations(s3)).toStrictEqual([]);
  });

  it('refuses a `list` attribute, which the paragraph does not have', () => {
    const s0 = baseState();
    const pos = introPos(s0.doc);
    const listTr = s0.tr.setNodeAttribute(pos, 'list', { listId: 'L1', level: 1 });
    expect(recordAsSuggestion(s0, listTr, author('alice'))).toBeNull();
    // A before naming `list` is what the validator rejects, so the check above is not vacuous.
    const bad = entry('fmt', 'x-b1', 'alice', { attrs: { list: null } });
    const s1 = s0.apply(s0.tr.setNodeAttribute(pos, 'suggest', [bad]));
    expect(fmtBeforeViolations(s1)).toHaveLength(1);
  });

  it('keeps the original before across several changes by one user, and keeps two users apart', () => {
    const s0 = baseState();
    const pos = introPos(s0.doc);
    const old = s0.doc.nodeAt(pos)!.attrs['style'];
    const step = (s: EditorState, value: string, user: string) =>
      s.apply(recordAsSuggestion(s, s.tr.setNodeAttribute(pos, 'style', value), author(user))!);
    const s1 = step(step(s0, 'Quote', 'alice'), 'Title', 'alice');
    expect(fmtMarks(s1)).toEqual([
      { user: 'alice', id: 'alice-b1', before: { attrs: { style: old } } },
    ]);
    const s2 = step(s1, 'Heading1', 'bob');
    const marks = fmtMarks(s2);
    expect(marks.map((m) => m.user).sort()).toEqual(['alice', 'bob']);
    expect(marks.find((m) => m.user === 'bob')?.before).toEqual({ attrs: { style: 'Title' } });
  });

  it('refuses an attribute that is not a style, alignment or list level, and the identifier', () => {
    const s0 = baseState();
    const pos = introPos(s0.doc);
    const idTr = s0.tr.setNodeAttribute(pos, 'id', 'x');
    expect(recordAsSuggestion(s0, idTr, author('alice'))).toBeNull();
    expect(suggestBlockFormat(s0, [idTr.steps[0] as never], author('alice'))).toBeNull();
  });

  it('records nothing for a change to the value the paragraph already has', () => {
    const s0 = baseState();
    const pos = introPos(s0.doc);
    const same = s0.doc.nodeAt(pos)!.attrs['style'];
    const tr = s0.tr.setNodeAttribute(pos, 'style', same);
    const out = recordAsSuggestion(s0, tr, author('alice'));
    expect(out).not.toBeNull();
    const s1 = s0.apply(out!);
    expect(fmtMarks(s1)).toEqual([]);
    expect(s1.doc.eq(s0.doc)).toBe(true);
  });

  it('property: one user gets one fmt mark, its before is the style before any change, and the style is the last one', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('Quote', 'Title', 'Heading1', 'Body'), {
          minLength: 1,
          maxLength: 8,
        }),
        (values) => {
          const s0 = baseState();
          const pos = introPos(s0.doc);
          const original = s0.doc.nodeAt(pos)!.attrs['style'];
          let state = s0;
          let changed = false;
          for (const v of values) {
            if (state.doc.nodeAt(pos)!.attrs['style'] !== v) changed = true;
            const out = recordAsSuggestion(
              state,
              state.tr.setNodeAttribute(pos, 'style', v),
              author('alice'),
            );
            expect(out).not.toBeNull();
            state = state.apply(out!);
          }
          expect(state.doc.nodeAt(pos)!.attrs['style']).toBe(values[values.length - 1]);
          const marks = fmtMarks(state);
          if (!changed) {
            expect(marks).toEqual([]);
          } else {
            expect(marks).toHaveLength(1);
            expect(marks[0]!.before).toEqual({ attrs: { style: original } });
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
