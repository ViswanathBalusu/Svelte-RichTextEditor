// SEC-041 criterion 5: after a signing key rotation, seals made earlier still validate.
// A seal is an ES256 signature from a `sign` key of KeyService. Validation uses only the public JWK
// of the key that made it, which a relying party can hold without any access to the service. The
// test rotates keys (create a new `sign` key, then disable the old one, which stops signing) and
// checks that every earlier seal still verifies under its own public JWK and under no other.
// It does not test the seal format of the export or the signing service, which are not built.
import { webcrypto } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KeyDisabledError, MemoryKeyService, type Jwk } from './key-service.ts';

const { subtle } = webcrypto;
const encoder = new TextEncoder();

async function validates(publicJwk: Jwk, data: Uint8Array, seal: Uint8Array): Promise<boolean> {
  const key = await subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, seal, data);
}

describe('SEC-041 criterion 5: seals made before a key rotation still validate', () => {
  it('a seal made under the old key validates after rotation, and the old key can no longer sign', async () => {
    const keys = new MemoryKeyService();
    await keys.create('seal-2026a', 'sign');
    const document = encoder.encode('final export, document 1, seq 42');
    const oldSeal = await keys.sign('seal-2026a', document);
    const oldJwk = await keys.publicJwk('seal-2026a');

    // The rotation: a new key takes over and the old one is disabled.
    await keys.create('seal-2026b', 'sign');
    await keys.disable('seal-2026a');
    const newSeal = await keys.sign(
      'seal-2026b',
      encoder.encode('final export, document 2, seq 7'),
    );

    expect(await validates(oldJwk, document, oldSeal)).toBe(true);
    // The public half of a disabled key is still published, so the earlier seal stays checkable.
    expect(await validates(await keys.publicJwk('seal-2026a'), document, oldSeal)).toBe(true);
    // A seal of the new key does not validate under the old key, and the reverse.
    expect(
      await validates(oldJwk, encoder.encode('final export, document 2, seq 7'), newSeal),
    ).toBe(false);
    await expect(keys.sign('seal-2026a', document)).rejects.toBeInstanceOf(KeyDisabledError);
  });

  it('seals from every generation of several rotations still validate (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 256 }), { minLength: 1, maxLength: 4 }),
        async (rotations, payloads) => {
          const keys = new MemoryKeyService();
          const generations: { id: string; data: Uint8Array; seal: Uint8Array; jwk: Jwk }[] = [];
          for (let g = 0; g < rotations; g += 1) {
            const id = `seal-gen-${g}`;
            await keys.create(id, 'sign');
            if (g > 0) await keys.disable(`seal-gen-${g - 1}`);
            const data = payloads[g % payloads.length] ?? new Uint8Array([g]);
            generations.push({
              id,
              data,
              seal: await keys.sign(id, data),
              jwk: await keys.publicJwk(id),
            });
          }
          // Every seal made in every generation validates under its own key, after all rotations.
          for (const gen of generations) {
            expect(await validates(gen.jwk, gen.data, gen.seal)).toBe(true);
            expect(await validates(await keys.publicJwk(gen.id), gen.data, gen.seal)).toBe(true);
          }
          // Each seal is refused under the other generations' keys (the control: the check is by key).
          for (const gen of generations) {
            for (const other of generations) {
              if (other.id === gen.id) continue;
              expect(await validates(other.jwk, gen.data, gen.seal)).toBe(false);
            }
          }
          // Only the newest generation can still sign.
          const newest = generations[generations.length - 1];
          expect(newest).toBeDefined();
          expect(await keys.enabled(newest!.id)).toBe(true);
          for (const gen of generations.slice(0, -1)) {
            expect(await keys.enabled(gen.id)).toBe(false);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
