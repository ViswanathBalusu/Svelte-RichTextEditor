/**
 * PRM-035 criterion 5 at the engine (lane U-PRM-018-034): when an owner changes a grant, a person
 * connected to the document sees the change in the core without a reload, and the region guard
 * refuses their typing in the region from then on. End to end through the mock service, which runs
 * the authority room and the protocol bridge: the grant change is a control commit followed by
 * `perm.changed` to the connected channel (07 §9; PRM-019 criterion 3).
 *
 * Not a browser run: the shading and the lock indicator are the core's drawing (PRM-026), not
 * claimed here. The grant change goes through `MockService.setGrants`, not through the document
 * service's control plane, so the PATCH's `If-Match` is not exercised here (PRM-018).
 */
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, sleep, textOfNode, type, until } from './support.ts';

describe('a grant change reaches a connected person without a reload (PRM-035 criterion 5)', () => {
  it('lowers Bob to viewer in the region: his access changes and his typing there is refused', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const bob = await join(service, docId, 'bob', 'editor', {}, { groups: ['legal'] });
    const scope = `region:${IDS.locked}`;

    // Before the change Bob may edit the region, and the change is saved.
    await until(() => bob.core.permissions.get()?.scopes[scope]?.includes('edit') === true, 'edit');
    caret(bob.core, IDS.lockedPara, 0);
    type(bob.core, 'first ');
    await until(() => bob.core.saveState.get() === 'saved', 'saved', 5000);
    expect(textOfNode(internals(bob.core).state.doc, IDS.lockedPara)).toContain('first ');

    // The owner lowers Bob's role in the region from editor to viewer (group:legal).
    service.setGrants(docId, [{ region: IDS.locked, principal: 'group:legal', role: 'viewer' }]);
    await until(
      () => bob.core.permissions.get()?.scopes[scope]?.includes('edit') === false,
      'the lowered access',
      5000,
    );
    // The access keeps the region visible: a viewer may view it and nothing else there.
    expect(bob.core.permissions.get()?.scopes[scope]).toEqual(['view']);

    // Typing in the region is refused locally from now on: nothing changes, nothing is queued.
    const before = textOfNode(internals(bob.core).state.doc, IDS.lockedPara);
    caret(bob.core, IDS.lockedPara, 'end');
    type(bob.core, 'second ');
    await sleep(20);
    expect(textOfNode(internals(bob.core).state.doc, IDS.lockedPara)).toBe(before);
    expect(bob.core.recovered.get().items).toHaveLength(0);

    bob.detach();
    await service.dispose();
  });
});
