/**
 * FRW-023 criterion 5, in the editing core over backend-mock (which runs the real authority): when
 * the service refuses a fill and names the rule that stopped it, the editor sets the entry aside,
 * says which rule it was in the rule's own words, and re-evaluates against the confirmed document
 * (lane w4). The entry is made past the editor's own verdict, as a stale view or another client
 * would make it.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { FIELD_IDS, fieldsDocument } from './frw-fields-fixture.ts';
import { microtask, until } from './support.ts';

/** The fields document with one rule: the name is hidden while the amount is empty. */
function withRule(then: unknown[]) {
  const envelope = fieldsDocument() as unknown as {
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  envelope.doc.content
    .find((n) => n.type === 'defs')!
    .content.push({
      type: 'rule_def',
      attrs: { id: 'rHideName', when: { empty: [{ field: 'tenant.amount' }] }, then },
    });
  return envelope as unknown as ReturnType<typeof fieldsDocument>;
}

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

describe('a fill the service refuses and a rule is named (FRW-023 criterion 5)', () => {
  it('keeps the rule the server named with the entry set aside, and re-evaluates against the confirmed document', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(withRule([{ hide: ['tenant.name'] }]));
    const { core, detach, backend } = await participant(service, docId);
    try {
      expect(core.fieldFillable(FIELD_IDS.name)).toBe(false);
      core.enterFieldValue(FIELD_IDS.name, 'Ada');
      await core.flush({ timeoutMs: 5000 });

      // The entry is set aside with the rule's identifier and its words (none: a hide has no message).
      const refused = core.recovered.get().items[0];
      expect(refused?.reason).toBe('permission_denied');
      expect(refused?.rule).toEqual({ id: 'rHideName', message: null });
      // The field shows the confirmed document again, and so does the service.
      expect(core.fieldValues()['tenant.name']).toBeNull();
      expect(JSON.stringify((await backend.sync.loadContent(docId)).doc)).not.toContain('"Ada"');

      // Re-evaluated against the confirmed document: still hidden until the amount is filled.
      expect(core.fieldRuleState(FIELD_IDS.name)).toMatchObject({ visible: false });
      expect(await core.fillField('tenant.amount', '5')).toEqual({ ok: true, confirmed: true });
      expect(core.fieldRuleState(FIELD_IDS.name)).toMatchObject({ visible: true });
      expect(core.fieldFillable(FIELD_IDS.name)).toBe(true);
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('gives the rule’s own message when it has one', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(
      withRule([
        { hide: ['tenant.name'] },
        { validate: { fields: ['tenant.amount'], message: 'Fill the amount first.' } },
      ]),
    );
    const { core, detach } = await participant(service, docId);
    try {
      core.enterFieldValue(FIELD_IDS.name, 'Ada');
      await core.flush({ timeoutMs: 5000 });
      expect(core.recovered.get().items[0]?.rule).toEqual({
        id: 'rHideName',
        message: 'Fill the amount first.',
      });
    } finally {
      detach();
      await service.dispose();
    }
  });
});
