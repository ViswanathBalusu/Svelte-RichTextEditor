/**
 * FE-049 criterion 5 (Node.js, backend-mock with the real `Room`): a grant change makes the scope of
 * an old change read-only; when the user undoes that change, the region guard refuses the undo, the
 * document is unchanged, and the user is told through the refusal notice (the same mechanism PRM and
 * FE-036 use: `core.refusal` with reason `scope` and the blocking scope).
 *
 * Bob types in the locked region while he is an editor, the typing is saved, then the owner lowers
 * him to viewer. His undo of the saved typing must be refused locally.
 */
import { undoDepth } from 'prosemirror-history';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, sleep, textOfNode, type, until } from './support.ts';

describe('an undo of a change the grant no longer allows is refused and the user is told (FE-049 criterion 5)', () => {
  it('the guard refuses the undo, the document is unchanged and the refusal names the region', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const bob = await join(service, docId, 'bob', 'editor', {}, { groups: ['legal'] });
    const ib = internals(bob.core);
    const scope = `region:${IDS.locked}`;

    // While he is an editor, Bob types in the region and the typing is saved.
    await until(() => bob.core.permissions.get()?.scopes[scope]?.includes('edit') === true, 'edit');
    caret(bob.core, IDS.lockedPara, 0);
    type(bob.core, 'first ');
    await until(() => bob.core.saveState.get() === 'saved', 'saved', 5000);
    expect(undoDepth(ib.state)).toBe(1);
    expect(textOfNode(ib.state.doc, IDS.lockedPara)).toContain('first ');

    // The owner lowers Bob to viewer in the region. The change reaches his core.
    service.setGrants(docId, [{ region: IDS.locked, principal: 'group:legal', role: 'viewer' }]);
    await until(
      () => bob.core.permissions.get()?.scopes[scope]?.includes('edit') === false,
      'the lowered access',
      5000,
    );
    const before = JSON.stringify(ib.state.doc.toJSON());
    const refusalsBefore = bob.core.refusal.get()?.n ?? 0;

    // Undoing the saved typing is refused by the guard: the document does not change.
    bob.core.run('undo');
    await sleep(20);
    expect(JSON.stringify(ib.state.doc.toJSON())).toBe(before);

    // The user is told: the refusal names the scope that blocked the undo.
    const refusal = bob.core.refusal.get();
    expect(refusal).not.toBeNull();
    expect(refusal!.n).toBeGreaterThan(refusalsBefore);
    expect(refusal!.reason).toBe('scope');
    expect(refusal!.scopes).toContain(scope);

    // The server agrees with the client, and nothing new is queued for the authority.
    const server = await bob.backend.sync.loadContent(docId);
    expect(ib.state.doc.toJSON()).toEqual(server.doc);
    expect(bob.core.recovered.get().items).toHaveLength(0);

    bob.detach();
    await service.dispose();
  });
});
