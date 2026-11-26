// The log format parts (SEC-066): the Merkle tree of RFC 6962, inclusion proofs and their check, the
// signed note and the checkpoint body, and the verifier key text.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkpointBody,
  inclusionProof,
  leafHash,
  openNote,
  parseCheckpointBody,
  parseVerifierKey,
  rawPublicKey,
  rootFromInclusion,
  signNote,
  toHex,
  treeRoot,
  verifierKey,
} from './tlog.ts';

const entry = (n: number) => new TextEncoder().encode(`entry ${n}`);

describe('Merkle tree (RFC 6962)', () => {
  it('has the hash of nothing for an empty tree', () => {
    expect(toHex(treeRoot([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('proves every leaf of every tree size up to 40, and nothing else', () => {
    for (let size = 1; size <= 40; size++) {
      const leaves = Array.from({ length: size }, (_, i) => leafHash(entry(i)));
      const root = treeRoot(leaves);
      for (let i = 0; i < size; i++) {
        const proof = inclusionProof(leaves, i);
        const got = rootFromInclusion(leaves[i]!, i, size, proof);
        expect(got && toHex(got)).toBe(toHex(root));
        if (size > 1) {
          const other = rootFromInclusion(leafHash(entry(1000)), i, size, proof);
          expect(other && toHex(other)).not.toBe(toHex(root));
          const moved = rootFromInclusion(leaves[i]!, (i + 1) % size, size, proof);
          expect(moved === null || toHex(moved) !== toHex(root)).toBe(true);
        }
      }
    }
  });

  it('refuses a proof of the wrong length', () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leafHash(entry(i)));
    const proof = inclusionProof(leaves, 2);
    expect(rootFromInclusion(leaves[2]!, 2, 5, proof.slice(1))).toBeNull();
    expect(rootFromInclusion(leaves[2]!, 2, 5, [...proof, proof[0]!])).toBeNull();
    expect(rootFromInclusion(leaves[2]!, 7, 5, proof)).toBeNull();
  });
});

describe('signed note', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const body = checkpointBody({ origin: 'test-log', size: 3, root: 'ab'.repeat(32) });
  const verifier = { name: 'test-log', publicKey: rawPublicKey(privateKey) };

  it('opens with the signing key and gives the checkpoint back', () => {
    const note = signNote(body, 'test-log', privateKey);
    expect(openNote(note, verifier)).toBe(body);
    expect(parseCheckpointBody(body)).toEqual({
      origin: 'test-log',
      size: 3,
      root: 'ab'.repeat(32),
    });
  });

  it('does not open with another key, another name or a changed body', () => {
    const note = signNote(body, 'test-log', privateKey);
    const other = {
      name: 'test-log',
      publicKey: rawPublicKey(generateKeyPairSync('ed25519').privateKey),
    };
    expect(openNote(note, other)).toBeNull();
    expect(openNote(note, { ...verifier, name: 'another' })).toBeNull();
    expect(openNote(note.replace('\n3\n', '\n4\n'), verifier)).toBeNull();
  });

  it('writes the log key as a verifier key text and reads it back', () => {
    const text = verifierKey('test-log', verifier.publicKey);
    expect(parseVerifierKey(text)).toEqual(verifier);
    expect(parseVerifierKey(text.replace('test-log', 'x'))).toBeNull();
    expect(parseVerifierKey('nonsense')).toBeNull();
  });
});
