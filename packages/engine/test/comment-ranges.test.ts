/**
 * Comment ranges on the client (FE-048 criteria 2 and 5, the mapping part): a range stays on the
 * text it was drawn on when steps are applied before it, and collapses (detached) when its text is
 * deleted. The steps are real transactions of the headless core; the decoration is not tested here.
 */
import { describe, expect, it } from 'vitest';
import { CommentRanges } from '../src/comment-ranges.ts';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { posOf } from './support.ts';

const microtask = (run: () => void) => queueMicrotask(run);

/** A core on the spike document and the range of the first four characters of the intro. */
function setup(): { core: DocumentCore; from: number; to: number } {
  const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(core);
  const from = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
  const to = from + 4;
  expect(i.state.doc.textBetween(from, to)).toHaveLength(4);
  return { core, from, to };
}

describe('a comment range follows its text (FE-048 criterion 2)', () => {
  it('moves with an insertion before it and still covers the same text', () => {
    const { core, from, to } = setup();
    const i = internals(core);
    const covered = i.state.doc.textBetween(from, to);
    const comments = new CommentRanges();
    comments.set('thread-1', { from, to }, 7);

    const tr = i.state.tr.insertText('Big ', from);
    comments.apply(tr.mapping.maps, 8);
    i.dispatch(tr);

    const after = comments.get('thread-1')!;
    expect(after.detached).toBe(false);
    expect(after.seq).toBe(8);
    expect(after.from).toBe(from + 4);
    expect(after.to).toBe(to + 4);
    expect(internals(core).state.doc.textBetween(after.from, after.to)).toBe(covered);
  });

  it('keeps the range when text is inserted inside it', () => {
    const { core, from, to } = setup();
    const i = internals(core);
    const comments = new CommentRanges();
    comments.set('thread-1', { from, to }, 1);

    const tr = i.state.tr.insertText('x', from + 2);
    comments.apply(tr.mapping.maps, 2);
    i.dispatch(tr);

    const after = comments.get('thread-1')!;
    expect(after.detached).toBe(false);
    expect(after.to - after.from).toBe(5);
  });
});

describe('deleting the commented text detaches the thread (FE-048 criterion 5, the mapping part)', () => {
  it('collapses the range and reports the thread detached, and stays detached', () => {
    const { core, from, to } = setup();
    const i = internals(core);
    const comments = new CommentRanges();
    comments.set('thread-1', { from, to }, 3);

    const tr = i.state.tr.delete(from, to);
    comments.apply(tr.mapping.maps, 4);
    i.dispatch(tr);

    const after = comments.get('thread-1')!;
    expect(after.detached).toBe(true);
    expect(after.from).toBe(after.to);
    expect(after.seq).toBe(4);

    // Text typed where the range collapsed does not bring the thread back.
    const later = internals(core).state.tr.insertText('new', after.from);
    comments.apply(later.mapping.maps, 5);
    internals(core).dispatch(later);
    expect(comments.get('thread-1')!.detached).toBe(true);
  });

  it('leaves other threads untouched when one thread is detached', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const i = internals(core);
    const base = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    const comments = new CommentRanges();
    comments.set('gone', { from: base, to: base + 3 }, 1);
    comments.set('kept', { from: base + 4, to: base + 6 }, 1);
    const kept = i.state.doc.textBetween(base + 4, base + 6);

    const tr = i.state.tr.delete(base, base + 3);
    comments.apply(tr.mapping.maps, 2);
    i.dispatch(tr);

    expect(comments.get('gone')!.detached).toBe(true);
    const keptNow = comments.get('kept')!;
    expect(keptNow.detached).toBe(false);
    expect(internals(core).state.doc.textBetween(keptNow.from, keptNow.to)).toBe(kept);
  });

  it('replaces a copy with the range of a thread.updated event', () => {
    const comments = new CommentRanges();
    comments.set('t', { from: 2, to: 5 }, 1);
    comments.set('t', { from: 9, to: 12 }, 6);
    expect(comments.get('t')).toEqual({ from: 9, to: 12, detached: false, seq: 6 });
    comments.remove('t');
    expect(comments.get('t')).toBeUndefined();
  });
});
