/**
 * FRW-032 criterion 2, the client's half, in the editing core over backend-mock (which runs the real
 * authority): a participant whose commit is refused with `read_only`, the code a paused participant
 * gets (packages/authority/test/frw-032.correct-room.test.ts), keeps what they had not sent. The
 * value goes to the recovered edits with its reason, the field shows the stored value again, and the
 * participant cannot fill any more until the document is writable again. The mock has no workflow, so
 * the refusal here comes from the document's lock; the code and the path in the core are the same.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it, beforeAll } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { FIELD_IDS, fieldsDocument } from './frw-fields-fixture.ts';
import { microtask, sleep, until } from './support.ts';
import { loadParts } from '../src/parts.ts';

// The forms part holds the entries of the fields (FND-008; parts.ts).
beforeAll(() => loadParts(['forms']));

async function participant(service: MockService, docId: string) {
  const backend = service.backend(
    { sub: 'tessa', fill: { roles: ['role_tenant'] } },
    { [docId]: 'filler' },
  );
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, mode: 'fill', schedule: microtask });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
  });
  await until(() => core.permissions.get() !== null, 'the access arrives');
  return { core, detach, backend };
}

describe('a participant refused with read_only keeps what they had not sent (FRW-032 criterion 2)', () => {
  it('puts the unsent value in the recovered edits, with its reason, and shows the stored value', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(fieldsDocument());
    const { core, detach, backend } = await participant(service, docId);
    try {
      const kept = core.recovered.get().items.length;
      // The commit is held at the service while the document is locked: the participant has sent it
      // and nothing is stored yet.
      const hold = service.holdWrites(docId);
      core.enterFieldValue(FIELD_IDS.name, 'Ada');
      await sleep(5);
      service.setDocumentState(docId, 'locked');
      await hold.release();
      await until(() => core.recovered.get().items.length > kept, 'the value is set aside', 5000);
      const item = core.recovered.get().items.slice(kept)[0];
      expect(item?.reason).toBe('read_only');
      // Nothing was stored, and the field shows what the document holds.
      expect(core.fieldValues()['tenant.name']).toBeNull();
      expect(JSON.stringify((await backend.sync.loadContent(docId)).doc)).not.toContain('"Ada"');
      // The core is read-only now: a new entry is not applied.
      await until(() => core.saveState.get() === 'readonly', 'read-only', 5000);
      core.enterFieldValue(FIELD_IDS.name, 'Bea');
      expect(core.fieldValues()['tenant.name']).toBeNull();
      // When the document is writable again the participant fills as before.
      service.setDocumentState(docId, 'active');
      await until(() => core.saveState.get() === 'saved', 'saved again', 5000);
      core.enterFieldValue(FIELD_IDS.name, 'Cy');
      await core.flush({ timeoutMs: 5000 });
      expect(core.fieldValues()['tenant.name']).toBe('Cy');
    } finally {
      detach();
      await service.dispose();
    }
  });
});
