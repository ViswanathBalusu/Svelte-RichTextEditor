/**
 * FRW-004 in the editing core, in Node.js (lane w4): the entries a person types into form fields.
 *
 * - Criterion 1, the core's half: the bounds of a number field are checked as decimals, and
 *   `validateFields()` of the core reports the field. The control's `aria-invalid` and message are
 *   tested in the browser (src/view/frw-004-field-control.universal.test.ts).
 * - Criterion 5: a fill-only participant submits an invalid entry to backend-mock's real room. The
 *   room answers by the rules of FRW-008, and the core keeps showing the entry as invalid until
 *   the entry changes.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it, beforeAll } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { FIELD_IDS, fieldsDocument, participantAccess } from './frw-fields-fixture.ts';
import { counted, microtask, traffic, until } from './support.ts';
import { loadParts } from '../src/parts.ts';

// The forms part holds the entries of the fields (FND-008; parts.ts).
beforeAll(() => loadParts(['forms']));

/** A stored node, as far as this test reads it. */
interface StoredNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly StoredNode[];
}

function storedValue(doc: StoredNode, id: string): unknown {
  let found: unknown;
  const walk = (n: StoredNode): void => {
    if (n.type === 'form_field' && n.attrs?.['id'] === id) found = n.attrs['value'] ?? null;
    for (const child of n.content ?? []) walk(child);
  };
  walk(doc);
  return found;
}

const codes = (core: DocumentCore, id: string): string[] =>
  (core.fieldEntry(id)?.problems ?? []).map((p) => p.code);

const reported = (core: DocumentCore): string[] => core.validateFields().map((r) => r.key);

describe('the bounds of a number field (FRW-004 criterion 1, the core)', () => {
  const core = () => new DocumentCore({ doc: fieldsDocument(), schedule: microtask });

  it('reports -1 and 1000000.01, with a message, through validateFields()', () => {
    const c = core();
    expect(c.enterFieldValue(FIELD_IDS.amount, '-1')).toEqual({
      ok: true,
      problems: [{ code: 'min', message: 'enter 0 or more' }],
    });
    expect(codes(c, FIELD_IDS.amount)).toEqual(['min']);
    expect(c.validateFields().find((r) => r.key === 'tenant.amount')).toEqual({
      key: 'tenant.amount',
      id: FIELD_IDS.amount,
      problems: [{ code: 'min', message: 'enter 0 or more' }],
    });

    c.enterFieldValue(FIELD_IDS.amount, '1000000.01');
    expect(codes(c, FIELD_IDS.amount)).toEqual(['max']);
    expect(reported(c)).toContain('tenant.amount');
  });

  it('takes 0 and 1000000 as valid', () => {
    const c = core();
    for (const entry of ['0', '1000000']) {
      expect(c.enterFieldValue(FIELD_IDS.amount, entry)).toEqual({ ok: true, problems: [] });
      expect(c.fieldEntry(FIELD_IDS.amount)?.value).toBe(entry);
      expect(reported(c)).not.toContain('tenant.amount');
    }
  });

  it('compares a bound as a decimal, where a binary float would not tell the entries apart', () => {
    const c = core();
    // 1000000.0000000000000001 equals 1000000 as a binary float; as a decimal it is above the bound.
    expect(Number('1000000.0000000000000001')).toBe(1000000);
    c.enterFieldValue(FIELD_IDS.amount, '1000000.0000000000000001');
    expect(codes(c, FIELD_IDS.amount)).toEqual(['max']);
    c.enterFieldValue(FIELD_IDS.amount, '1000000.0000000000000000');
    expect(codes(c, FIELD_IDS.amount)).toEqual([]);
    // The entry is stored as written, never as a number.
    expect(c.fieldEntry(FIELD_IDS.amount)?.stored).toBe('1000000.0000000000000000');
  });

  it('reports a required field that is empty, and checks without submitting', () => {
    const c = core();
    expect(c.validateFields()).toEqual([
      {
        key: 'tenant.email',
        id: FIELD_IDS.email,
        problems: [{ code: 'required', message: 'this field is required' }],
      },
    ]);
    expect(c.checkFieldEntry(FIELD_IDS.name, 'A').map((p) => p.code)).toEqual(['min_length']);
    expect(c.fieldEntry(FIELD_IDS.name)?.stored).toBeNull();
  });
});

describe('the fill mode lets field values change and nothing else (12 §4.2)', () => {
  it('a participant fills a field of their role; another role, and the body, are refused', () => {
    const c = new DocumentCore({
      doc: fieldsDocument(),
      access: participantAccess(['role_tenant']),
      mode: 'fill',
      schedule: microtask,
    });
    expect(c.mode.get().effective).toBe('fill');
    expect(c.readOnly).toBe(true);
    expect(c.fieldFillable(FIELD_IDS.amount)).toBe(true);
    expect(c.fieldFillable(FIELD_IDS.landlord)).toBe(false);
    expect(c.enterFieldValue(FIELD_IDS.amount, '12.50')).toEqual({ ok: true, problems: [] });
    expect(c.enterFieldValue(FIELD_IDS.landlord, 'Grace')).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(c.fieldEntry(FIELD_IDS.landlord)?.stored).toBeNull();
    // Text is locked in the fill mode, also for a person who may edit.
    expect(c.pastePlainText('x')).toBe(false);
  });

  it('the view mode fills nothing', () => {
    const c = new DocumentCore({
      doc: fieldsDocument(),
      access: participantAccess(['role_tenant']),
      mode: 'view',
      schedule: microtask,
    });
    expect(c.fieldFillable(FIELD_IDS.amount)).toBe(false);
    expect(c.enterFieldValue(FIELD_IDS.amount, '1')).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('an invalid entry submitted as a fill (FRW-004 criterion 5)', () => {
  async function participant() {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(fieldsDocument());
    const backend = service.backend(
      { sub: 'tessa', fill: { roles: ['role_tenant'] } },
      { [docId]: 'filler' },
    );
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const core = new DocumentCore({ doc: content, mode: 'fill', schedule: microtask });
    const channel = counted(
      await backend.sync.open(docId, {
        resume: { seq: content.seq, incarnation: content.incarnation },
      }),
    );
    const detach = core.attach(channel, {
      seq: content.seq,
      incarnation: content.incarnation,
      sync: backend.sync,
      batchMs: 0,
    });
    await until(() => core.permissions.get() !== null, 'the access arrives');
    const stored = async (id: string) =>
      storedValue((await backend.sync.loadContent(docId)).doc as unknown as StoredNode, id);
    return { core, detach, stored };
  }

  it('letters in a number field are dropped with field_invalid; the field stays invalid until the entry changes', async () => {
    traffic.clear();
    const { core, detach, stored } = await participant();
    try {
      expect(core.permissions.get()?.fill).toMatchObject({ roles: ['role_tenant'], active: true });
      expect(core.mode.get().effective).toBe('fill');

      // A valid fill first: accepted and stored (FRW-008 criterion 1).
      expect(core.enterFieldValue(FIELD_IDS.amount, '12.50')).toEqual({ ok: true, problems: [] });
      await until(() => traffic.acks === 1, 'the valid fill is acknowledged');
      expect(await stored(FIELD_IDS.amount)).toBe('12.50');

      // Letters: the commit is refused with `field_invalid` and dropped (FRW-008 criterion 4).
      const entered = core.enterFieldValue(FIELD_IDS.amount, 'abc');
      expect(entered.ok && entered.problems.map((p) => p.code)).toEqual(['type']);
      await until(() => traffic.rejects.get('field_invalid') === 1, 'the fill is refused');
      await until(
        () => core.fieldEntry(FIELD_IDS.amount)?.stored === '12.50',
        'the dropped value is gone from the document',
      );
      expect(await stored(FIELD_IDS.amount)).toBe('12.50');

      // The field still shows the entry, as invalid, and validateFields() reports it.
      const shown = core.fieldEntry(FIELD_IDS.amount);
      expect(shown?.value).toBe('abc');
      expect(shown?.problems.map((p) => p.code)).toEqual(['type']);
      expect(reported(core)).toContain('tenant.amount');

      // The entry changes: the field is valid again and the value is stored.
      expect(core.enterFieldValue(FIELD_IDS.amount, '13')).toEqual({ ok: true, problems: [] });
      await until(() => traffic.acks === 2, 'the new entry is acknowledged');
      expect(core.fieldEntry(FIELD_IDS.amount)).toMatchObject({ value: '13', problems: [] });
      expect(reported(core)).not.toContain('tenant.amount');
      expect(await stored(FIELD_IDS.amount)).toBe('13');
    } finally {
      detach();
    }
  });

  it('an entry outside a limit stays invalid on the client whatever the room answers', async () => {
    traffic.clear();
    const { core, detach, stored } = await participant();
    try {
      const entered = core.enterFieldValue(FIELD_IDS.amount, '-1');
      expect(entered.ok && entered.problems.map((p) => p.code)).toEqual(['min']);
      await until(
        () => traffic.acks + [...traffic.rejects.values()].reduce((a, b) => a + b, 0) === 1,
        'the room answers',
      );
      // Whether the authority refuses a limit at commit time is open (FRW-004 Notes). Today the
      // room stores a correctly typed value, and completion checks the limits (FRW-047).
      expect(traffic.acks).toBe(1);
      expect(await stored(FIELD_IDS.amount)).toBe('-1');
      expect(core.fieldEntry(FIELD_IDS.amount)).toMatchObject({ value: '-1' });
      expect(codes(core, FIELD_IDS.amount)).toEqual(['min']);
      expect(reported(core)).toContain('tenant.amount');
    } finally {
      detach();
    }
  });
});
