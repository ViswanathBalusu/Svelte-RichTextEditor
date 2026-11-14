/**
 * SEC-044 criterion 4, the part the commitment module can show (lane V-SEC-033-048): the salt is not
 * written where the log would keep it. A control commit's evidence part is what the log stores, so
 * its serialised form (JSON, as a commit log would hold it) is searched for the salt in hex, base64
 * and decimal, and for the canonical evidence text. Node.js only (vitest, fast-check).
 *
 * This is the payload, not a stored chain: the commit log and the chain are not built (see the
 * story Notes), so the criterion stays unticked.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SALT_BYTES,
  commitEvidence,
  controlCommitEvidence,
  verifyEvidence,
} from '../../../packages/authority/src/workflow/evidence.ts';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 200);

const saltArb = fc.uint8Array({ minLength: SALT_BYTES, maxLength: SALT_BYTES });
const canonicalArb = fc.string({ minLength: 12, maxLength: 200 });

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function forms(salt: Uint8Array): string[] {
  return [
    hex(salt),
    Buffer.from(salt).toString('base64'),
    Array.from(salt).join(','),
    Array.from(salt).join(' '),
  ];
}

describe('SEC-044 criterion 4: the salt is not stored in the commit payload', () => {
  it('serialises a control commit with no salt, in any form, and no canonical text', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('sign', 'rules') as fc.Arbitrary<'sign' | 'rules'>,
        canonicalArb,
        saltArb,
        async (origin, canonical, saltBytes) => {
          const salt = new Uint8Array(saltBytes);
          const payload = await controlCommitEvidence(origin, canonical, salt);
          const stored = JSON.stringify(payload);
          expect(Object.keys(payload).sort()).toEqual(['evidenceHash', 'origin']);
          for (const form of forms(salt)) expect(stored).not.toContain(form);
          expect(stored).not.toContain(canonical);
        },
      ),
      { numRuns: RUNS },
    );
  }, 120_000);

  it('still lets a holder of the evidence and the salt verify the commitment', async () => {
    await fc.assert(
      fc.asyncProperty(canonicalArb, saltArb, async (canonical, saltBytes) => {
        const salt = new Uint8Array(saltBytes);
        const commitment = await commitEvidence(canonical, salt);
        expect(await verifyEvidence(canonical, salt, commitment)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  }, 120_000);
});
