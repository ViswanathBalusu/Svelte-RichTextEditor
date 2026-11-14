// The builder of the audit entry for a refused commit (PRM-051 criteria 1 and 2): a commit refused
// with `permission_denied` or `invalid_op` gives one entry with the actor, the document, the scopes
// and the server time; any other code gives none. The room does not call the builder: the document
// service builds the entry from each `sync.reject` it answers with, and its tests show the entry
// reaching the audit store (`services/document-service/src/data-plane/audit.test.ts`).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AUDITED_REJECTION_CODES, rejectionAudit } from '../src/permissions/audit.ts';

const DOC = 'doc-audit-1';
const T = 1_700_000_000_000;
const REJECTS = [
  'permission_denied',
  'invalid_op',
  'busy',
  'read_only',
  'too_large',
  'conflict',
] as const;

describe('rejectionAudit (PRM-051)', () => {
  it('audits only permission_denied and invalid_op, whatever the other inputs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REJECTS),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (code, actor, head, time) => {
          const entry = rejectionAudit({ code, actor, commit: 'c1', head, time });
          const audited = (AUDITED_REJECTION_CODES as readonly string[]).includes(code);
          expect(entry !== null).toBe(audited);
        },
      ),
    );
  });

  it('builds the entry with the actor, document, scopes, head and time, and copies the scopes', () => {
    const scopes = ['region:R1', 'field:F1'];
    const entry = rejectionAudit({
      code: 'permission_denied',
      actor: 'frank',
      agent: 'assistant-1',
      document: DOC,
      scopes,
      commit: 'c1',
      head: 4,
      time: T,
    });
    expect(entry).toEqual({
      kind: 'commit.rejected',
      code: 'permission_denied',
      actor: 'frank',
      agent: 'assistant-1',
      document: DOC,
      scopes: ['region:R1', 'field:F1'],
      commit: 'c1',
      head: 4,
      time: T,
    });
    scopes.push('region:R2');
    expect(entry?.scopes).toEqual(['region:R1', 'field:F1']);
  });

  it('refuses an entry that is not usable rather than storing it half-formed', () => {
    expect(() =>
      rejectionAudit({ code: 'invalid_op', actor: '', commit: 'c', head: 0, time: T }),
    ).toThrow(RangeError);
    expect(() =>
      rejectionAudit({ code: 'invalid_op', actor: 'a', commit: 'c', head: -1, time: T }),
    ).toThrow(RangeError);
    expect(() =>
      rejectionAudit({ code: 'invalid_op', actor: 'a', commit: 'c', head: 0, time: 1.5 }),
    ).toThrow(RangeError);
  });
});
