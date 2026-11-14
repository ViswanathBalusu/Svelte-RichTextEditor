// Audit entries for region state changes, lease breaks, session revocations, restores and workflow
// transitions (PRM-052). The builder is tested here; the host stores the change and its control
// commit, so PRM-052 criteria 1, 2, 5 and the "when it commits" half of 3 to 5 are not tested here.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONTROL_AUDIT_KEYS, CONTROL_AUDIT_KINDS, controlAudit } from '../src/index.ts';

const identifier = fc.stringMatching(/^[A-Za-z0-9_.:-]{1,40}$/);
const scopeArb = fc.oneof(
  fc.stringMatching(/^region:[a-z0-9]{1,12}$/),
  fc.constantFrom('doc', 'body', 'defs'),
);

const kindArb = fc.constantFrom(...CONTROL_AUDIT_KINDS);

/** Inputs that the builder must accept: every kind with the fields it requires. */
const validInputArb = fc
  .record({
    kind: kindArb,
    actor: identifier,
    agent: fc.option(identifier, { nil: undefined }),
    document: fc.option(identifier, { nil: undefined }),
    scopes: fc.array(scopeArb, { maxLength: 5 }),
    subject: fc.option(identifier, { nil: undefined }),
    commit: fc.option(identifier, { nil: undefined }),
    seq: fc.option(fc.nat({ max: 1_000_000 }), { nil: undefined }),
    time: fc.nat({ max: 4_000_000_000_000 }),
  })
  .map((r) => {
    // Give each kind the fields it requires, so that a valid input is generated for every kind.
    const subject = r.kind === 'restore' ? r.subject : (r.subject ?? 'subject-1');
    const scopes =
      r.kind === 'session.revoke' ? r.scopes : r.scopes.length ? r.scopes : ['region:r1'];
    return { ...r, subject, scopes };
  });

describe('controlAudit (PRM-052)', () => {
  it('builds an entry that holds only the allowed identifiers and numbers (property)', () => {
    fc.assert(
      fc.property(validInputArb, (input) => {
        const entry = controlAudit(input);
        for (const key of Object.keys(entry)) expect(CONTROL_AUDIT_KEYS).toContain(key);
        expect(entry.kind).toBe(input.kind);
        expect(entry.actor).toBe(input.actor);
        expect(entry.time).toBe(input.time);
        expect(entry.scopes).toEqual([...new Set(input.scopes)].sort());
      }),
      { numRuns: 500 },
    );
  });

  it('sorts the scopes and removes duplicates, so the same change gives the same entry (property)', () => {
    fc.assert(
      fc.property(validInputArb, fc.array(scopeArb, { maxLength: 6 }), (input, extra) => {
        const a = controlAudit({ ...input, scopes: [...input.scopes, ...extra] });
        const b = controlAudit({ ...input, scopes: [...extra, ...input.scopes].reverse() });
        expect(a.scopes).toEqual(b.scopes);
        expect(new Set(a.scopes).size).toBe(a.scopes.length);
        expect([...a.scopes]).toEqual([...a.scopes].sort());
      }),
      { numRuns: 300 },
    );
  });

  it('refuses every kind that is not audited (property)', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 30 })
          .filter((k) => !(CONTROL_AUDIT_KINDS as readonly string[]).includes(k)),
        (kind) => {
          expect(() =>
            controlAudit({ kind, actor: 'u1', scopes: ['region:r1'], subject: 's', time: 1 }),
          ).toThrow(RangeError);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses a missing or empty actor, a bad time and a bad seq (property)', () => {
    fc.assert(
      fc.property(validInputArb, fc.integer({ min: -1_000_000, max: -1 }), (input, negative) => {
        expect(() => controlAudit({ ...input, actor: '' })).toThrow(RangeError);
        expect(() => controlAudit({ ...input, actor: 'has space' })).toThrow(RangeError);
        expect(() => controlAudit({ ...input, time: negative })).toThrow(RangeError);
        expect(() => controlAudit({ ...input, time: 1.5 })).toThrow(RangeError);
        expect(() => controlAudit({ ...input, seq: negative })).toThrow(RangeError);
      }),
      { numRuns: 300 },
    );
  });

  it('refuses identifiers that hold a control character or whitespace, and longer than 255', () => {
    const controls = [0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x85, 0x9f].map((c) => String.fromCharCode(c));
    for (const c of controls) {
      expect(() =>
        controlAudit({ kind: 'restore', actor: `u${c}1`, scopes: ['region:r1'], time: 1 }),
      ).toThrow(RangeError);
      expect(() =>
        controlAudit({
          kind: 'restore',
          actor: 'u1',
          commit: `c${c}`,
          scopes: ['region:r1'],
          time: 1,
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      controlAudit({ kind: 'restore', actor: 'u 1', scopes: ['region:r1'], time: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      controlAudit({ kind: 'restore', actor: 'a'.repeat(256), scopes: ['region:r1'], time: 1 }),
    ).toThrow(RangeError);
    expect(
      controlAudit({ kind: 'restore', actor: 'a'.repeat(255), scopes: ['region:r1'], time: 1 })
        .actor,
    ).toHaveLength(255);
    expect(
      controlAudit({ kind: 'restore', actor: 'ü-用户', scopes: ['region:r1'], time: 1 }).actor,
    ).toBe('ü-用户');
  });

  it('requires the subject for a lease break, a state change, a revocation and a transition', () => {
    for (const kind of [
      'region.state',
      'lease.break',
      'session.revoke',
      'workflow.transition',
    ] as const) {
      expect(() => controlAudit({ kind, actor: 'u1', scopes: ['region:r1'], time: 1 })).toThrow(
        /names no subject/,
      );
    }
  });

  it('requires at least one scope for a state change, a lease break, a restore and a transition', () => {
    for (const kind of ['region.state', 'lease.break', 'restore', 'workflow.transition'] as const) {
      expect(() => controlAudit({ kind, actor: 'u1', subject: 's', scopes: [], time: 1 })).toThrow(
        /names no scope/,
      );
    }
  });

  it('lets a session revocation name no scope and records the document when one is given', () => {
    const entry = controlAudit({
      kind: 'session.revoke',
      actor: 'admin',
      subject: 'user-9',
      document: 'doc-1',
      time: 42,
    });
    expect(entry).toEqual({
      kind: 'session.revoke',
      actor: 'admin',
      document: 'doc-1',
      scopes: [],
      subject: 'user-9',
      time: 42,
    });
  });

  it('records the agent, the control commit and the seq only when they are given', () => {
    const bare = controlAudit({ kind: 'restore', actor: 'u1', scopes: ['region:r1'], time: 1 });
    expect(Object.keys(bare)).not.toContain('agent');
    expect(Object.keys(bare)).not.toContain('commit');
    expect(Object.keys(bare)).not.toContain('seq');
    const full = controlAudit({
      kind: 'restore',
      actor: 'u1',
      agent: 'assistant-7',
      scopes: ['region:r1'],
      commit: 'c-9',
      seq: 12,
      time: 1,
    });
    expect(full).toMatchObject({ agent: 'assistant-7', commit: 'c-9', seq: 12 });
  });
});
