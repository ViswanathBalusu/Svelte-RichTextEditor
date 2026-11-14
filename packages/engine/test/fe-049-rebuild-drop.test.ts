/**
 * FE-049 criterion 4 (Node.js, backend-mock with the real `Room`): when a rebuild discards local
 * steps because the authority rejects their commit with `drop`, the undo entries that belong to the
 * discarded steps are dropped too, and the selection is mapped into the rebuilt document (04 §7).
 *
 * The writes are held, the grant is removed before they are released, so the typed commit is
 * refused with `permission_denied` (the same refusal the undo test in undo-rebase.test.ts uses).
 */
import { undoDepth } from 'prosemirror-history';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { LEGAL_GRANT_FOR_TESTS, IDS, contractDocument } from './fixtures.ts';
import { caret, join, newService, sleep, textOfNode, type, until } from './support.ts';

const saved = (core: { saveState: { get(): string } }) =>
  until(() => core.saveState.get() === 'saved', 'saved', 5000);

describe('a rebuild that discards local steps drops their undo entries (FE-049 criterion 4)', () => {
  it('the typed steps the authority drops leave no undo entry and the selection is mapped', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const g = await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] });
    const ig = internals(g.core);
    const before = textOfNode(ig.state.doc, IDS.lockedPara);

    // Typing is held at the server; the grant goes before the write is released.
    caret(g.core, IDS.lockedPara, 0);
    const caretBefore = ig.state.selection.from;
    const hold = service.holdWrites(docId);
    type(g.core, 'clause ');
    expect(undoDepth(ig.state)).toBe(1);
    await sleep(5);
    service.setGrants(docId, []);
    await hold.release();
    await until(() => g.core.saveState.get() === 'saved', 'saved', 5000);

    // The rebuild dropped the typed steps: the text is as it was, nothing is left to undo.
    expect(textOfNode(ig.state.doc, IDS.lockedPara)).toBe(before);
    expect(undoDepth(ig.state)).toBe(0);
    expect(g.core.run('undo')).toBe(false);

    // The caret the typing had moved is mapped back to where it was: the dropped text leaves no offset.
    const { from, to } = ig.state.selection;
    expect(from).toBe(caretBefore);
    expect(to).toBe(caretBefore);

    const server = await g.backend.sync.loadContent(docId);
    expect(ig.state.doc.toJSON()).toEqual(server.doc);
    expect(g.core.problem.get()).toBeNull();
    await saved(g.core);
    g.detach();
    await service.dispose();
  });
});
