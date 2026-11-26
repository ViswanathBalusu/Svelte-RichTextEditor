/**
 * UX-078 criterion 3 (owner decision 110), the engine half: a commit the service refuses with
 * `quota_exceeded` and a `quota` kind is sent again after the delay, and the core says which quota
 * is the reason (`quotaWait`) until the commit is confirmed or set aside. The room is
 * backend-mock's; the refusal is made by the channel's `submit`, as the service makes it.
 */
import { MockService } from '@docedit/backend-mock';
import type { QuotaKind, SyncChannel, SyncReject } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, type, until } from './support.ts';

type Answer = SyncReject | null;

async function join(
  service: MockService,
  docId: string,
  answer: (commit: { id: string; base: number }) => Answer,
) {
  const backend = service.backend({ sub: 'grace' }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const sent: string[] = [];
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = async (commit) => {
    sent.push(commit.id);
    const a = answer(commit);
    if (a) throw Object.assign(new Error(a.message), a);
    return submit(commit);
  };
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  return { core, detach, sent };
}

const refusal = (id: string, base: number, quota: QuotaKind | undefined): SyncReject => ({
  id,
  code: 'quota_exceeded',
  action: 'retry',
  head: base,
  message: 'a quota of the tenant is reached',
  retryAfterMs: 2,
  ...(quota === undefined ? {} : { quota }),
});

describe('UX-078 criterion 3: the core says which quota made a commit wait', () => {
  it.each(['commitRate', 'roomCpuBudget'] as const)(
    'names the %s quota while the commit waits, and clears it once the commit is saved',
    async (kind) => {
      const service = new MockService({ presence: false });
      const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
      let refused = 3;
      const g = await join(service, docId, (c) =>
        refused-- > 0 ? refusal(c.id, c.base, kind) : null,
      );
      const seen: Array<{ n: number; quota: string } | null> = [];
      g.core.quotaWait.subscribe(() => seen.push(g.core.quotaWait.get()));
      caret(g.core, IDS.intro, 'end');
      type(g.core, ' waiting');
      await until(() => g.core.quotaWait.get() !== null, 'the wait is told');
      expect(g.core.quotaWait.get()).toEqual({ n: 1, quota: kind });
      await until(() => g.core.saveState.get() === 'saved', 'saved after the retries');
      // Told once for three refusals, then cleared when the commit was confirmed.
      expect(seen).toEqual([{ n: 1, quota: kind }, null]);
      expect(g.core.quotaWait.get()).toBeNull();
      expect(new Set(g.sent).size).toBe(1);
      g.detach();
      await service.dispose();
    },
  );

  it('says nothing when the refusal names no quota, or is for another reason', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    let refused = 2;
    const g = await join(service, docId, (c) =>
      refused-- > 0
        ? refused === 1
          ? refusal(c.id, c.base, undefined)
          : {
              id: c.id,
              code: 'busy',
              action: 'retry',
              head: c.base,
              message: 'busy',
              retryAfterMs: 2,
            }
        : null,
    );
    const seen: unknown[] = [];
    g.core.quotaWait.subscribe(() => seen.push(g.core.quotaWait.get()));
    caret(g.core, IDS.intro, 'end');
    type(g.core, ' plain');
    await until(() => g.core.saveState.get() === 'saved', 'saved after the retries');
    expect(seen).toEqual([]);
    g.detach();
    await service.dispose();
  });

  it('clears the wait when the commit is set aside for another reason', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    let n = 0;
    const g = await join(service, docId, (c) =>
      n++ === 0
        ? refusal(c.id, c.base, 'commitRate')
        : { id: c.id, code: 'invalid_op', action: 'drop', head: c.base, message: 'refused' },
    );
    caret(g.core, IDS.intro, 'end');
    type(g.core, ' dropped');
    await until(() => g.core.quotaWait.get() !== null, 'the wait is told');
    await until(() => g.core.quotaWait.get() === null, 'the wait ends when the commit is dropped');
    g.detach();
    await service.dispose();
  });
});
