// The authority-side conditions of the sign endpoint (12 §8.1 step 3; FRW-046): which field a
// participant may sign, which dateSigned fields one signing sets, and the date in the workflow's
// time zone that a dateSigned field receives.
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { FillContext } from '../src/permissions/registry.ts';
import {
  checkSign,
  checkSignConditions,
  fieldsToDateSign,
  signedDate,
  type SignConditions,
} from '../src/permissions/sign.ts';
import type { FieldChange } from '../src/permissions/scopes.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { FIELDS, MORE, USERS, fieldsDoc, morePermissions } from './permission-fixtures.ts';

type Conn = (typeof USERS)[keyof typeof USERS];

function fieldOf(doc: Node, id: string): FieldChange {
  const found: Node[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'form_field' && n.attrs['id'] === id) found.push(n);
    return true;
  });
  const node = found[0];
  if (!node) throw new Error(`no field ${id}`);
  return { id, container: 'body', before: null, after: null, node };
}

function ctxFor(
  user: Conn,
  doc: Node,
  fieldEnabled: FillContext['fieldEnabled'] | 'absent' = () => true,
): FillContext {
  const ctx: FillContext = {
    user: user.sub,
    access: computeAccess(user, regionInfos(doc), morePermissions(), 0),
    perms: morePermissions(),
    after: doc,
  };
  if (fieldEnabled !== 'absent') ctx.fieldEnabled = fieldEnabled;
  return ctx;
}

describe('the sign endpoint checks the P7 conditions and the kind (FRW-046)', () => {
  it('accepts a signature and an initials field assigned to the signer role', () => {
    const doc = fieldsDoc();
    const ctx = ctxFor(USERS.erin, doc);
    expect(checkSign(fieldOf(doc, FIELDS.signature), ctx)).toEqual({ ok: true });
    expect(checkSign(fieldOf(doc, FIELDS.initials), ctx)).toEqual({ ok: true });
  });

  it('refuses every field that is not a signature or initials field', () => {
    const doc = fieldsDoc();
    const ctx = ctxFor(USERS.erin, doc);
    for (const id of [FIELDS.number, FIELDS.date, FIELDS.dateSigned, FIELDS.formula]) {
      const v = checkSign(fieldOf(doc, id), ctx);
      expect(v.ok, id).toBe(false);
      if (!v.ok) expect(v.reason).toBe('only a signature or initials field is signed');
    }
  });

  it('refuses a field of another role, however the participant is active', () => {
    const doc = fieldsDoc();
    const v = checkSign(fieldOf(doc, FIELDS.signature), ctxFor(MORE.lena, doc));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('the field is not assigned to one of your roles');
  });

  it('refuses a participant who is not active in the workflow', () => {
    const doc = fieldsDoc();
    const inactive = { ...USERS.erin, participantActive: false } as Conn;
    const v = checkSign(fieldOf(doc, FIELDS.signature), ctxFor(inactive, doc));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('your participant is not active in the workflow');
  });

  it('refuses a field the rules hide or disable, and one whose visibility is not known', () => {
    const doc = fieldsDoc();
    const field = fieldOf(doc, FIELDS.signature);
    const hidden = checkSign(
      field,
      ctxFor(USERS.erin, doc, () => false),
    );
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.reason).toBe('the field is hidden or disabled by the rules');
    const unknown = checkSign(field, ctxFor(USERS.erin, doc, 'absent'));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toMatch(/not known to be visible and enabled/);
  });

  it('refuses without `fill` in the document, as the P7 conditions do', () => {
    const doc = fieldsDoc();
    const v = checkSign(fieldOf(doc, FIELDS.signature), ctxFor(USERS.alice, doc));
    expect(v.ok).toBe(false);
  });
});

describe('the dateSigned fields one signing sets (FRW-046)', () => {
  it('lists the dateSigned fields of the signing role and no other', () => {
    const doc = fieldsDoc();
    expect(fieldsToDateSign(doc, 'role_tenant')).toEqual([FIELDS.dateSigned]);
    expect(fieldsToDateSign(doc, 'role_landlord')).toEqual([]);
    expect(fieldsToDateSign(doc, 'role_nobody')).toEqual([]);
  });
});

describe('a dateSigned value is the date in the workflow time zone (FRW-046 criterion 7)', () => {
  // 2026-11-06 23:30 UTC is already 7 November in Tokyo and still 6 November in Los Angeles.
  const instant = Date.UTC(2026, 10, 6, 23, 30);

  it('takes the date in the workflow time zone, not in UTC or the server zone', () => {
    expect(signedDate(instant, 'Asia/Tokyo')).toBe('2026-11-07');
    expect(signedDate(instant, 'America/Los_Angeles')).toBe('2026-11-06');
    expect(signedDate(instant, 'UTC')).toBe('2026-11-06');
  });

  it('refuses a time zone the platform does not know, and an instant that is not finite', () => {
    expect(() => signedDate(instant, 'Not/AZone')).toThrow(RangeError);
    expect(() => signedDate(Number.NaN, 'UTC')).toThrow(RangeError);
  });

  it('agrees with the UTC calendar date for every instant when the zone is UTC', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(2100, 0, 1) }),
        (t) => signedDate(t, 'UTC') === new Date(t).toISOString().slice(0, 10),
      ),
      { numRuns: 300 },
    );
  });

  it('is always a calendar date of the form YYYY-MM-DD in any zone', () => {
    const zones = ['Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(2100, 0, 1) }),
        fc.constantFrom(...zones),
        (t, zone) => /^\d{4}-\d{2}-\d{2}$/.test(signedDate(t, zone)),
      ),
      { numRuns: 300 },
    );
  });
});

describe('the conditions the sign endpoint checks without a commit (FRW-046 criteria 2 and 6)', () => {
  const ok: SignConditions = {
    kind: 'signature',
    assignee: 'tenant',
    readOnly: false,
    participantRoles: ['tenant'],
    active: true,
    enabled: true,
  };
  const refusal = (c: Partial<SignConditions>) => {
    const v = checkSignConditions({ ...ok, ...c });
    return v.ok ? null : v.reason;
  };

  it('allows an active participant to sign an enabled signature or initials field of their role', () => {
    expect(checkSignConditions(ok)).toEqual({ ok: true });
    expect(checkSignConditions({ ...ok, kind: 'initials' })).toEqual({ ok: true });
  });

  it('refuses each condition that fails, and names it', () => {
    expect(refusal({ kind: 'text' })).toContain('only a signature or initials');
    expect(refusal({ kind: 'dateSigned' })).toContain('only a signature or initials');
    expect(refusal({ assignee: 'landlord' })).toContain('role the participant does not hold');
    expect(refusal({ assignee: null })).toContain('role the participant does not hold');
    expect(refusal({ participantRoles: [] })).toContain('role the participant does not hold');
    expect(refusal({ active: false })).toContain('not active');
    expect(refusal({ readOnly: true })).toContain('read-only');
    expect(refusal({ enabled: false })).toContain('hidden or disabled');
  });

  it('allows a signing only when every condition holds (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('signature', 'initials', 'text', 'dateSigned'),
        fc.constantFrom('tenant', 'landlord', null),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (kind, assignee, readOnly, active, enabled) => {
          const v = checkSignConditions({
            kind,
            assignee,
            readOnly,
            participantRoles: ['tenant'],
            active,
            enabled,
          });
          const all =
            (kind === 'signature' || kind === 'initials') &&
            assignee === 'tenant' &&
            !readOnly &&
            active &&
            enabled;
          expect(v.ok).toBe(all);
        },
      ),
    );
  });
});
