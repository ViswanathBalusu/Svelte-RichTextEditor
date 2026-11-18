/**
 * PRM-034 criteria 1 and 5 at the engine (lane w9): end to end through the mock service (authority
 * room, protocol bridge, sync session).
 *
 * - Criterion 1: an owner renames a region; a connected editor receives the commit, the derived
 *   region list the permissions pane reads gives the new title, and `regionTitles`, the signal the
 *   element watches to re-read that list, changes for the editor and for the owner once saved.
 * - Criterion 5: without `structure` the rename command is disabled and says `no-access`; a rename
 *   forced onto the wire anyway is rejected with `permission_denied` and the offending scope.
 */
import { uuid7 } from '@docedit/model';
import type { SyncCommit } from '@docedit/protocol';
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { join, newService, posOf, until } from './support.ts';

describe('a renamed region reaches everyone (PRM-034 criterion 1)', () => {
  it('shows the new title in the region list and signals the pane to read it again', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [] });
    const alice = await join(service, docId, 'alice', 'owner');
    const bob = await join(service, docId, 'bob', 'editor');
    const before = bob.core.regionTitles.get();
    const aliceBefore = alice.core.regionTitles.get();
    expect(before).toContain('Open');

    expect(alice.core.run('renameRegion', { region: IDS.open, title: 'Preamble' })).toBe(true);
    await until(() => alice.core.saveState.get() === 'saved', 'the commit is saved');
    await until(() => bob.core.regionTitles.get() !== before, 'the rename reaches Bob');

    expect(bob.core.regionTitles.get()).toContain('Preamble');
    expect(alice.core.regionTitles.get()).not.toBe(aliceBefore);
    const list = await bob.backend.permissions.regions!(docId);
    expect(list.find((r) => r.id === IDS.open)?.title).toBe('Preamble');
    const own = await alice.backend.permissions.regions!(docId);
    expect(own.find((r) => r.id === IDS.open)?.title).toBe('Preamble');

    alice.detach();
    bob.detach();
    await service.dispose();
  });
});

describe('a rename without the rights is disabled and refused (PRM-034 criterion 5)', () => {
  it('is disabled with the reason, and a forced commit is rejected with the offending scope', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const alice = await join(service, docId, 'alice', 'owner');
    // Grace may edit the restricted region through a grant, but holds no `structure`: a role that
    // gives it is the document's, and a region grant never conveys it (07 §2).
    const grace = await join(service, docId, 'grace', 'commenter', {}, { groups: ['legal'] });
    const args = { region: IDS.locked, title: 'Confidential terms' };

    expect(alice.core.queryCommand('renameRegion', args)).toMatchObject({ enabled: true });
    expect(grace.core.canEdit(`region:${IDS.locked}`)).toBe(true);
    expect(grace.core.queryCommand('renameRegion', args)).toEqual({
      enabled: false,
      active: false,
      reason: 'no-access',
    });
    expect(grace.core.run('renameRegion', args)).toBe(false);

    // The same change forced onto the wire by a client that skips its own check.
    const i = internals(grace.core);
    const step = new AttrStep(posOf(i.state.doc, IDS.locked), 'title', args.title);
    const backend = service.backend({ sub: 'grace', groups: ['legal'] }, { [docId]: 'commenter' });
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const channel = await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    const commit = {
      id: uuid7(),
      base: content.seq,
      steps: [step.toJSON()],
    } as unknown as SyncCommit;
    const refusal = await channel.submit(commit).then(
      () => null,
      (e: unknown) => e as { code?: string; scopes?: string[] },
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('permission_denied');
    expect(refusal!.scopes).toContain('body');
    const list = await alice.backend.permissions.regions!(docId);
    expect(list.find((r) => r.id === IDS.locked)?.title).toBe('Locked');

    alice.detach();
    grace.detach();
    await service.dispose();
  });
});
