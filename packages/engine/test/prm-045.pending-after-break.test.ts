/**
 * A change made under a lease that is then broken (PRM-045 criterion 4, as the owner reworded it in
 * decision 135, `docs/owner-decisions-2026-11-15.md`): the former holder's pending commit is accepted
 * if their grants allow it, and otherwise refused with `permission_denied` and set aside as
 * recovered edits (FE-010). End to end through the mock service (authority room, protocol bridge,
 * sync session); the break is the stored change a lease route makes (`MockDocument.setLeases`).
 *
 * Node.js, backend-mock with the real Room. Not run in a browser.
 */
import { describe, expect, it } from 'vitest';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, sleep, type, until } from './support.ts';

const LEASE = () => [
  { region: IDS.locked, holder: 'grace', expiresAt: Date.now() + 60 * 60 * 1000 },
];

describe('a pending change after a lease is broken (PRM-045 criterion 4)', () => {
  it('is accepted when the former holder’s grants allow it', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const grace = await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] });
    const alice = await join(service, docId, 'alice', 'owner');
    service.setLeases(docId, LEASE());
    await until(() => !alice.core.canEdit(`region:${IDS.locked}`), 'the lease reaches Alice');
    expect(grace.core.canEdit(`region:${IDS.locked}`)).toBe(true);

    const hold = service.holdWrites(docId);
    caret(grace.core, IDS.lockedPara, 0);
    type(grace.core, 'clause ');
    await sleep(5); // in flight, its write held
    service.setLeases(docId, []); // the manager breaks the lease
    await hold.release();
    await until(() => grace.core.saveState.get() === 'saved', 'saved', 5000);

    expect(grace.core.recovered.get().items).toEqual([]);
    await until(() => alice.core.canEdit(`region:${IDS.locked}`), 'the break reaches Alice');
    grace.detach();
    alice.detach();
    await service.dispose();
  });

  it('is refused with permission_denied and set aside when the grants no longer allow it', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const grace = await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] });
    service.setLeases(docId, LEASE());
    const hold = service.holdWrites(docId);
    caret(grace.core, IDS.lockedPara, 0);
    type(grace.core, 'clause ');
    await sleep(5);
    service.setLeases(docId, []);
    service.setGrants(docId, []); // the region is no longer grace's
    await hold.release();
    await until(() => grace.core.saveState.get() === 'saved', 'saved', 5000);

    const item = grace.core.recovered.get().items.find((r) => r.reason === 'permission_denied');
    expect(item).toBeDefined();
    expect(item!.text).toBe('clause ');
    expect(item!.scope).toBe(`region:${IDS.locked}`);
    grace.detach();
    await service.dispose();
  });
});
