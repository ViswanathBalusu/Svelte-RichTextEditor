/**
 * The undo history over remote commits, end to end against backend-mock (SYN-022; FE-049). The
 * authority is the real `Room`, so the undo steps are checked by the room and the remote commits
 * are its own.
 */
import { undoDepth } from 'prosemirror-history';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { LEGAL_GRANT_FOR_TESTS, IDS, contractDocument } from './fixtures.ts';
import { caret, join, newService, posOf, sleep, textOfNode, type, until } from './support.ts';

async function pair() {
  const service = newService();
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const a = await join(service, docId, 'eddie', 'editor');
  const b = await join(service, docId, 'olivia', 'owner');
  const done = async () => {
    a.detach();
    b.detach();
    await service.dispose();
  };
  return { service, docId, a, b, done };
}

const saved = (core: { saveState: { get(): string } }) =>
  until(() => core.saveState.get() === 'saved', 'saved', 5000);

describe('undo history rebased over remote commits (SYN-022)', () => {
  it('undo removes only my change, rebased over every remote commit since (criterion 1)', async () => {
    const { docId, a, b, done } = await pair();
    const ia = internals(a.core);
    const ib = internals(b.core);
    caret(a.core, IDS.mid, 0);
    type(a.core, 'mine ');
    await saved(a.core);
    await until(() => textOfNode(ib.state.doc, IDS.mid) === 'mine Between', 'b sees mine');
    // Another user changes the same paragraph after my change, then another paragraph.
    caret(b.core, IDS.mid, 'end');
    type(b.core, 'B');
    await saved(b.core);
    caret(b.core, IDS.intro, 0);
    type(b.core, 'theirs ');
    await saved(b.core);
    await until(() => textOfNode(ia.state.doc, IDS.intro).startsWith('theirs '), 'their text at a');
    await until(
      () => textOfNode(ia.state.doc, IDS.mid) === 'mine BetweenB',
      'their paragraph at a',
    );
    expect(a.core.run('undo')).toBe(true);
    await saved(a.core);
    expect(textOfNode(ia.state.doc, IDS.mid)).toBe('BetweenB');
    expect(textOfNode(ia.state.doc, IDS.intro)).toBe('theirs Hello world');
    const server = await a.backend.sync.loadContent(docId);
    expect(ia.state.doc.toJSON()).toEqual(server.doc);
    expect(a.core.problem.get()).toBeNull();
    await done();
  });

  it('a remote commit that removed the undone content drops that step without corrupting the document (criterion 2)', async () => {
    const { docId, a, b, done } = await pair();
    const ia = internals(a.core);
    const ib = internals(b.core);
    caret(a.core, IDS.mid, 0);
    type(a.core, 'mine ');
    await saved(a.core);
    await until(() => textOfNode(ib.state.doc, IDS.mid) === 'mine Between', 'b sees mine');
    const from = posOf(ib.state.doc, IDS.mid) + 1;
    ib.dispatch(ib.state.tr.delete(from, from + 'mine Between'.length));
    await saved(b.core);
    await until(() => textOfNode(ia.state.doc, IDS.mid) === '', 'the deletion at a');
    // The entry for "mine " now touches nothing: undo may be refused or may do nothing.
    a.core.run('undo');
    await saved(a.core);
    const server = await a.backend.sync.loadContent(docId);
    expect(ia.state.doc.toJSON()).toEqual(server.doc);
    expect(textOfNode(ia.state.doc, IDS.mid)).toBe('');
    expect(a.core.problem.get()).toBeNull();
    await done();
  });

  it('after an undo and remote commits, redo restores my change at its mapped position (criterion 3)', async () => {
    const { docId, a, b, done } = await pair();
    const ia = internals(a.core);
    const ib = internals(b.core);
    caret(a.core, IDS.mid, 0);
    type(a.core, 'mine ');
    await saved(a.core);
    expect(a.core.run('undo')).toBe(true);
    await saved(a.core);
    expect(textOfNode(ia.state.doc, IDS.mid)).toBe('Between');
    // Remote commits arrive before the redo: one in my paragraph, one elsewhere.
    caret(b.core, IDS.mid, 'end');
    type(b.core, 'B');
    await saved(b.core);
    caret(b.core, IDS.intro, 0);
    type(b.core, 'theirs ');
    await saved(b.core);
    await until(() => textOfNode(ia.state.doc, IDS.intro).startsWith('theirs '), 'their text at a');
    await until(() => textOfNode(ia.state.doc, IDS.mid) === 'BetweenB', 'their paragraph at a');
    expect(a.core.run('redo')).toBe(true);
    await saved(a.core);
    expect(textOfNode(ia.state.doc, IDS.mid)).toBe('mine BetweenB');
    expect(textOfNode(ia.state.doc, IDS.intro)).toBe('theirs Hello world');
    const server = await a.backend.sync.loadContent(docId);
    expect(ia.state.doc.toJSON()).toEqual(server.doc);
    expect(ib.state.doc.toJSON()).toEqual(server.doc);
    await done();
  });

  it('an undo the authority refuses with permission_denied is handled as in SYN-020; the history stays consistent (criterion 4)', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const g = await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] });
    const ig = internals(g.core);
    caret(g.core, IDS.lockedPara, 0);
    type(g.core, 'clause ');
    await saved(g.core);
    expect(undoDepth(ig.state)).toBe(1);
    // The undo is sent while the write is held; the grant goes before the write is released.
    const hold = service.holdWrites(docId);
    expect(g.core.run('undo')).toBe(true);
    await sleep(5);
    service.setGrants(docId, []);
    await hold.release();
    await until(() => g.core.saveState.get() === 'saved', 'saved', 5000);
    // The undo was refused: the paragraph keeps the change, and nothing is left to undo.
    expect(textOfNode(ig.state.doc, IDS.lockedPara)).toBe('clause Restricted text');
    expect(undoDepth(ig.state)).toBe(0);
    const server = await g.backend.sync.loadContent(docId);
    expect(ig.state.doc.toJSON()).toEqual(server.doc);
    g.detach();
    await service.dispose();
  });
});
