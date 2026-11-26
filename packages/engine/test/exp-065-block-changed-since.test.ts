/**
 * EXP-065 criterion 3, the core's half: `blockChangedSince(id, seq)` says whether a block changed in
 * the confirmed document after the commit `seq` of an export job. The channel is backend-mock's real
 * Room channel; a commit counts when the service has confirmed it. The dialog's half (the words
 * "Changed since this export" and the move to the block) is packages/ui/e2e/exp-065-diagnostic-changed.spec.ts.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, type, until } from './support.ts';

async function attached() {
  const service = new MockService({ presence: false });
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
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
  });
  const saved = async (): Promise<void> => {
    await until(() => core.saveState.get() === 'saved', 'the commit is confirmed');
  };
  return { core, content, saved, close: async () => (detach(), service.dispose()) };
}

describe('EXP-065 criterion 3: blockChangedSince', () => {
  it('is false for every block at the seq the core loaded, and true only for the block a later commit changed', async () => {
    const { core, content, saved, close } = await attached();
    const exported = content.seq;
    expect(core.blockChangedSince(IDS.intro, exported)).toBe(false);
    expect(core.blockChangedSince(IDS.end, exported)).toBe(false);

    caret(core, IDS.intro, 'end');
    type(core, ' amended');
    await saved();
    expect(core.confirmedSeq.get()).toBeGreaterThan(exported);

    expect(core.blockChangedSince(IDS.intro, exported)).toBe(true);
    expect(core.blockChangedSince(IDS.end, exported)).toBe(false);
    // Measured from the seq after the change, the block has not changed again.
    expect(core.blockChangedSince(IDS.intro, core.confirmedSeq.get())).toBe(false);
    await close();
  });

  it('cannot tell for a seq older than the core followed, a block that is not there, or a core without a channel', async () => {
    const { core, content, close } = await attached();
    expect(core.blockChangedSince(IDS.intro, content.seq - 1)).toBeNull();
    expect(core.blockChangedSince('noSuchBlock00000', content.seq)).toBeNull();
    await close();
    const alone = new DocumentCore({ doc: contractDocument(), schedule: queueMicrotask });
    expect(alone.blockChangedSince(IDS.intro, 0)).toBeNull();
  });
});
