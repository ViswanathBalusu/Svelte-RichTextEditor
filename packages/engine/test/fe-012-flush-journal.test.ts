/**
 * FE-012 criterion 3 (lane U-FE-001-016): when commits are still unconfirmed at the timeout, `flush`
 * rejects with their count and the work stays in the recovery journal (FE-008). The server never
 * answers here, as it would not for a commit that never arrived.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { memoryJournal } from '../src/index.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, type } from './support.ts';

describe('FE-012: flush rejects at the timeout and the work stays journalled', () => {
  it('rejects with the count of unconfirmed commits, and the journal still holds them', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const journal = memoryJournal();
    const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
    const channel = await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    (channel as { submit: unknown }).submit = () => new Promise(() => {});
    const detach = core.attach(channel, {
      seq: content.seq,
      incarnation: content.incarnation,
      sync: backend.sync,
      batchMs: 0,
      journal,
    });
    caret(core, IDS.intro, 'end');
    type(core, ' unconfirmed');
    await sleep(10);
    const error = await core.flush({ timeoutMs: 50 }).then(
      () => null,
      (e: unknown) => e as { count?: number; message: string },
    );
    expect(error).not.toBeNull();
    expect(error).toMatchObject({ count: 1 });
    const { commits } = await journal.read(docId);
    expect(commits.length).toBe(1);
    expect(JSON.stringify(commits)).toContain('unconfirmed');
    detach();
    await service.dispose();
  });
});
