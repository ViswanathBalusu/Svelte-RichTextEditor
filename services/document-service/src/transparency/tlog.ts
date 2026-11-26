/**
 * The parts of a transparency log that a receipt is checked with (SEC-066; ADR 0409 decision 5).
 *
 * - The Merkle tree of RFC 6962 and RFC 9162: leaf hash `SHA-256(0x00 ‖ entry)`, node hash
 *   `SHA-256(0x01 ‖ left ‖ right)`, inclusion proofs and their check.
 * - The signed note of C2SP (`c2sp.org/signed-note`) with Ed25519 signatures, and the checkpoint
 *   body of C2SP `tlog-checkpoint`: the origin, the tree size and the root hash in base64.
 * - The verifier key text of a signed note (`name+hash+base64(0x01 ‖ public key)`), which is the
 *   log's public key as a relying party is given it.
 *
 * What is not here: the tile read API of `tlog-tiles` and the cosignatures of witnesses. A receipt
 * is checked with the log's own checkpoint signature only.
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

const sha = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));
const HEX64 = /^[0-9a-f]{64}$/;

/** The leaf hash of an entry (RFC 6962 section 2.1). */
export function leafHash(entry: Uint8Array): Uint8Array {
  return sha(new Uint8Array([0x00]), entry);
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha(new Uint8Array([0x01]), left, right);
}

/** The largest power of two that is smaller than n (n of 2 or more). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** The root of a tree over leaf hashes (RFC 6962 `MTH`). An empty tree has the hash of nothing. */
export function treeRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha();
  if (leaves.length === 1) return leaves[0]!;
  const k = split(leaves.length);
  return nodeHash(treeRoot(leaves.slice(0, k)), treeRoot(leaves.slice(k)));
}

/** The inclusion proof of leaf `index` in the tree over `leaves` (RFC 6962 `PATH`). */
export function inclusionProof(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length)
    throw new RangeError('the leaf is not in the tree');
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...inclusionProof(leaves.slice(0, k), index), treeRoot(leaves.slice(k))]
    : [...inclusionProof(leaves.slice(k), index - k), treeRoot(leaves.slice(0, k))];
}

/**
 * The root an inclusion proof leads to (RFC 9162 section 2.1.3.2), or null when the proof does not
 * fit the index and the size.
 */
export function rootFromInclusion(
  leaf: Uint8Array,
  index: number,
  size: number,
  proof: readonly Uint8Array[],
): Uint8Array | null {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size)
    return null;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return null;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? r : null;
}

/** The raw 32 bytes of an Ed25519 public key. */
export function rawPublicKey(key: KeyObject): Uint8Array {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return new Uint8Array(Buffer.from(jwk.x as string, 'base64url'));
}

/** The four bytes that tell a signature line which key made it (signed-note, Ed25519 type 0x01). */
function keyHash(name: string, publicKey: Uint8Array): Uint8Array {
  return sha(new TextEncoder().encode(`${name}\n`), new Uint8Array([0x01]), publicKey).slice(0, 4);
}

/** A log's public key as a relying party is given it: `name+hash+base64(0x01 ‖ key)`. */
export function verifierKey(name: string, publicKey: Uint8Array): string {
  const hash = toHex(keyHash(name, publicKey));
  const body = Buffer.from(new Uint8Array([0x01, ...publicKey])).toString('base64');
  return `${name}+${hash}+${body}`;
}

export interface LogVerifier {
  name: string;
  publicKey: Uint8Array;
}

/** Reads a verifier key text. Null when it is not one, or not an Ed25519 key. */
export function parseVerifierKey(text: string): LogVerifier | null {
  const m = /^([^+\s]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/]+={0,2})$/.exec(text.trim());
  if (m === null) return null;
  const raw = new Uint8Array(Buffer.from(m[3]!, 'base64'));
  if (raw.length !== 33 || raw[0] !== 0x01) return null;
  const publicKey = raw.slice(1);
  if (toHex(keyHash(m[1]!, publicKey)) !== m[2]) return null;
  return { name: m[1]!, publicKey };
}

/** A signed note: the text, a blank line, and one signature line (C2SP signed-note). */
export function signNote(body: string, name: string, key: KeyObject): string {
  if (!body.endsWith('\n')) throw new RangeError('the text of a note ends with a newline');
  const publicKey = rawPublicKey(key);
  const signature = new Uint8Array(sign(null, Buffer.from(body, 'utf8'), key));
  const line = Buffer.from(new Uint8Array([...keyHash(name, publicKey), ...signature])).toString(
    'base64',
  );
  return `${body}\n— ${name} ${line}\n`;
}

const EM_DASH = '—';

/** The text of a note whose signature by `verifier` holds, or null. */
export function openNote(note: string, verifier: LogVerifier): string | null {
  const at = note.lastIndexOf('\n\n');
  if (at < 0) return null;
  const body = note.slice(0, at + 1);
  const hash = keyHash(verifier.name, verifier.publicKey);
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(verifier.publicKey).toString('base64url') },
    format: 'jwk',
  });
  for (const line of note.slice(at + 2).split('\n')) {
    if (!line.startsWith(`${EM_DASH} ${verifier.name} `)) continue;
    const raw = new Uint8Array(
      Buffer.from(line.slice(`${EM_DASH} ${verifier.name} `.length), 'base64'),
    );
    if (raw.length !== 4 + 64 || toHex(raw.slice(0, 4)) !== toHex(hash)) continue;
    if (verify(null, Buffer.from(body, 'utf8'), key, raw.slice(4))) return body;
  }
  return null;
}

export interface Checkpoint {
  origin: string;
  size: number;
  /** The root hash, lower-case hexadecimal. */
  root: string;
}

/** The body of a checkpoint note: origin, size and base64 root, each on a line. */
export function checkpointBody(c: Checkpoint): string {
  return `${c.origin}\n${c.size}\n${Buffer.from(fromHex(c.root)).toString('base64')}\n`;
}

/** Reads a checkpoint body. Extension lines after the root are accepted and ignored. */
export function parseCheckpointBody(body: string): Checkpoint | null {
  const lines = body.split('\n');
  if (lines.length < 4 || lines[0] === '' || !/^(0|[1-9]\d*)$/.test(lines[1]!)) return null;
  const root = toHex(new Uint8Array(Buffer.from(lines[2]!, 'base64')));
  if (!HEX64.test(root)) return null;
  const size = Number(lines[1]);
  if (!Number.isSafeInteger(size)) return null;
  return { origin: lines[0]!, size, root };
}
