// The participant list of the workflow resource (FRW-025 criterion 4: only the kinds filler, signer,
// approver and cc are accepted; the order rules are checked with order.ts in frw-026.participants.test.ts).
// Property tests over the input; pure functions only.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PARTICIPANT_KINDS, checkParticipants } from '../src/workflow/resource.ts';

const valid = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  roles: ['role_tenant'],
  kind: 'signer',
  order: 1,
  ...overrides,
});

describe('participant kinds (FRW-025 criterion 4)', () => {
  it('accepts exactly the four kinds of 12 section 6.1', () => {
    expect([...PARTICIPANT_KINDS]).toEqual(['filler', 'signer', 'approver', 'cc']);
    for (const kind of PARTICIPANT_KINDS) {
      const r = checkParticipants([valid({ kind })]);
      expect(r).toMatchObject({ ok: true, participants: [{ kind }] });
    }
  });

  it('refuses every other string as a kind, with the position of the participant', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !(PARTICIPANT_KINDS as readonly string[]).includes(s)),
        (kind) => {
          const r = checkParticipants([valid(), valid({ id: 'p2', kind })]);
          expect(r).toEqual({
            ok: false,
            problems: [{ index: 1, member: 'kind', reason: 'invalid_kind' }],
          });
        },
      ),
    );
  });

  it('refuses the names of roles and of case variants of a kind', () => {
    for (const kind of ['viewer', 'owner', 'reader', 'fill', 'sign', 'Signer', 'SIGNER', ' cc']) {
      expect(checkParticipants([valid({ kind })])).toMatchObject({
        ok: false,
        problems: [{ member: 'kind', reason: 'invalid_kind' }],
      });
    }
  });
});

describe('the participant members (FRW-026 criterion 4, the rule part)', () => {
  it('refuses a contact detail: an e-mail address or a telephone number is an unknown member', () => {
    for (const member of ['email', 'emailAddress', 'telephone', 'phone', 'mobile']) {
      expect(checkParticipants([valid({ [member]: 'someone@example.test' })])).toEqual({
        ok: false,
        problems: [{ index: 0, member, reason: 'unknown_member' }],
      });
    }
  });

  it('refuses a completion written by the caller: `completed` is the workflow own state', () => {
    expect(checkParticipants([valid({ completed: true })])).toMatchObject({
      ok: false,
      problems: [{ member: 'completed', reason: 'unknown_member' }],
    });
  });

  it('keeps sub and name as the only identifying members, and copies them when given', () => {
    const r = checkParticipants([valid({ sub: 'ext:7f3a', name: 'A. Tenant' })]);
    expect(r).toEqual({
      ok: true,
      participants: [
        {
          id: 'p1',
          roles: ['role_tenant'],
          kind: 'signer',
          order: 1,
          sub: 'ext:7f3a',
          name: 'A. Tenant',
        },
      ],
    });
  });
});

describe('order and roles of a participant (FRW-025 criterion 4, FRW-026 criterion 1)', () => {
  it('accepts every safe integer of at least 1 as an order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (order) => {
        expect(checkParticipants([valid({ order })]).ok).toBe(true);
      }),
    );
  });

  it('refuses an order that is zero, negative, fractional, not finite or beyond the safe integers', () => {
    const bad = fc.oneof(
      fc.integer({ min: -1000, max: 0 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', null),
    );
    fc.assert(
      fc.property(bad, (order) => {
        expect(checkParticipants([valid({ order })])).toMatchObject({
          ok: false,
          problems: [{ member: 'order', reason: 'invalid_order' }],
        });
      }),
    );
  });

  it('refuses a participant with no role, a role twice, or a role that is not a non-empty string', () => {
    expect(checkParticipants([valid({ roles: [] })])).toMatchObject({
      problems: [{ member: 'roles', reason: 'invalid_roles' }],
    });
    expect(checkParticipants([valid({ roles: ['role_a', 'role_a'] })])).toMatchObject({
      problems: [{ member: 'roles', reason: 'invalid_roles' }],
    });
    expect(checkParticipants([valid({ roles: ['role_a', ''] })])).toMatchObject({
      problems: [{ member: 'roles', reason: 'invalid_roles' }],
    });
  });

  it('keeps every role of a person who holds two roles, in the order given', () => {
    const r = checkParticipants([valid({ roles: ['role_tenant', 'role_guarantor'] })]);
    expect(r).toMatchObject({
      ok: true,
      participants: [{ roles: ['role_tenant', 'role_guarantor'] }],
    });
  });
});

describe('the list as a whole', () => {
  it('refuses two participants with the same identifier, and reports every problem at once', () => {
    const r = checkParticipants([valid(), valid({ kind: 'viewer' }), valid({ order: 0 })]);
    expect(r).toEqual({
      ok: false,
      problems: [
        { index: 1, member: 'id', reason: 'duplicate_id' },
        { index: 1, member: 'kind', reason: 'invalid_kind' },
        { index: 2, member: 'id', reason: 'duplicate_id' },
        { index: 2, member: 'order', reason: 'invalid_order' },
      ],
    });
  });

  it('refuses a value that is not a list, and a participant that is not an object', () => {
    expect(checkParticipants({ id: 'p1' })).toEqual({
      ok: false,
      problems: [{ index: -1, member: null, reason: 'not_a_list' }],
    });
    expect(checkParticipants(['x'])).toEqual({
      ok: false,
      problems: [{ index: 0, member: null, reason: 'not_an_object' }],
    });
  });

  it('never throws on any JSON value', () => {
    const json = fc.jsonValue();
    fc.assert(
      fc.property(json, (value) => {
        const r = checkParticipants(value);
        expect(typeof r.ok).toBe('boolean');
      }),
    );
  });

  it('accepts an empty list (a draft with no participants)', () => {
    expect(checkParticipants([])).toEqual({ ok: true, participants: [] });
  });
});
