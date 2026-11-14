/**
 * Modes and commits at the core (UX-015 criteria 2 and 4; UX-004 criterion 4; 13 section 3; 07
 * section 7). Lane U-UX-001-015. Node.js, the real DocumentCore and its sync queue: what the user
 * types or runs in `view`, `review` and `edit` mode, and what reaches the queue of commits.
 */
import { describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, spikeDocument } from './fixtures.ts';
import { caret, microtask, posOf, textOfNode, type } from './support.ts';
import type { Access } from '@docedit/protocol';

/** The marks carried by the text `needle` in the document, as mark type names. */
function marksOf(doc: PMNode, needle: string): string[][] {
  const out: string[][] = [];
  doc.descendants((node) => {
    if (node.isText && node.text?.includes(needle)) {
      out.push(node.marks.map((m) => m.type.name));
    }
    return true;
  });
  return out;
}

/** An access where the user may only suggest in the body (no `edit`). */
function suggestOnly(): Access {
  const caps = ['view', 'comment', 'suggest'] as Access['caps'];
  return editorAccess({ caps, scopes: { doc: ['view'], body: caps, defs: ['view'] } });
}

/** Selects `from` to `to` characters into the block `id`. */
function select(core: DocumentCore, id: string, from: number, to: number): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id);
  i.dispatch(
    i.state.tr.setSelection(TextSelection.create(i.state.doc, at + 1 + from, at + 1 + to)),
  );
}

/** The queue of local commits and the one in flight, as the sync client holds them. */
function pendingCommits(core: DocumentCore): number {
  const s = internals(core).sync;
  return s.queue.length + (s.inflight ? 1 : 0);
}

describe('view mode sends nothing (UX-015 criterion 4; FE-029 criterion 2)', () => {
  it('typing and a content command change nothing locally and queue no commit', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
      mode: 'view',
    });
    const before = textOfNode(internals(c).state.doc, SPIKE_IDS.intro);
    caret(c, SPIKE_IDS.intro, 0);
    type(c, 'x');
    expect(c.run('bold')).toBe(false);
    expect(textOfNode(internals(c).state.doc, SPIKE_IDS.intro)).toBe(before);
    expect(pendingCommits(c)).toBe(0);
    expect(c.refusal.get()?.reason).toBe('read-only');
  });
});

describe('review mode turns edits into suggestions; edit mode turns them off (UX-015 criterion 2)', () => {
  it('in review mode an insertion is recorded as a suggestion mark and is committed', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
      mode: 'review',
      user: 'author-1',
    });
    expect(c.suggestion.get().on).toBe(true);
    caret(c, SPIKE_IDS.intro, 0);
    type(c, 'x');
    const marks = marksOf(internals(c).state.doc, 'x');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.flat()).toContain('ins');
    expect(pendingCommits(c)).toBeGreaterThan(0);
  });

  it('after a change to edit mode, an insertion is a plain change with no suggestion mark', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
      mode: 'review',
      user: 'author-1',
    });
    c.setMode('edit');
    expect(c.suggestion.get().on).toBe(false);
    caret(c, SPIKE_IDS.intro, 0);
    type(c, 'y');
    const marks = marksOf(internals(c).state.doc, 'y');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.flat()).not.toContain('ins');
  });
});

describe('suggest without edit: a formatting command is a suggestion (UX-004 criterion 4)', () => {
  it('bold on a selection is enabled and recorded as a formatting suggestion', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: suggestOnly(),
      schedule: microtask,
      user: 'author-1',
    });
    expect(c.suggestion.get().on).toBe(true);
    select(c, SPIKE_IDS.intro, 0, 4);
    expect(c.run('bold')).toBe(true);
    const marks = marksOf(internals(c).state.doc, '');
    expect(marks.flat().some((m) => m.includes('fmt'))).toBe(true);
    expect(pendingCommits(c)).toBeGreaterThan(0);
  });
});
