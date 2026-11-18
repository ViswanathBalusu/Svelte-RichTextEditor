/**
 * PRM-027 criterion 4 end to end (lane w9): when `perm.changed` reaches a connected editor, the
 * core applies the new access and `hasNextEditableRegion`, the query behind the command's enabled
 * state, changes with it. The grant change goes through `MockService.setGrants` (authority room and
 * protocol bridge), as in PRM-035's engine test. The shell's reaction to the change (the registry
 * observing `core.permissions`) is `packages/ui/test/navigation.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, until } from './support.ts';

describe('a grant change reaches the next-editable-region query (PRM-027 criterion 4)', () => {
  it('turns on when the restricted region after the caret is granted, and off when it is taken back', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [] });
    const bob = await join(service, docId, 'bob', 'editor', {}, { groups: ['legal'] });
    const scope = `region:${IDS.locked}`;

    // After the open region, the only region left is the restricted one, which Bob cannot edit.
    await until(() => bob.core.permissions.get() !== null, 'the first access');
    caret(bob.core, IDS.mid, 0);
    expect(bob.core.permissions.get()?.scopes[scope]?.includes('edit') ?? false).toBe(false);
    expect(bob.core.query('hasNextEditableRegion')).toBe(false);
    expect(bob.core.queryCommand('nextEditableRegion').enabled).toBe(false);

    service.setGrants(docId, [LEGAL_GRANT_FOR_TESTS]);
    await until(
      () => bob.core.permissions.get()?.scopes[scope]?.includes('edit') === true,
      'the granted access',
    );
    expect(bob.core.query('hasNextEditableRegion')).toBe(true);
    expect(bob.core.queryCommand('nextEditableRegion').enabled).toBe(true);

    service.setGrants(docId, []);
    await until(
      () => bob.core.permissions.get()?.scopes[scope]?.includes('edit') !== true,
      'the revoked access',
    );
    expect(bob.core.query('hasNextEditableRegion')).toBe(false);

    bob.detach();
    await service.dispose();
  });
});
