// The evidence bundle's items and their verification (FRW-055 criteria 3 and 5; FRW-041 commitments).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_INSTRUCTIONS,
  type BundleItem,
  SALT_BYTES,
  buildBundle,
  commitEvidence,
  instructionsWithinStance,
  verifyBundle,
} from '../src/index.ts';

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const saltArb = fc.uint8Array({ minLength: SALT_BYTES, maxLength: SALT_BYTES });
const canonicalArb = fc.string({ minLength: 1, maxLength: 60 });

async function itemFor(id: string, canonical: string, salt: Uint8Array): Promise<BundleItem> {
  return {
    id,
    saltHex: toHex(salt),
    canonical,
    commitment: await commitEvidence(canonical, salt),
  };
}

describe('the bundle names every evidence item that does not verify (FRW-055 criterion 3)', () => {
  it('verifies a bundle of intact items (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(canonicalArb, saltArb), { minLength: 1, maxLength: 5 }),
        async (rows) => {
          const items: BundleItem[] = [];
          for (const [i, [canonical, salt]] of rows.entries())
            items.push(await itemFor(`ev${i}`, canonical, salt));
          const verdict = await verifyBundle(buildBundle(items));
          return verdict.ok && verdict.failed.length === 0;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('an altered item fails and is the one named (property)', async () => {
    await fc.assert(
      fc.asyncProperty(canonicalArb, canonicalArb, saltArb, async (a, extra, salt) => {
        const good = await itemFor('ev-a', a, salt);
        const other = await itemFor('ev-b', 'stable text', salt);
        const altered: BundleItem = { ...good, canonical: `${a}${extra}` };
        const verdict = await verifyBundle(buildBundle([altered, other]));
        if (extra === '') return verdict.ok; // no change, so nothing fails
        return !verdict.ok && verdict.failed.length === 1 && verdict.failed[0] === 'ev-a';
      }),
      { numRuns: 100 },
    );
  });

  it('an altered commitment or salt names the item, with the problem', async () => {
    const salt = new Uint8Array(SALT_BYTES).fill(7);
    const good = await itemFor('ev-1', 'Board approval', salt);
    const wrongCommitment = await verifyBundle(
      buildBundle([{ ...good, commitment: 'd'.repeat(64) }]),
    );
    expect(wrongCommitment.failed).toEqual(['ev-1']);
    expect(wrongCommitment.items[0]?.problem).toBe('mismatch');

    const shortSalt = await verifyBundle(buildBundle([{ ...good, saltHex: 'ab' }]));
    expect(shortSalt.items[0]?.problem).toBe('malformed_salt');

    const badCommitment = await verifyBundle(buildBundle([{ ...good, commitment: 'XYZ' }]));
    expect(badCommitment.items[0]?.problem).toBe('malformed_commitment');
  });

  it('refuses a bundle with a duplicate evidence identifier', async () => {
    const salt = new Uint8Array(SALT_BYTES);
    const item = await itemFor('ev-1', 'x', salt);
    expect(() => buildBundle([item, item])).toThrow(RangeError);
  });
});

describe('the instructions state what the evidence proves and what it does not (FRW-055 criterion 5)', () => {
  it('say what is not proved and claim no verified identity', () => {
    const text = BUNDLE_INSTRUCTIONS.join(' ');
    expect(text).toContain('does not prove who any participant is');
    expect(text).toContain('does not prove that a participant read the document');
    expect(text).toMatch(/as asserted by the host/);
    expect(text.toLowerCase()).not.toContain('verified identity');
  });

  it('stay within the legal stance of FRW-058 (checked by the phrase list)', () => {
    expect(instructionsWithinStance(buildBundle([]))).toBe(true);
  });
});
