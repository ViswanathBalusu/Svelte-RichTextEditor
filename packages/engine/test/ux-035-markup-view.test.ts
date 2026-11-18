/**
 * The markup view of suggestions (UX-035; 13 §5). The core holds the view the reader chose, `all`
 * until it is set; choosing one is a setting of this reader that changes no content and applies no
 * transaction. Each view reads the suggestion marks as the story says: `none` is the text as if every
 * suggestion were accepted, `original` as if every one were rejected, `simple` the accepted text
 * with a cue where changes exist, and `all` every change with its author. Block marks follow the
 * same rules as runs (criterion 3). The words for assistive technology (criterion 4) are written
 * on each decoration when the shell sets them. The drawing is checked in browsers by
 * packages/element/e2e/ux-035-markup-views.spec.ts.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { microtask, posOf } from './support.ts';

/** A core whose intro paragraph has an `ins` run, a `del` run and a block `del` on another block. */
function markedCore() {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(c);
  const { schema } = i;
  const intro = posOf(i.state.doc, SPIKE_IDS.intro);
  const introNode = i.state.doc.nodeAt(intro) as PMNode;
  if (introNode.textContent.length < 2) throw new Error('intro paragraph too short');
  const start = intro + 1;
  const last = posOf(i.state.doc, SPIKE_IDS.last);
  const tr = i.state.tr
    .addMark(start, start + 1, schema.marks['ins']!.create({ id: 'ins-1', user: 'alice' }))
    .addMark(start + 1, start + 2, schema.marks['del']!.create({ id: 'del-1', user: 'bob' }))
    .addNodeMark(last, schema.marks['del']!.create({ id: 'del-2', user: 'carol' }));
  i.dispatch(tr);
  return { c, last };
}

const kinds = (c: DocumentCore, view: 'all' | 'simple' | 'none' | 'original') =>
  c.markupDecorations(view).map((d) => d.attrs['class']);

describe('the markup view of suggestions (UX-035)', () => {
  it('starts with all and changes when set', () => {
    const { c } = markedCore();
    expect(c.markupView.get()).toBe('all');
    let heard = 0;
    c.markupView.subscribe(() => (heard += 1));
    c.setMarkupView('original');
    expect(c.markupView.get()).toBe('original');
    c.setMarkupView('original');
    expect(heard).toBeLessThanOrEqual(1);
  });

  it('choosing a view applies no transaction: the state, the document and the revision stay', () => {
    const { c } = markedCore();
    const i = internals(c);
    const state = i.state;
    const doc = state.doc;
    const revision = c.revision.get();
    for (const view of ['simple', 'none', 'original', 'all'] as const) c.setMarkupView(view);
    expect(i.state).toBe(state);
    expect(i.state.doc).toBe(doc);
    expect(c.revision.get()).toBe(revision);
  });

  it('none is the accepted text: deletions are hidden, insertions are plain', () => {
    const { c } = markedCore();
    expect(kinds(c, 'none')).toEqual(['de-suggest-hidden', 'de-suggest-hidden']);
  });

  it('original is the rejected text: insertions are hidden, deletions are restored', () => {
    const { c } = markedCore();
    const classes = kinds(c, 'original');
    expect(classes.filter((k) => k === 'de-suggest-hidden')).toHaveLength(1);
    expect(classes.filter((k) => k === 'de-suggest-restored')).toHaveLength(2);
  });

  it('simple takes deletions out of the text, leaves a bar for each, and marks the insertion', () => {
    const { c } = markedCore();
    const classes = kinds(c, 'simple');
    expect(classes.filter((k) => k === 'de-suggest-gone')).toHaveLength(2);
    expect(classes.filter((k) => k === 'de-suggest-changed')).toHaveLength(1);
  });

  it('a block mark follows the same view as a run (criterion 3)', () => {
    const { c, last } = markedCore();
    const blockDecorations = (view: 'all' | 'simple' | 'none' | 'original') =>
      c.markupDecorations(view).filter((d) => d.block && d.from === last);
    expect(blockDecorations('all').map((d) => d.attrs['class'])).toEqual(['de-suggest-del']);
    expect(blockDecorations('simple').map((d) => d.attrs['class'])).toEqual(['de-suggest-gone']);
    expect(blockDecorations('none').map((d) => d.attrs['class'])).toEqual(['de-suggest-hidden']);
    expect(blockDecorations('original').map((d) => d.attrs['class'])).toEqual([
      'de-suggest-restored',
    ]);
  });

  it('writes the words for assistive technology on each decoration, except in none', () => {
    const { c } = markedCore();
    c.setSuggestionLabel((kind, user) => `${kind} by ${user}`);
    const labels = c.markupDecorations('all').map((d) => d.attrs['data-suggestion-label']);
    expect(labels).toEqual(expect.arrayContaining(['ins by alice', 'del by bob', 'del by carol']));
    expect(
      c.markupDecorations('none').every((d) => d.attrs['data-suggestion-label'] === undefined),
    ).toBe(true);
    c.setSuggestionLabel(null);
    expect(
      c.markupDecorations('all').every((d) => d.attrs['data-suggestion-label'] === undefined),
    ).toBe(true);
  });
});
