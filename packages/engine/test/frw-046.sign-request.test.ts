// FRW-046 criterion 1, the core's half: a signature or initials field the participant may sign can
// be activated, and the activation is a request the shell turns into the signing step. Which fields
// are signable is the client's reading of the P7 conditions (the server decides): the field's kind,
// its role, an active participant, no read-only mark and no rule that hides or disables it.
import { DocumentCore } from '@docedit/engine/headless';
import { describe, expect, it } from 'vitest';
import { participantAccess } from './frw-fields-fixture.ts';
import {
  INITIALS_TENANT,
  SIGN_LANDLORD,
  SIGN_READONLY,
  SIGN_TENANT,
  TEXT_FIELD,
  withSignatures,
} from './frw-046-fixture.ts';
import { microtask } from './support.ts';

function core(roles: readonly string[], active = true, rule = false) {
  return new DocumentCore({
    doc: withSignatures(rule),
    mode: 'fill',
    access: participantAccess(roles, active),
    schedule: microtask,
  });
}

describe('which fields a participant may sign (FRW-046 criterion 1)', () => {
  it('allows a signature or initials field of a role the active participant holds', () => {
    const c = core(['role_tenant']);
    expect(c.fieldSignable(SIGN_TENANT)).toBe(true);
    expect(c.fieldSignable(INITIALS_TENANT)).toBe(true);
  });

  it('refuses a field of another role, a read-only one, a field of another kind and an unknown id', () => {
    const c = core(['role_tenant']);
    expect(c.fieldSignable(SIGN_LANDLORD)).toBe(false);
    expect(c.fieldSignable(SIGN_READONLY)).toBe(false);
    expect(c.fieldSignable(TEXT_FIELD)).toBe(false);
    expect(c.fieldSignable('nosuchfield00000')).toBe(false);
  });

  it('refuses a participant who is not active, and a reader who holds no role', () => {
    expect(core(['role_tenant'], false).fieldSignable(SIGN_TENANT)).toBe(false);
    expect(core([]).fieldSignable(SIGN_TENANT)).toBe(false);
  });

  it('refuses a field that a rule hides', () => {
    // The amount is empty, so the rule hides the tenant's signature; the initials stay.
    const c = core(['role_tenant'], true, true);
    expect(c.fieldSignable(SIGN_TENANT)).toBe(false);
    expect(c.fieldSignable(INITIALS_TENANT)).toBe(true);
  });
});

describe('activating a field is a request for the signing step (FRW-046 criterion 1)', () => {
  it('names the field, its kind, its label and the role by the name the document gives it', () => {
    const c = core(['role_tenant']);
    expect(c.signRequest.get()).toBeNull();
    expect(c.requestSign(SIGN_TENANT)).toBe(true);
    expect(c.signRequest.get()).toEqual({
      n: 1,
      id: SIGN_TENANT,
      key: 'tenant.signature',
      kind: 'signature',
      label: 'Tenant signature',
      role: 'Tenant',
    });
    // The initials field's label is its key when it has none of its own.
    expect(c.requestSign(INITIALS_TENANT)).toBe(true);
    expect(c.signRequest.get()).toMatchObject({ n: 2, kind: 'initials', role: 'Tenant' });
  });

  it('counts a second activation of the same field as a request of its own, and clears', () => {
    const c = core(['role_tenant']);
    c.requestSign(SIGN_TENANT);
    c.requestSign(SIGN_TENANT);
    expect(c.signRequest.get()?.n).toBe(2);
    c.clearSignRequest();
    expect(c.signRequest.get()).toBeNull();
  });

  it('makes no request for a field that may not be signed', () => {
    const c = core(['role_tenant']);
    expect(c.requestSign(SIGN_LANDLORD)).toBe(false);
    expect(c.requestSign(TEXT_FIELD)).toBe(false);
    expect(c.signRequest.get()).toBeNull();
  });
});
