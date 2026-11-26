/**
 * FRW-022 criterion 6, in the editing core over backend-mock (which runs the real authority): an
 * entry is offered for a field that a rule hides, as it is when the editor's verdict and the
 * authority's differ (the entry API takes no account of the editor's own rule state, as a stale
 * view or another client would not). The authority refuses it with `permission_denied`; the core
 * sets the fill aside, the field shows the stored value, and the service keeps what it had. When the controlling field is filled, the authority's verdict changes
 * and the same fill is accepted: its verdict is the one that counts.
 */
import { MockService } from '@docedit/backend-mock';
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { FIELD_IDS, fieldsDocument } from './frw-fields-fixture.ts';
import { microtask, until } from './support.ts';
import { loadParts } from '../src/parts.ts';

// The rules language and the authoring checks load on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['authoring', 'forms', 'rules']));

/** The fields document with one rule: the name is hidden while the amount is empty. */
function withHideRule() {
  const envelope = fieldsDocument() as unknown as {
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  envelope.doc.content
    .find((n) => n.type === 'defs')!
    .content.push({
      type: 'rule_def',
      attrs: {
        id: 'rHideName',
        when: { empty: [{ field: 'tenant.amount' }] },
        then: [{ hide: ['tenant.name'] }],
      },
    });
  return envelope as unknown as ReturnType<typeof fieldsDocument>;
}

async function participant(service: MockService, docId: string) {
  const backend = service.backend(
    { sub: 'tessa', fill: { roles: ['role_tenant'] } },
    {
      [docId]: 'filler',
    },
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

describe('the authority’s verdict wins over the editor’s (FRW-022 criterion 6)', () => {
  it('refuses a fill of a hidden field that the editor offered, and keeps the stored value', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(withHideRule());
    const { core, detach, backend } = await participant(service, docId);
    try {
      // The editor's own evaluation (FRW-023) already hides the field; the entry is made anyway.
      expect(core.fieldFillable(FIELD_IDS.name)).toBe(false);
      const kept = core.recovered.get().items.length;
      core.enterFieldValue(FIELD_IDS.name, 'Ada');
      await core.flush({ timeoutMs: 5000 });
      const refused = core.recovered.get().items.slice(kept)[0];
      expect(refused?.reason).toBe('permission_denied');
      // The editor shows the stored value again, and so does the service.
      expect(core.fieldValues()['tenant.name']).toBeNull();
      expect(JSON.stringify((await backend.sync.loadContent(docId)).doc)).not.toContain('"Ada"');
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('accepts the same fill once the controlling field is filled: the verdict follows the document', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(withHideRule());
    const { core, detach, backend } = await participant(service, docId);
    try {
      expect(await core.fillField('tenant.amount', '5')).toEqual({ ok: true, confirmed: true });
      expect(await core.fillField('tenant.name', 'Ada')).toEqual({ ok: true, confirmed: true });
      expect(core.fieldValues()['tenant.name']).toBe('Ada');
      expect(JSON.stringify((await backend.sync.loadContent(docId)).doc)).toContain('"Ada"');
    } finally {
      detach();
      await service.dispose();
    }
  });
});
