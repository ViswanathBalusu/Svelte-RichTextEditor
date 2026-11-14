/**
 * SEC-044: evidence stays outside the log. Two parts of the workflow evidence module are proved here,
 * the parts that exist in the repository:
 *
 * - the chain part (criterion 4's shape and criterion 1's chain half): the control commit that a
 *   signing or a completion writes carries only its origin and a salted hash, never the evidence,
 *   the salt or the text the hash covers (packages/authority/src/workflow/evidence.ts);
 * - the purge decision (criterion 5): a legal hold keeps every evidence row past its retention
 *   period until the hold is lifted (packages/authority/src/workflow/retention.ts, `planPurge`).
 *
 * Not proved here: the scan of the commit log, the audit trail, the logs and the search entries for
 * IP addresses, user agents, `amr` and signature images (criterion 1 needs the stored log and the
 * workflow tables); the hash chain still verifying after the deletion of expired evidence
 * (criterion 2); the tenant switch that stops IP and user-agent capture (criterion 3); and the purge
 * job that deletes the rows (`planPurge` deletes nothing). Criterion 4 reads the salt out of the
 * stored chain, which is not built; the payload checked below is the only part of the chain written.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  commitEvidence,
  controlCommitEvidence,
  newEvidenceSalt,
  SALT_BYTES,
  verifyEvidence,
} from '../../../packages/authority/src/workflow/evidence.ts';
import { planPurge, type EvidenceRow } from '../../../packages/authority/src/workflow/retention.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('SEC-044 (chain part): the control commit holds a salted hash and nothing of the evidence', () => {
  it('the payload has exactly the origin and the hash, and no salt, evidence or identifying text', async () => {
    const salt = newEvidenceSalt();
    const canonical =
      'ip=203.0.113.7\nua=Mozilla/5.0 (X11; Linux x86_64)\namr=pwd\nconsent=I agree';
    const payload = await controlCommitEvidence('sign', canonical, salt);

    expect(Object.keys(payload).sort()).toEqual(['evidenceHash', 'origin']);
    expect(payload.origin).toBe('sign');
    expect(payload.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(payload);
    expect(text).not.toContain(hex(salt));
    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain('Mozilla');
    expect(text).not.toContain('amr');
    expect(text).not.toContain('I agree');
  });

  it('for any IP address and any salt, the payload carries neither the address nor the salt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.ipV4(),
        fc.uint8Array({ minLength: SALT_BYTES, maxLength: SALT_BYTES }),
        async (ip, salt) => {
          const canonical = `ip=${ip}\nconsent=recorded`;
          const payload = await controlCommitEvidence('rules', canonical, salt);
          const text = JSON.stringify(payload);
          expect(text).not.toContain(ip);
          expect(text).not.toContain(hex(salt));
          expect(text).not.toContain('consent');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('the commitment is bound to the salt and the text: only the right pair verifies', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 200 }),
        fc.uint8Array({ minLength: SALT_BYTES, maxLength: SALT_BYTES }),
        fc.uint8Array({ minLength: SALT_BYTES, maxLength: SALT_BYTES }),
        async (canonical, salt, otherSalt) => {
          const commitment = await commitEvidence(canonical, salt);
          expect(await verifyEvidence(canonical, salt, commitment)).toBe(true);
          expect(await verifyEvidence(canonical + '!', salt, commitment)).toBe(false);
          if (hex(otherSalt) !== hex(salt))
            expect(await verifyEvidence(canonical, otherSalt, commitment)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('each salt is 128 bits drawn fresh, and a short salt is refused', async () => {
    const a = newEvidenceSalt();
    const b = newEvidenceSalt();
    expect(a.length).toBe(SALT_BYTES);
    expect(SALT_BYTES).toBe(16);
    expect(hex(a)).not.toBe(hex(b));
    await expect(commitEvidence('x', new Uint8Array(8))).rejects.toBeInstanceOf(RangeError);
  });
});

describe('SEC-044 criterion 5: a legal hold keeps evidence past its retention period', () => {
  const rows: EvidenceRow[] = [
    { id: 'row-a', collectedAtMs: 0 },
    { id: 'row-b', collectedAtMs: 4000 },
  ];
  const retentionMs = 1000;
  const nowMs = 5000;

  it('with the hold on, no row past its retention period is removed', () => {
    const plan = planPurge({ rows, nowMs, retentionMs, legalHold: true });
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(['row-a', 'row-b']);
    expect(plan.audit).toEqual({
      kind: 'evidence.purge',
      atMs: nowMs,
      removedCount: 0,
      keptCount: 2,
      legalHold: true,
    });
  });

  it('once the hold is lifted, the same rows past their retention period may be removed', () => {
    const plan = planPurge({ rows, nowMs, retentionMs, legalHold: false });
    expect(plan.remove).toEqual(['row-a', 'row-b']);
    expect(plan.keep).toEqual([]);
  });

  it('for any rows, retention and instant: a held document keeps every row; without the hold, exactly the expired ones go', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (collected, retention, extra) => {
          const sample = collected.map((c, i) => ({ id: `r${i}`, collectedAtMs: c }));
          const nowMs = (collected.length ? Math.max(...collected) : 0) + extra;
          const held = planPurge({ rows: sample, nowMs, retentionMs: retention, legalHold: true });
          expect(held.remove).toEqual([]);
          const free = planPurge({ rows: sample, nowMs, retentionMs: retention, legalHold: false });
          const expired = sample
            .filter((r) => nowMs - r.collectedAtMs >= retention)
            .map((r) => r.id);
          expect(free.remove).toEqual(expired);
          expect(free.remove.length + free.keep.length).toBe(sample.length);
        },
      ),
      { numRuns: 300 },
    );
  });
});
