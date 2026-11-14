/**
 * FE-008 (lane U-FE-001-016, round 3 fix): a commit leaves the recovery journal when it leaves
 * flight without an acknowledgement, not only when it is acknowledged. A commit refused for good
 * (`permission_denied` from backend-mock's real Room after the grant was withdrawn; `rebase_failed`
 * and `invalid_op` answers), or put back in the queue by a `rebase` answer, is not kept in the
 * journal: refused content is held in memory as recovered edits (FE-010 keeps it later, under the
 * purge rules of ADR 0019), and FE-009 can never resubmit work the server refused.
 */
import { MockService } from '@docedit/backend-mock';
import type { SyncChannel, SyncReject } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, textOfNode, type, until } from './support.ts';

type Journal = JournalPort & { readonly size: number };

/** Joins with a journal; `rejectFirst`, when given, answers the first submits instead of the room. */
async function join(
  service: MockService,
  docId: string,
  journal: Journal,
  opts: {
    groups?: string[];
    rejectFirst?: (commit: { id: string; base: number }) => SyncReject | null;
  } = {},
) {
  const backend = service.backend(
    opts.groups ? { sub: 'grace', groups: opts.groups } : { sub: 'grace' },
    { [docId]: 'editor' },
  );
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const sent: Array<{ id: string; journalIds: string[] }> = [];
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = async (commit) => {
    sent.push({
      id: commit.id,
      journalIds: (await journal.read(docId)).commits.map((c) => c.id),
    });
    const reject = opts.rejectFirst?.(commit) ?? null;
    if (reject) throw Object.assign(new Error(reject.message), reject);
    return submit(commit);
  };
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    journal,
    retry: { minMs: 2, maxMs: 20 },
  });
  return { core, detach, sent };
}

function journalText(contents: Awaited<ReturnType<JournalPort['read']>>): string {
  return JSON.stringify(contents);
}

describe('FE-008: a commit refused or set aside leaves the journal', () => {
  it('permission_denied from the real Room: the journal holds nothing of the refused work', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const journal = memoryJournal();
    const g = await join(service, docId, journal, { groups: ['legal'] });
    const hold = service.holdWrites(docId);
    caret(g.core, IDS.lockedPara, 0);
    type(g.core, 'clause ');
    await until(() => g.sent.length > 0, 'the commit is sent');
    // While unconfirmed, the commit is in the journal.
    expect(journal.size).toBe(1);
    expect(journalText(await journal.read(docId))).toContain('clause ');
    service.setGrants(docId, []); // the region is no longer grace's
    await hold.release();
    await until(
      () => g.core.recovered.get().items.some((r) => r.reason === 'permission_denied'),
      'the refusal',
    );
    await until(() => g.core.saveState.get() === 'saved', 'saved');
    await sleep(10);
    const after = await journal.read(docId);
    expect(after.commits).toEqual([]);
    expect(after.queue).toEqual([]);
    expect(journalText(after)).not.toContain('clause');
    // The refused work is held in memory as recovered edits, and gone from the document.
    expect(textOfNode(internals(g.core).state.doc, IDS.lockedPara)).toBe('Restricted text');
    g.detach();
    await service.dispose();
  });

  it('rebase_failed (drop) and invalid_op (reload): the refused commit leaves the journal', async () => {
    for (const [code, action] of [
      ['rebase_failed', 'drop'],
      ['invalid_op', 'reload'],
    ] as const) {
      const service = new MockService({ presence: false });
      const docId = service.createDocument(contractDocument());
      const journal = memoryJournal();
      let refused = 0;
      const g = await join(service, docId, journal, {
        rejectFirst: (c) =>
          refused++ === 0
            ? { id: c.id, code, action, head: c.base, message: `refused: ${code}` }
            : null,
      });
      caret(g.core, IDS.intro, 0);
      type(g.core, 'refused ');
      await until(
        () => g.core.recovered.get().items.some((r) => r.reason === code),
        `the ${code} refusal`,
      );
      await until(() => g.core.saveState.get() === 'saved', 'saved');
      await sleep(10);
      const after = await journal.read(docId);
      expect(after.commits, code).toEqual([]);
      expect(after.queue, code).toEqual([]);
      expect(journalText(after), code).not.toContain('refused');
      g.detach();
      await service.dispose();
    }
  });

  it('a rebase answer: the old identifier leaves the journal before the work is sent again', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument());
    const journal = memoryJournal();
    let refused = 0;
    const g = await join(service, docId, journal, {
      rejectFirst: (c) =>
        refused++ === 0
          ? { id: c.id, code: 'stale_base', action: 'rebase', head: c.base, message: 'stale' }
          : null,
    });
    caret(g.core, IDS.intro, 0);
    type(g.core, 'again ');
    await until(() => g.core.saveState.get() === 'saved' && g.sent.length >= 2, 'saved');
    const [first, second] = g.sent;
    expect(second!.id).not.toBe(first!.id);
    // At the second send the journal holds the new commit only, not the refused identifier.
    expect(second!.journalIds).toEqual([second!.id]);
    expect(textOfNode(internals(g.core).state.doc, IDS.intro)).toBe('again Hello world');
    await sleep(10);
    expect(journal.size).toBe(0);
    g.detach();
    await service.dispose();
  });
});
