/**
 * The core holds the client's thread ranges and maps them through every change (FE-048 criteria 1
 * and 5; lane V-FE-033-048). Node.js, headless core. The browser part (the span over the text, and
 * its removal when the text goes) is in src/view/fe-048-comment-decorations.universal.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { commentDecorations } from '../src/comment-decorations.ts';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { posOf } from './support.ts';

const microtask = (run: () => void) => queueMicrotask(run);

function setup(): { core: DocumentCore; from: number; to: number } {
  const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(core);
  const from = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
  const to = from + 4;
  return { core, from, to };
}

describe('the core maps thread ranges through every change (FE-048)', () => {
  it('starts with no range, and a set range is held and drawn', () => {
    const { core, from, to } = setup();
    expect(core.threadRanges.get()).toEqual([]);
    core.setThreadRange('thread-a', { from, to }, 5);
    expect(core.threadRanges.get()).toEqual([
      { id: 'thread-a', from, to, detached: false, seq: 5 },
    ]);
    const drawn = commentDecorations(internals(core).state.doc, core.threadRanges.get()).find();
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.from).toBe(from);
    expect(drawn[0]!.to).toBe(to);
  });

  it('moves a range with an insertion before it, through the core dispatch', () => {
    const { core, from, to } = setup();
    core.setThreadRange('thread-a', { from, to }, 1);
    const i = internals(core);
    i.dispatch(i.state.tr.insertText('Big ', from));
    const [r] = core.threadRanges.get();
    expect(r).toMatchObject({ id: 'thread-a', from: from + 4, to: to + 4, detached: false });
  });

  it('collapses a range when its text is deleted: detached, and no decoration is drawn', () => {
    const { core, from, to } = setup();
    core.setThreadRange('thread-a', { from, to }, 1);
    const i = internals(core);
    i.dispatch(i.state.tr.delete(from, to));
    const [r] = core.threadRanges.get();
    expect(r?.detached).toBe(true);
    const drawn = commentDecorations(i.state.doc, core.threadRanges.get()).find();
    expect(drawn).toHaveLength(0);
  });

  it('removes a thread range when the thread is removed', () => {
    const { core, from, to } = setup();
    core.setThreadRange('thread-a', { from, to }, 1);
    core.removeThreadRange('thread-a');
    expect(core.threadRanges.get()).toEqual([]);
  });

  it('draws nothing for a range outside the document or with no width', () => {
    const { core } = setup();
    const doc = internals(core).state.doc;
    const size = doc.content.size;
    const drawn = commentDecorations(doc, [
      { id: 'empty', from: 3, to: 3, detached: false },
      { id: 'detached', from: 3, to: 6, detached: true },
    ]).find();
    expect(drawn).toHaveLength(0);
    const clamped = commentDecorations(doc, [
      { id: 'far', from: size + 10, to: size + 20, detached: false },
    ]).find();
    expect(clamped).toHaveLength(0);
  });
});
