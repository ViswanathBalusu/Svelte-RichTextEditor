/**
 * Accepting and rejecting block-level suggestions (FE-047 criterion 4, at the builder level; 03 §5;
 * CDM-040). Plain ProseMirror states over the spike document's intro paragraph: block `ins`, `del`
 * and `fmt` node marks are put on it directly or through the block formatting recorder, then
 * `resolveSuggestions` decides them. The authority's check of the commit and the core's dispatch are
 * not run here.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { addBlockEntry, entry, hasKind } from '../src/block-suggestion.ts';
import { DocumentCore } from '../src/headless.ts';
import { resolveSuggestions } from '../src/suggestion-resolve.ts';
import { recordAsSuggestion } from '../src/suggestion-edit.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { microtask, posOf } from './support.ts';

function baseState(): EditorState {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  return EditorState.create({ doc: internals(c).state.doc });
}

const introPos = (doc: PMNode): number => posOf(doc, SPIKE_IDS.intro);
const everything = (doc: PMNode) => ({ from: 0, to: doc.content.size });

/** Puts a block `ins`, `del` or `fmt` node mark on the intro paragraph, as the recorder would. */
function markIntro(state: EditorState, type: 'ins' | 'del', user: string, id: string): EditorState {
  const pos = introPos(state.doc);
  return state.apply(addBlockEntry(state.tr, pos, entry(type, id, user)));
}

/** The intro paragraph by its identifier, or null once it has been removed. */
function introNode(state: EditorState): PMNode | null {
  let found: PMNode | null = null;
  state.doc.descendants((node) => {
    if (node.attrs['id'] === SPIKE_IDS.intro) found = node;
    return found === null;
  });
  return found;
}

const author = (user: string) => ({ user, nextId: () => `${user}-x` });

describe('block suggestions on resolve (FE-047 criterion 4)', () => {
  it('rejecting a block ins removes the block; accepting it keeps the block and drops the mark', () => {
    const s0 = markIntro(baseState(), 'ins', 'alice', 'alice-1');
    const rejected = resolveSuggestions(s0, 'reject', everything(s0.doc));
    const s1 = s0.apply(rejected.tr);
    expect(introNode(s1)).toBeNull();
    expect(rejected.handled).toBe(1);

    const accepted = resolveSuggestions(s0, 'accept', everything(s0.doc));
    const s2 = s0.apply(accepted.tr);
    expect(introNode(s2)).not.toBeNull();
    expect(hasKind(introNode(s2)!, 'ins')).toBe(false);
    expect(s2.doc.textContent).toBe(s0.doc.textContent);
  });

  it('accepting a block del removes the block; rejecting it drops the mark and keeps the block', () => {
    const s0 = markIntro(baseState(), 'del', 'alice', 'alice-1');
    expect(introNode(s0.apply(resolveSuggestions(s0, 'accept', everything(s0.doc)).tr))).toBeNull();
    const kept = s0.apply(resolveSuggestions(s0, 'reject', everything(s0.doc)).tr);
    expect(introNode(kept)).not.toBeNull();
    expect(hasKind(introNode(kept)!, 'del')).toBe(false);
  });

  it('rejecting a block fmt restores the recorded style; accepting it keeps the new style', () => {
    const s0 = baseState();
    const pos = introPos(s0.doc);
    const original = s0.doc.nodeAt(pos)!.attrs['style'];
    const recorded = recordAsSuggestion(
      s0,
      s0.tr.setNodeAttribute(pos, 'style', 'Quote'),
      author('alice'),
    );
    const s1 = s0.apply(recorded!);
    expect(introNode(s1)!.attrs['style']).toBe('Quote');

    const rejected = s1.apply(resolveSuggestions(s1, 'reject', everything(s1.doc)).tr);
    expect(introNode(rejected)!.attrs['style']).toBe(original);
    expect(hasKind(introNode(rejected)!, 'fmt')).toBe(false);

    const accepted = s1.apply(resolveSuggestions(s1, 'accept', everything(s1.doc)).tr);
    expect(introNode(accepted)!.attrs['style']).toBe('Quote');
    expect(hasKind(introNode(accepted)!, 'fmt')).toBe(false);
  });

  it('a removed block takes its inner text suggestions with it and counts them once', () => {
    let s0 = markIntro(baseState(), 'ins', 'alice', 'alice-1');
    // A text insertion by alice inside the block, next to the block's own mark.
    const pos = introPos(s0.doc) + 1;
    s0 = s0.apply(
      s0.tr.insert(
        pos,
        s0.schema.text('zz', [s0.schema.marks['ins']!.create({ id: 'alice-2', user: 'alice' })]),
      ),
    );
    const res = resolveSuggestions(s0, 'reject', everything(s0.doc));
    const after = s0.apply(res.tr);
    expect(introNode(after)).toBeNull();
    expect(res.handled).toBe(2);
    expect(res.skipped).toBe(0);
  });

  it('a block the user may not edit is skipped and counted, and nothing changes', () => {
    const s0 = markIntro(baseState(), 'ins', 'alice', 'alice-1');
    const res = resolveSuggestions(s0, 'reject', { ...everything(s0.doc), editable: () => false });
    expect(res.skipped).toBe(1);
    expect(res.handled).toBe(0);
    expect(s0.apply(res.tr).doc.eq(s0.doc)).toBe(true);
  });

  it("an author filter leaves another author's block suggestion alone", () => {
    const s0 = markIntro(baseState(), 'ins', 'bob', 'bob-1');
    const res = resolveSuggestions(s0, 'reject', { ...everything(s0.doc), author: 'alice' });
    expect(res.handled).toBe(0);
    expect(s0.apply(res.tr).doc.eq(s0.doc)).toBe(true);
  });

  it('property: rejecting a series of one user style changes restores the style before them; accepting keeps the last', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('Quote', 'Title', 'Heading1', 'Body'), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.boolean(),
        (values, reject) => {
          const s0 = baseState();
          const pos = introPos(s0.doc);
          const original = s0.doc.nodeAt(pos)!.attrs['style'];
          let state = s0;
          for (const v of values) {
            const out = recordAsSuggestion(
              state,
              state.tr.setNodeAttribute(pos, 'style', v),
              author('alice'),
            );
            state = state.apply(out!);
          }
          const res = resolveSuggestions(
            state,
            reject ? 'reject' : 'accept',
            everything(state.doc),
          );
          const done = state.apply(res.tr);
          const expected = reject ? original : values[values.length - 1];
          expect(introNode(done)!.attrs['style']).toBe(expected);
          expect(hasKind(introNode(done)!, 'fmt')).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });
});
