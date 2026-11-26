// The salted periodic root (SEC-065; ADR 0409): the leaf, the root, the inclusion proof, the public
// entry. Properties use fast-check over random heads, salts and orderings.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildPublicRoot,
  parsePublicEntry,
  publicEntryText,
  publicLeaf,
  publicRootProof,
  verifyPublicRootProof,
  type SaltedHead,
} from '../src/index.ts';

const salt = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const hex64 = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'),
  minLength: 64,
  maxLength: 64,
});
const head = fc.record({ chainHead: hex64, seq: fc.integer({ min: 1, max: 2 ** 40 }) });
const heads = fc.uniqueArray(head, { minLength: 1, maxLength: 24, selector: (h) => h.chainHead });
const saltArb = fc.uint8Array({ minLength: 32, maxLength: 32 });

const H = (n: number, seq = 1): SaltedHead => ({
  chainHead: n.toString(16).padStart(64, '0'),
  seq,
});

describe('public root', () => {
  it('builds a root and counts the leaves', async () => {
    const r = await buildPublicRoot(salt(1), [H(1), H(2), H(3)]);
    expect(r).toMatchObject({ ok: true, leaves: 3 });
    if (r.ok) expect(r.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an empty set, a bad salt and a bad head', async () => {
    expect((await buildPublicRoot(salt(1), [])).ok).toBe(false);
    expect((await buildPublicRoot(new Uint8Array(16), [H(1)])).ok).toBe(false);
    expect((await buildPublicRoot(salt(1), [{ chainHead: 'zz', seq: 1 }])).ok).toBe(false);
    expect((await buildPublicRoot(salt(1), [H(1, 0)])).ok).toBe(false);
  });

  it('gives the same root for the same inputs in any order (property)', async () => {
    await fc.assert(
      fc.asyncProperty(saltArb, heads, fc.nat(), async (s, hs, shift) => {
        const a = await buildPublicRoot(s, hs);
        const rotated = [...hs.slice(shift % hs.length), ...hs.slice(0, shift % hs.length)];
        const b = await buildPublicRoot(s, rotated.reverse());
        const c = await buildPublicRoot(s, hs);
        expect(a).toEqual(b);
        expect(a).toEqual(c);
      }),
      { numRuns: 60 },
    );
  });

  it('verifies the proof of every head, and of no changed input (property)', async () => {
    await fc.assert(
      fc.asyncProperty(saltArb, heads, async (s, hs) => {
        const root = await buildPublicRoot(s, hs);
        if (!root.ok) throw new Error('no root');
        for (const h of hs) {
          const p = await publicRootProof(s, hs, h, root.root);
          if (!p.ok) throw new Error('no proof');
          expect(p.root).toBe(root.root);
          const proof = { salt: s, head: h, path: p.path };
          expect(await verifyPublicRootProof(root.root, proof)).toEqual({
            ok: true,
            covered: true,
          });
          // A wrong salt, a changed head and another sequence number do not verify.
          const wrong = Uint8Array.from(s);
          wrong[0] = (wrong[0]! + 1) % 256;
          expect(await verifyPublicRootProof(root.root, { ...proof, salt: wrong })).toEqual({
            ok: true,
            covered: false,
          });
          const flipped = h.chainHead.startsWith('0')
            ? `1${h.chainHead.slice(1)}`
            : `0${h.chainHead.slice(1)}`;
          expect(
            await verifyPublicRootProof(root.root, {
              ...proof,
              head: { ...h, chainHead: flipped },
            }),
          ).toEqual({ ok: true, covered: false });
          expect(
            await verifyPublicRootProof(root.root, { ...proof, head: { ...h, seq: h.seq + 1 } }),
          ).toEqual({ ok: true, covered: false });
          // And the proof cannot be built for them.
          expect((await publicRootProof(wrong, hs, h, root.root)).ok).toBe(false);
          expect((await publicRootProof(s, hs, { ...h, seq: h.seq + 1 }, root.root)).ok).toBe(
            false,
          );
        }
      }),
      { numRuns: 25 },
    );
  });

  it('gives different leaves for the same head under different salts', async () => {
    const a = await publicLeaf(salt(1), H(7));
    const b = await publicLeaf(salt(2), H(7));
    expect(a.ok && b.ok && a.leaf !== b.leaf).toBe(true);
  });

  it('gives different leaves for the same head at another sequence number', async () => {
    const a = await publicLeaf(salt(1), H(7, 1));
    const b = await publicLeaf(salt(1), H(7, 2));
    expect(a.ok && b.ok && a.leaf !== b.leaf).toBe(true);
  });

  it('writes and reads a canonical entry that has no identifier members', () => {
    const to = '2026-11-26T11:00:00.000Z';
    const t = publicEntryText({ from: null, to, root: 'a'.repeat(64), leaves: 3 });
    if (!t.ok) throw new Error(t.reason);
    expect(Object.keys(JSON.parse(t.text)).sort()).toEqual([
      'format',
      'from',
      'leaves',
      'root',
      'to',
    ]);
    expect(parsePublicEntry(t.text)).toMatchObject({ ok: true, entry: { leaves: 3, to } });
    const extra = t.text.replace('"to"', '"tenant":"x","to"');
    expect(parsePublicEntry(extra).ok).toBe(false);
    expect(publicEntryText({ from: to, to, root: 'a'.repeat(64), leaves: 1 }).ok).toBe(false);
  });
});
