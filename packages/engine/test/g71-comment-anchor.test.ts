/**
 * What the shell asks the core for a comment thread (gap G71; ADR 0417; UX-028, UX-029, UX-030).
 * Node.js, headless core. The core reads: the anchor a new thread would have, where each thread lies,
 * what the user may do there, and the `thread.*` and `comment.*` notices of the channel.
 *
 * - `commentAnchor`: a text selection is a range in the positions of the confirmed document at its
 *   `seq` (so unconfirmed local steps are taken back), a selected figure is a block, and nothing
 *   selected is no anchor; the capabilities of each covered scope come with it.
 * - `threadPlacement`: the position in document order, the commented words, the block kind, and a
 *   range whose text was deleted is detached. The notices of the channel reach the thread service
 *   through `onThreadNotice`; that is tested with two real cores in packages/element/test/g71-threads-service.test.ts.
 */
import type { Access } from '@docedit/protocol';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { LAYOUT_IDS, layoutEnvelope, posOfNode } from './layout-doc.ts';
import { microtask } from './support.ts';

const caps = (...c: string[]) => [...c];
function access(body: string[]): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...body],
    scopes: { doc: [...body], body: [...body], defs: [...body] },
    leases: {},
    fill: null,
    restrictions: [],
  } as Access;
}

function setup(body = caps('view', 'comment', 'suggest', 'edit')) {
  const doc = {
    cdm: 1,
    requires: [],
    doc: layoutEnvelope() as unknown as CdmJsonNode,
  } as CdmEnvelope;
  const core = new DocumentCore({ doc, access: access(body), schedule: microtask });
  const i = internals(core);
  const a = posOfNode(i.state.doc, LAYOUT_IDS.pA) + 1;
  return { core, i, a };
}

describe('the anchor of a new thread (UX-028)', () => {
  it('is null with nothing selected', () => {
    const { core, i, a } = setup();
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, a)));
    expect(core.commentAnchor()).toBeNull();
  });

  it('is the selected range and the seq it was read at, with the capabilities of its scope', () => {
    const { core, i, a } = setup();
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, a, a + 4)));
    const anchor = core.commentAnchor();
    expect(anchor?.selection).toEqual({ kind: 'range', from: a, to: a + 4, baseSeq: 0 });
    expect(anchor?.scopes).toEqual([['view', 'comment', 'suggest', 'edit']]);
  });

  it('takes unconfirmed local steps back: the range is in the confirmed document', () => {
    const { core, i, a } = setup();
    // Typing before the words moves them right in the local document, not in the confirmed one.
    i.dispatch(i.state.tr.insertText('New ', a));
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, a + 4, a + 8)));
    expect(core.commentAnchor()?.selection).toEqual({
      kind: 'range',
      from: a,
      to: a + 4,
      baseSeq: 0,
    });
  });

  it('reports a comment-only user as able to comment and not to edit', () => {
    const { core, i, a } = setup(caps('view', 'comment'));
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, a, a + 3)));
    expect(core.commentAnchor()?.scopes).toEqual([['view', 'comment']]);
  });

  it('is the block when a figure is selected as a block', () => {
    const { core, i } = setup();
    const at = posOfNode(i.state.doc, LAYOUT_IDS.figure);
    i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, at)));
    expect(core.commentAnchor()).toEqual({
      selection: { kind: 'block', id: LAYOUT_IDS.figure },
      scopes: [['view', 'comment', 'suggest', 'edit']],
    });
  });
});

describe('where a thread lies (UX-029, UX-030)', () => {
  it('gives the position, the words and what the user may do, and none for an unknown thread', () => {
    const { core, i, a } = setup(caps('view', 'comment'));
    expect(core.threadPlacement('nobody')).toBeNull();
    core.setThreadRange('t', { from: a, to: a + 5 }, 0);
    const words = i.state.doc.textBetween(a, a + 5, ' ');
    expect(core.threadPlacement('t')).toEqual({
      position: a,
      detached: false,
      excerpt: words,
      blockKind: null,
      caps: ['view', 'comment'],
    });
  });

  it('follows the text, and is detached once the text is deleted and not re-attached by an undo', () => {
    const { core, i, a } = setup();
    core.setThreadRange('t', { from: a, to: a + 5 }, 0);
    i.dispatch(i.state.tr.insertText('Oh, ', a));
    expect(core.threadPlacement('t')?.position).toBe(a + 4);
    i.dispatch(i.state.tr.delete(a + 4, a + 9));
    expect(core.threadPlacement('t')).toMatchObject({ detached: true, excerpt: null });
    // The thread stays where it is when the deletion is undone (ADR 0015).
    core.run('undo');
    expect(core.threadPlacement('t')).toMatchObject({ detached: true, excerpt: null });
  });

  it('names the kind of a block thread', () => {
    const { core, i } = setup();
    expect(core.reportThread('fig', { seq: 0, block: LAYOUT_IDS.figure })).toBe('placed');
    expect(core.threadPlacement('fig')).toMatchObject({
      position: posOfNode(i.state.doc, LAYOUT_IDS.figure),
      detached: false,
      blockKind: 'figure',
    });
  });
});
