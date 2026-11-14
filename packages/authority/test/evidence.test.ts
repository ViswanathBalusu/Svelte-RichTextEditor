// Salted commitments to workflow evidence (12 §7; FRW-041): a control commit carries only the salted
// hash of its evidence, and a verifier who holds the evidence and the salt recomputes it.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SALT_BYTES,
  commitEvidence,
  controlCommitEvidence,
  newEvidenceSalt,
  verifyEvidence,
} from '../src/workflow/evidence.ts';

const salt = fc.uint8Array({ minLength: SALT_BYTES, maxLength: SALT_BYTES });
const text = fc.string({ minLength: 1, maxLength: 60 });

describe('a control commit carries only salted hashes of its evidence (FRW-041)', () => {
  it('builds the payload from the origin and the hash, never the evidence or the salt', async () => {
    const canonical = '{"name":"Ada Lovelace","signedAt":"2026-11-06T10:00:00Z"}';
    const s = newEvidenceSalt();
    const payload = await controlCommitEvidence('sign', canonical, s);
    expect(Object.keys(payload).sort()).toEqual(['evidenceHash', 'origin']);
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('Ada Lovelace');
    expect(wire).not.toContain('signedAt');
    expect(wire).not.toContain(Buffer.from(s).toString('hex'));
    expect(payload.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives a completion commit the origin rules and the same hash rule', async () => {
    const s = newEvidenceSalt();
    const p = await controlCommitEvidence('rules', 'completed', s);
    expect(p.origin).toBe('rules');
    expect(p.evidenceHash).toBe(await commitEvidence('completed', s));
  });

  it('computes SHA-256 over the salt followed by the UTF-8 evidence text (property)', async () => {
    await fc.assert(
      fc.asyncProperty(text, salt, async (canonical, s) => {
        const expected = createHash('sha256')
          .update(Buffer.concat([Buffer.from(s), Buffer.from(canonical, 'utf8')]))
          .digest('hex');
        return (await commitEvidence(canonical, s)) === expected;
      }),
      { numRuns: 100 },
    );
  });
});

describe('a verifier recomputes the commitment from the evidence and the salt (FRW-041)', () => {
  it('accepts the evidence with its salt and refuses any other evidence or salt (property)', async () => {
    await fc.assert(
      fc.asyncProperty(text, text, salt, salt, async (a, b, s, t) => {
        const c = await commitEvidence(a, s);
        if (!(await verifyEvidence(a, s, c))) return false;
        if (a !== b && (await verifyEvidence(b, s, c))) return false;
        if (!Buffer.from(s).equals(Buffer.from(t)) && (await verifyEvidence(a, t, c))) return false;
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('refuses a malformed commitment and a salt shorter than the minimum', async () => {
    const s = newEvidenceSalt();
    expect(await verifyEvidence('x', s, 'not-a-hash')).toBe(false);
    await expect(commitEvidence('x', new Uint8Array(4))).rejects.toThrow(RangeError);
  });

  it('draws a salt of the fixed length, and two salts differ', () => {
    const a = newEvidenceSalt();
    const b = newEvidenceSalt();
    expect(a.length).toBe(SALT_BYTES);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
