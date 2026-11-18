// PRM-034 criterion 1 at the element (lane w9): the permissions pane's region list is read again when
// another person renames a region, although a rename raises no new access. The list is the view the
// element gives the shell (`regionsView`), watching the access and `core.regionTitles` as
// `src/editor.ts` does, over the mock backend's `GET /documents/{id}/regions`. Node.js only.
import { MockService } from '@docedit/backend-mock';
import { DocumentCore } from '@docedit/engine/headless';
import { IDS } from '@docedit/protocol/contract';
import { describe, expect, it } from 'vitest';
import { regionsView } from '../src/permissions-shell.ts';
import { until } from './core-host.ts';
import { contractDocument } from './support.ts';

async function member(service: MockService, docId: string, sub: string, role: 'owner' | 'editor') {
  const backend = service.backend({ sub }, { [docId]: role });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  return { core, backend, detach };
}

describe('the region list follows a rename by someone else (PRM-034 criterion 1)', () => {
  it('shows the new title to a connected editor and to the owner who renamed it', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), { grants: [] });
    const alice = await member(service, docId, 'alice', 'owner');
    const bob = await member(service, docId, 'bob', 'editor');
    const titleIn = (view: ReturnType<typeof regionsView>) =>
      view.get().find((r) => r.id === IDS.open)?.title;
    const watch = (m: Awaited<ReturnType<typeof member>>) =>
      regionsView(m.backend.permissions.regions!.bind(m.backend.permissions), docId, [
        m.core.permissions,
        m.core.regionTitles,
      ]);
    const bobList = watch(bob);
    const aliceList = watch(alice);
    const stopBob = bobList.subscribe(() => {});
    const stopAlice = aliceList.subscribe(() => {});
    await until(() => titleIn(bobList) === 'Open' && titleIn(aliceList) === 'Open', 'first list');

    expect(alice.core.run('renameRegion', { region: IDS.open, title: 'Preamble' })).toBe(true);
    await until(() => titleIn(bobList) === 'Preamble', "the new title in Bob's list");
    await until(() => titleIn(aliceList) === 'Preamble', "the new title in Alice's list");
    expect(bobList.get().map((r) => r.id)).toContain(IDS.locked);

    stopBob();
    stopAlice();
    alice.detach();
    bob.detach();
    await service.dispose();
  });
});
