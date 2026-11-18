/**
 * FRW-069 in the editing core, in Node.js (lane w4): the field members of the embedding API over
 * backend-mock, which runs the real authority. `getFieldValues` reads the values by key,
 * `setFieldValue` is a normal fill whose rejection comes back with its code, and `validateFields`
 * reports and changes nothing. The element's methods are one line over these
 * (packages/element/test/frw-069-methods.test.ts); the controls and focus are in the browser
 * (packages/element/e2e/frw-069-fill-api.spec.ts).
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { FIELD_IDS, fieldsDocument } from './frw-fields-fixture.ts';
import { microtask, until } from './support.ts';

async function participant(service: MockService, docId: string, sub: string, roles: string[]) {
  const backend = service.backend({ sub, fill: { roles } }, { [docId]: 'filler' });
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

async function setup() {
  const service = new MockService({ presence: false });
  const docId = service.createDocument(fieldsDocument());
  return { service, docId };
}

describe('getFieldValues (FRW-069 criterion 3)', () => {
  it('returns the current value of each field by key, decimals as strings', async () => {
    const { service, docId } = await setup();
    const { core, detach } = await participant(service, docId, 'tessa', ['role_tenant']);
    try {
      expect(core.fieldValues()).toEqual({
        'tenant.amount': null,
        'tenant.name': null,
        'tenant.email': null,
        'landlord.name': null,
      });
      expect(await core.fillField('tenant.amount', '12.50')).toEqual({ ok: true, confirmed: true });
      expect(core.fieldValues()['tenant.amount']).toBe('12.50');
    } finally {
      detach();
      await service.dispose();
    }
  });
});

describe('setFieldValue (FRW-069 criterion 4)', () => {
  it('fills a field of the participant’s role as a normal commit, stored by the service', async () => {
    const { service, docId } = await setup();
    const { core, detach, backend } = await participant(service, docId, 'tessa', ['role_tenant']);
    try {
      expect(await core.fillField('tenant.name', 'Ada')).toEqual({ ok: true, confirmed: true });
      const stored = await backend.sync.loadContent(docId);
      expect(JSON.stringify(stored.doc)).toContain('"Ada"');
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('answers permission_denied for a field of another role, and changes nothing (P7)', async () => {
    const { service, docId } = await setup();
    const { core, detach } = await participant(service, docId, 'tessa', ['role_tenant']);
    try {
      const out = await core.fillField('landlord.name', 'Grace');
      expect(out).toMatchObject({ ok: false, code: 'permission_denied' });
      expect(core.fieldValues()['landlord.name']).toBeNull();
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('answers field_invalid when the service refuses a value that does not fit', async () => {
    const { service, docId } = await setup();
    const { core, detach, backend } = await participant(service, docId, 'tessa', ['role_tenant']);
    try {
      expect(await core.fillField('tenant.amount', '12.50')).toEqual({ ok: true, confirmed: true });
      const out = await core.fillField('tenant.amount', 'abc');
      expect(out).toMatchObject({ ok: false, code: 'field_invalid' });
      // The service kept the value it had.
      const stored = JSON.stringify((await backend.sync.loadContent(docId)).doc);
      expect(stored).toContain('"12.50"');
      expect(stored).not.toContain('"abc"');
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('answers conflict when someone else changed the field first (P9)', async () => {
    const { service, docId } = await setup();
    const a = await participant(service, docId, 'tessa', ['role_tenant']);
    const b = await participant(service, docId, 'tom', ['role_tenant']);
    try {
      // The room holds its writes: the first fill is accepted but nobody has seen it yet, so the
      // second fill of the same field is made from the older base.
      const held = service.holdWrites(docId);
      expect(a.core.enterFieldValue(FIELD_IDS.name, 'Ada').ok).toBe(true);
      const out = await b.core.fillField('tenant.name', 'Bob');
      await held.release();
      expect(out).toMatchObject({ ok: false, code: 'conflict' });
      await until(
        () => b.core.fieldValues()['tenant.name'] === 'Ada',
        'the stored value reaches Tom',
      );
    } finally {
      a.detach();
      b.detach();
      await service.dispose();
    }
  });

  it('answers not_found for a key no field has, without throwing', async () => {
    const { service, docId } = await setup();
    const { core, detach } = await participant(service, docId, 'tessa', ['role_tenant']);
    try {
      expect(await core.fillField('nobody.home', 'x')).toMatchObject({
        ok: false,
        code: 'not_found',
      });
    } finally {
      detach();
      await service.dispose();
    }
  });
});

describe('validateFields (FRW-069 criterion 5)', () => {
  it('returns the required-and-empty and the invalid fields with keys and reasons, and changes nothing', async () => {
    const { service, docId } = await setup();
    const { core, detach } = await participant(service, docId, 'tessa', ['role_tenant']);
    try {
      const first = core.validateFields();
      expect(first).toEqual([
        {
          key: 'tenant.email',
          id: FIELD_IDS.email,
          problems: [{ code: 'required', message: 'this field is required' }],
        },
      ]);
      // An invalid entry is reported too, with its reason; calling again changes nothing.
      core.enterFieldValue(FIELD_IDS.amount, '-1');
      const content = JSON.stringify(core.getContent());
      const second = core.validateFields();
      expect(second.map((r) => [r.key, r.problems.map((p) => p.code)])).toEqual([
        ['tenant.amount', ['min']],
        ['tenant.email', ['required']],
      ]);
      expect(core.validateFields()).toEqual(second);
      expect(JSON.stringify(core.getContent())).toBe(content);
    } finally {
      detach();
      await service.dispose();
    }
  });
});
