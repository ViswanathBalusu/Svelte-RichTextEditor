/**
 * FRW-010 criterion 5, the core's part: a fill that the authority rejects with `conflict` and the
 * action `drop` is set aside, the document shows the stored value, and the recovered item names the
 * fields that someone else changed first, so that the shell can say so (12 §4.2, P9).
 */
import { MockService } from '@docedit/backend-mock';
import type { SyncChannel, SyncReject } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, textOfNode, type, until } from './support.ts';

async function join(service: MockService, docId: string, reject: (id: string) => SyncReject) {
  const backend = service.backend({ sub: 'grace' }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  let refused = 0;
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = async (commit) => {
    if (refused++ === 0) {
      const r = reject(commit.id);
      throw Object.assign(new Error(r.message), r);
    }
    return submit(commit);
  };
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  return { core, detach };
}

describe('FRW-010: a conflicting fill is set aside and says which field', () => {
  it('shows the stored value and names the field on the recovered item', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument());
    const g = await join(service, docId, (id) => ({
      id,
      code: 'conflict',
      action: 'drop',
      head: 0,
      message: 'changed by another user',
      scopes: ['field:fld-1'],
    }));
    caret(g.core, IDS.intro, 0);
    type(g.core, 'mine ');
    await until(
      () => g.core.recovered.get().items.some((r) => r.reason === 'conflict'),
      'the conflict',
    );
    const item = g.core.recovered.get().items[0];
    expect(item?.fields).toEqual(['fld-1']);
    expect(textOfNode(internals(g.core).state.doc, IDS.intro)).not.toContain('mine ');
    g.detach();
    await service.dispose();
  });

  it('a conflict that names no field has no field list', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument());
    const g = await join(service, docId, (id) => ({
      id,
      code: 'conflict',
      action: 'drop',
      head: 0,
      message: 'changed by another user',
    }));
    caret(g.core, IDS.intro, 0);
    type(g.core, 'mine ');
    await until(() => g.core.recovered.get().count === 1, 'the conflict');
    expect(g.core.recovered.get().items[0]?.fields).toBeUndefined();
    g.detach();
    await service.dispose();
  });
});
