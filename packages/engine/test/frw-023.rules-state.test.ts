/**
 * FRW-023 in the editing core, in Node.js (lane w4): the rules of the document are evaluated for the
 * document as it stands, so that a field appears and disappears, becomes required, shows a message
 * and shows a computed value as a participant fills, without a reload. The count of required fields
 * ("n of m") and the order of the next field follow. The controls on the page are in
 * `src/view/frw-023-rules-controls.universal.test.ts` (Chromium, Firefox, WebKit).
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { participantAccess } from './frw-fields-fixture.ts';
import { RULE_FIELD_IDS as ID, ruleDocument } from './frw-023-fixture.ts';
import { microtask } from './support.ts';

function participant() {
  return new DocumentCore({
    doc: ruleDocument(),
    access: participantAccess(['role_tenant']),
    mode: 'fill',
    schedule: microtask,
  });
}

/** The participant's own required fields, as the guided bar counts them (`fillProgress`). */
function progress(c: DocumentCore) {
  const own = c.fillFields().filter((f) => f.assignee === 'role_tenant');
  const required = own.filter((f) => f.required);
  return {
    total: required.length,
    done: required.filter((f) => f.filled && f.invalid === null).length,
    next: required.find((f) => !f.filled || f.invalid !== null)?.id ?? null,
  };
}

describe('a field a rule shows or hides (FRW-023 criterion 1)', () => {
  it('hides the spouse until the name is Ada, and the count and the next field follow', () => {
    const c = participant();
    // Hidden: not fillable, not required, not in the count.
    expect(c.fieldRuleState(ID.spouse)).toMatchObject({ visible: false, required: false });
    expect(c.fieldFillable(ID.spouse)).toBe(false);
    expect(progress(c)).toEqual({ total: 1, done: 0, next: ID.email });

    c.enterFieldValue(ID.name, 'Ada');
    expect(c.fieldRuleState(ID.spouse)).toMatchObject({ visible: true, required: true });
    expect(c.fieldFillable(ID.spouse)).toBe(true);
    expect(progress(c)).toEqual({ total: 2, done: 0, next: ID.email });

    // The next field after the email is the spouse, in document order.
    c.enterFieldValue(ID.email, 'ada@example.org');
    expect(progress(c)).toEqual({ total: 2, done: 1, next: ID.spouse });

    // Another name hides it again, and the count drops it.
    c.enterFieldValue(ID.name, 'Bob');
    expect(c.fieldRuleState(ID.spouse)).toMatchObject({ visible: false });
    expect(progress(c)).toEqual({ total: 1, done: 1, next: null });
  });

  it('is evaluated once for each version of the document', () => {
    const c = participant();
    const a = c.fieldRuleState(ID.spouse);
    expect(c.fieldRuleState(ID.spouse)).toBe(a);
    c.enterFieldValue(ID.name, 'Ada');
    expect(c.fieldRuleState(ID.spouse)).not.toBe(a);
  });
});

describe('a field a rule requires (FRW-023 criterion 2)', () => {
  it('requires the spouse once shown, and the other fields keep their own requirement', () => {
    const c = participant();
    c.enterFieldValue(ID.name, 'Ada');
    expect(c.fieldRuleState(ID.spouse)?.required).toBe(true);
    const status = Object.fromEntries(c.fillFields().map((f) => [f.id, f.required]));
    expect(status[ID.spouse]).toBe(true);
    expect(status[ID.email]).toBe(true);
    expect(status[ID.amount]).toBe(false);
  });
});

describe('enable and disable (FRW-023 criterion 2)', () => {
  it('makes a field read-only while a rule disables it, and editable again after', () => {
    const c = participant();
    expect(c.fieldFillable(ID.email)).toBe(true);
    c.enterFieldValue(ID.amount, '99');
    expect(c.fieldRuleState(ID.email)).toMatchObject({ visible: true, enabled: false });
    expect(c.fieldFillable(ID.email)).toBe(false);
    c.enterFieldValue(ID.amount, '50');
    expect(c.fieldRuleState(ID.email)?.enabled).toBe(true);
    expect(c.fieldFillable(ID.email)).toBe(true);
  });
});

describe('a validate effect (FRW-023 criterion 3)', () => {
  it('has a message while its condition fails, and none once it holds', () => {
    const c = participant();
    c.enterFieldValue(ID.amount, '5');
    expect(c.fieldRuleState(ID.amount)?.messages).toEqual(['Enter at least 10.']);
    expect(c.fillFields().find((f) => f.id === ID.amount)?.invalid).toBe('other');
    c.enterFieldValue(ID.amount, '20');
    expect(c.fieldRuleState(ID.amount)?.messages).toEqual([]);
    expect(c.fillFields().find((f) => f.id === ID.amount)?.invalid).toBeNull();
  });
});

describe('a computed field (FRW-023 criterion 4)', () => {
  it('shows twice the amount as it changes, and cannot be filled', () => {
    const c = participant();
    expect(c.fieldRuleState(ID.total)).toMatchObject({ computed: true, value: null });
    c.enterFieldValue(ID.amount, '12.50');
    expect(c.fieldRuleState(ID.total)?.value).toBe('25');
    c.enterFieldValue(ID.amount, '20');
    expect(c.fieldRuleState(ID.total)?.value).toBe('40');
    expect(c.fieldFillable(ID.total)).toBe(false);
    // The stored value is not written by the editor: the field's value stays empty.
    expect(c.fieldEntry(ID.total)?.stored).toBeNull();
  });
});

describe('a document without rules', () => {
  it('has no rule state, and the fields are as authored', async () => {
    const {
      fieldsDocument,
      participantAccess: access,
      FIELD_IDS,
    } = await import('./frw-fields-fixture.ts');
    const c = new DocumentCore({
      doc: fieldsDocument(),
      access: access(['role_tenant']),
      mode: 'fill',
      schedule: microtask,
    });
    expect(c.fieldRuleState(FIELD_IDS.name)).toBeNull();
    expect(c.fieldFillable(FIELD_IDS.name)).toBe(true);
  });
});
