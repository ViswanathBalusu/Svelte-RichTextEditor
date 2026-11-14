/**
 * Spike S1's composition fix as part of the sync client (finding 1; FE-034, phase 1b): while an
 * input-method composition is open, a remote change to the block being composed waits until the
 * composition ends, and later remote changes queue behind it so their order is kept; changes
 * elsewhere apply at once. Here a probe stands in for the view's `composing` flag.
 */
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, spikeDocument } from './fixtures.ts';
import { caret, posOf, sleep, textOfNode, type } from './support.ts';

function setup(defer = true) {
  const c = new DocumentCore({
    doc: spikeDocument(),
    schedule: (run) => queueMicrotask(run),
    deferRemoteWhileComposing: defer,
  });
  const i = internals(c);
  let composing: number | null = null;
  i.setCompositionProbe(() => composing);
  // Another user's commit, made on the server's document after the commits before it, as the
  // authority orders them (04 §1).
  let server = i.sync.confirmed;
  const remote = (id: string, text: string) => {
    const tr = new Transform(server).insert(posOf(server, id) + 1, i.schema.text(text));
    server = tr.doc;
    return i.applyRemote([tr.steps[0]!], 'rebase');
  };
  return {
    c,
    i,
    remote,
    compose(id: string | null) {
      composing = id === null ? null : posOf(i.state.doc, id);
    },
  };
}

describe('remote commits during a composition (spike S1; FE-034)', () => {
  it('a remote change to the paragraph being composed waits for compositionend, then applies once', async () => {
    const { c, i, remote, compose } = setup();
    caret(c, SPIKE_IDS.after, 'end');
    compose(SPIKE_IDS.after);
    type(c, 'か'); // the composition's text, a local step
    expect(remote(SPIKE_IDS.after, '«R»')).toBe('deferred');
    expect(i.deferredRemote).toBe(1);
    expect(textOfNode(i.state.doc, SPIKE_IDS.after)).toBe('Remote target paragraph.か');
    type(c, '仮名'); // the composition goes on
    compose(null);
    i.compositionEnded();
    await sleep(5);
    expect(i.deferredRemote).toBe(0);
    expect(textOfNode(i.state.doc, SPIKE_IDS.after)).toBe('«R»Remote target paragraph.か仮名');
    expect(i.state.doc.eq(i.sync.visible)).toBe(true);
    expect(i.deferrals).toBe(1);
  });

  it('a remote change elsewhere applies at once, during the composition', () => {
    const { c, i, remote, compose } = setup();
    caret(c, SPIKE_IDS.after, 'end');
    compose(SPIKE_IDS.after);
    type(c, 'か');
    expect(remote(SPIKE_IDS.last, 'elsewhere ')).toBe('applied');
    expect(textOfNode(i.state.doc, SPIKE_IDS.last)).toBe('elsewhere Last paragraph.');
    expect(textOfNode(i.state.doc, SPIKE_IDS.after)).toBe('Remote target paragraph.か');
  });

  it('later remote changes queue behind a deferred one, so the order is kept', async () => {
    const { c, i, remote, compose } = setup();
    caret(c, SPIKE_IDS.after, 3);
    compose(SPIKE_IDS.after);
    type(c, 'k');
    expect(remote(SPIKE_IDS.after, '1')).toBe('deferred');
    expect(remote(SPIKE_IDS.last, '2')).toBe('deferred'); // elsewhere, but behind the first
    expect(textOfNode(i.state.doc, SPIKE_IDS.last)).toBe('Last paragraph.');
    compose(null);
    i.compositionEnded();
    await sleep(5);
    expect(textOfNode(i.state.doc, SPIKE_IDS.after)).toBe('1Remkote target paragraph.');
    expect(textOfNode(i.state.doc, SPIKE_IDS.last)).toBe('2Last paragraph.');
    expect(c.confirmedSeq.get()).toBe(2);
  });

  it('without the deferral the change applies at once (the setting that reproduces the S1 failure)', () => {
    const { c, i, remote, compose } = setup(false);
    caret(c, SPIKE_IDS.after, 'end');
    compose(SPIKE_IDS.after);
    type(c, 'か');
    expect(remote(SPIKE_IDS.after, '«R»')).toBe('applied');
    expect(textOfNode(i.state.doc, SPIKE_IDS.after)).toBe('«R»Remote target paragraph.か');
  });

  it('a composition still open after compositionend (a new one started) keeps the change waiting', async () => {
    const { c, i, remote, compose } = setup();
    caret(c, SPIKE_IDS.after, 'end');
    compose(SPIKE_IDS.after);
    type(c, '한');
    expect(remote(SPIKE_IDS.after, 'R')).toBe('deferred');
    i.compositionEnded(); // Korean: the next syllable's composition starts at once
    await sleep(5);
    expect(i.deferredRemote).toBe(1);
    compose(null);
    i.compositionEnded();
    await sleep(5);
    expect(i.deferredRemote).toBe(0);
    expect(textOfNode(i.state.doc, SPIKE_IDS.after)).toBe('RRemote target paragraph.한');
  });
});
