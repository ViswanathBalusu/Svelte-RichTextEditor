/**
 * The salted periodic root that is published in a public transparency log (SEC-065; ADR 0409
 * decision 1; 10 §3.3, §6; 08 §12). Universal: the document service, the verification command and
 * a relying party compute the same things, and nothing here handles a key.
 *
 * One entry per tenant per period holds the root of a Merkle tree over salted leaves. A leaf is
 * `SHA-256(0x02 ‖ salt (32 bytes) ‖ seq (8 bytes, big endian) ‖ chain head (32 bytes))`. The leaf
 * holds no document, tenant or user identifier. The leaves are sorted by their own hash, so the
 * tree does not depend on the order of the documents and the position of a leaf says nothing about
 * its document. An inner node is `SHA-256(0x01 ‖ left ‖ right)` and an odd node is carried up, as
 * in head-anchor.ts, so the two trees use one node rule and differ only in their leaves.
 *
 * Without the tenant's salt nobody can compute a leaf from a head, so the public entry links to
 * nothing. With the salt, a relying party checks one head against the root with an inclusion path.
 *
 * The public entry is the text of `publicEntryText`: a format name, the period, the root and the
 * number of leaves. It names no tenant, document or user and no sequence number.
 */
import { sha256, toHex } from '@docedit/model';
import { levelsOf, rootFromPath, type PathStep } from './head-anchor.ts';
import { type HistoryResult, refuse } from './types.ts';

/** The format name inside the public entry. */
export const PUBLIC_ROOT_FORMAT = 'docedit-public-root/1';

/** The length of a tenant's salt in bytes. */
export const PUBLIC_SALT_BYTES = 32;

/** What a leaf is made of besides the salt: a chain head and its sequence number. */
export interface SaltedHead {
  /** The chain head at `seq`: lower-case hexadecimal SHA-256. */
  chainHead: string;
  seq: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function saltProblem(salt: Uint8Array): string | null {
  if (!(salt instanceof Uint8Array) || salt.length !== PUBLIC_SALT_BYTES)
    return `a salt is ${PUBLIC_SALT_BYTES} bytes`;
  return null;
}

function headProblem(h: SaltedHead): string | null {
  if (typeof h !== 'object' || h === null) return 'a head is an object';
  if (typeof h.chainHead !== 'string' || !HEX64.test(h.chainHead))
    return 'a chain head is 64 lower-case hexadecimal digits';
  if (!Number.isSafeInteger(h.seq) || h.seq < 1) return 'a head has a seq of 1 or more';
  return null;
}

/** The salted leaf of a head, lower-case hexadecimal. */
export async function publicLeaf(
  salt: Uint8Array,
  head: SaltedHead,
): Promise<HistoryResult<{ leaf: string }>> {
  const problem = saltProblem(salt) ?? headProblem(head);
  if (problem !== null) return refuse('validation_failed', problem);
  const bytes = new Uint8Array(1 + PUBLIC_SALT_BYTES + 8 + 32);
  bytes[0] = 0x02;
  bytes.set(salt, 1);
  const view = new DataView(bytes.buffer);
  view.setUint32(1 + PUBLIC_SALT_BYTES, Math.floor(head.seq / 2 ** 32));
  view.setUint32(1 + PUBLIC_SALT_BYTES + 4, head.seq % 2 ** 32);
  bytes.set(fromHex(head.chainHead), 1 + PUBLIC_SALT_BYTES + 8);
  return { ok: true, leaf: toHex(await sha256(bytes)) };
}

/** The sorted leaves of a set of heads, or why they cannot be built. */
async function sortedLeaves(
  salt: Uint8Array,
  heads: readonly SaltedHead[],
): Promise<HistoryResult<{ leaves: string[] }>> {
  if (heads.length === 0) return refuse('validation_failed', 'a tree needs at least one head');
  const leaves: string[] = [];
  for (const h of heads) {
    const l = await publicLeaf(salt, h);
    if (!l.ok) return l;
    leaves.push(l.leaf);
  }
  leaves.sort();
  return { ok: true, leaves };
}

export interface PublicRoot {
  /** The root, lower-case hexadecimal. */
  root: string;
  /** The number of leaves: the number of heads the tree was built from. */
  leaves: number;
}

/**
 * The root over a set of heads and a salt. The order of `heads` does not change the root. An empty
 * set has no tree.
 */
export async function buildPublicRoot(
  salt: Uint8Array,
  heads: readonly SaltedHead[],
): Promise<HistoryResult<PublicRoot>> {
  const sorted = await sortedLeaves(salt, heads);
  if (!sorted.ok) return sorted;
  const levels = await levelsOf(sorted.leaves);
  return { ok: true, root: levels[levels.length - 1]![0]!, leaves: sorted.leaves.length };
}

/**
 * The inclusion path of one head, built from the tenant's heads and salt and checked against the\n * root that was recorded for them. Refused when the tree the salt gives is not the recorded one (a\n * wrong salt) and when the head has no leaf in it (a changed head, another sequence number).\n */
export async function publicRootProof(
  salt: Uint8Array,
  heads: readonly SaltedHead[],
  target: SaltedHead,
  recordedRoot: string,
): Promise<HistoryResult<{ leaf: string; path: PathStep[]; root: string }>> {
  const sorted = await sortedLeaves(salt, heads);
  if (!sorted.ok) return sorted;
  const own = await publicLeaf(salt, target);
  if (!own.ok) return own;
  let at = sorted.leaves.indexOf(own.leaf);
  if (at < 0) return refuse('not_found', 'the head has no leaf in this tree');
  const levels = await levelsOf(sorted.leaves);
  if (levels[levels.length - 1]![0] !== recordedRoot)
    return refuse('not_found', 'these heads and this salt do not give the recorded root');
  const path: PathStep[] = [];
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level]!;
    const sibling = at % 2 === 0 ? nodes[at + 1] : nodes[at - 1];
    if (sibling !== undefined) path.push({ side: at % 2 === 0 ? 'right' : 'left', hash: sibling });
    at = Math.floor(at / 2);
  }
  return { ok: true, leaf: own.leaf, path, root: levels[levels.length - 1]![0]! };
}

/** What a relying party holds to check one head: the head, the salt and the path. */
export interface PublicRootProof {
  salt: Uint8Array;
  head: SaltedHead;
  path: readonly PathStep[];
}

/**
 * Whether a head, with its salt and path, leads to a root. It says nothing about the log's receipt
 * or about the chain the head belongs to.
 */
export async function verifyPublicRootProof(
  root: string,
  proof: PublicRootProof,
): Promise<HistoryResult<{ covered: boolean }>> {
  if (typeof root !== 'string' || !HEX64.test(root))
    return refuse('validation_failed', 'a root is 64 lower-case hexadecimal digits');
  if (typeof proof !== 'object' || proof === null || !Array.isArray(proof.path))
    return refuse('validation_failed', 'a proof is a salt, a head and a path');
  const leaf = await publicLeaf(proof.salt, proof.head);
  if (!leaf.ok) return leaf;
  const folded = await rootFromPath(leaf.leaf, proof.path);
  if (!folded.ok) return folded;
  return { ok: true, covered: folded.root === root };
}

/** The public entry: what is sent to a log. It holds no identifier and no sequence number. */
export interface PublicRootEntry {
  format: typeof PUBLIC_ROOT_FORMAT;
  /** The end of the previous period, or null for a first entry. */
  from: string | null;
  /** The end of this period, RFC 3339 in UTC with milliseconds. */
  to: string;
  root: string;
  leaves: number;
}

/** The members of the public entry. A change to this list is a change to what leaves the system. */
export const PUBLIC_ROOT_MEMBERS = ['format', 'from', 'leaves', 'root', 'to'] as const;

function entryProblem(r: Omit<PublicRootEntry, 'format'>): string | null {
  if (typeof r.to !== 'string' || !TIME.test(r.to)) return 'to is a time in UTC with milliseconds';
  if (r.from !== null && (typeof r.from !== 'string' || !TIME.test(r.from)))
    return 'from is a time in UTC with milliseconds, or null';
  if (r.from !== null && r.from >= r.to) return 'from is before to';
  if (typeof r.root !== 'string' || !HEX64.test(r.root)) return 'the root is 64 hexadecimal digits';
  if (!Number.isSafeInteger(r.leaves) || r.leaves < 1) return 'leaves is a count of 1 or more';
  return null;
}

/** The entry as the text that is sent: members in alphabetical order, no white space. */
export function publicEntryText(
  r: Omit<PublicRootEntry, 'format'>,
): HistoryResult<{ text: string }> {
  const problem = entryProblem(r);
  if (problem !== null) return refuse('validation_failed', problem);
  return {
    ok: true,
    text: JSON.stringify({
      format: PUBLIC_ROOT_FORMAT,
      from: r.from,
      leaves: r.leaves,
      root: r.root,
      to: r.to,
    }),
  };
}

/** Reads an entry's text. Refused unless it is the canonical text of exactly the entry's members. */
export function parsePublicEntry(text: string): HistoryResult<{ entry: PublicRootEntry }> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse('validation_failed', 'the entry is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return refuse('validation_failed', 'the entry is not an object');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== [...PUBLIC_ROOT_MEMBERS].join(','))
    return refuse('validation_failed', 'the entry does not have the members of a public entry');
  if (o['format'] !== PUBLIC_ROOT_FORMAT)
    return refuse('validation_failed', `the entry is not of format ${PUBLIC_ROOT_FORMAT}`);
  const entry = o as unknown as PublicRootEntry;
  const again = publicEntryText(entry);
  if (!again.ok) return again;
  if (again.text !== text)
    return refuse('validation_failed', 'the entry is not in its canonical form');
  return { ok: true, entry };
}

/** The format name of the receipt a transparency log gives for an entry. */
export const LOG_RECEIPT_FORMAT = 'docedit-log-receipt/1';

/** What a log gives back for an entry: where it stands and a signed checkpoint that covers it. */
export interface PublicLogReceipt {
  format: typeof LOG_RECEIPT_FORMAT;
  /** The log's identifier: the origin line of its checkpoints. */
  logId: string;
  /** The entry's position in the log. */
  index: number;
  /** The size of the tree the proof and the checkpoint are for. */
  size: number;
  /** The leaf hash of the entry (RFC 6962), lower-case hexadecimal. */
  leafHash: string;
  /** The inclusion proof of the leaf in the tree of `size`, lower-case hexadecimal hashes. */
  proof: string[];
  /** The signed checkpoint, a signed note. */
  checkpoint: string;
}

/** The format name of one piece of public anchor evidence. */
export const PUBLIC_ANCHOR_FORMAT = 'docedit-public-anchor/1';

/**
 * What a relying party is given to check one head against the public log (SEC-067): the public
 * entry, the log's receipt for it (null while the root is not yet in the log), and the head with the
 * tenant's salt and the inclusion path. The salt is handed over with the proof (ADR 0409 decision 2);
 * it is a value of the tenant and is never part of the public entry.
 */
export interface PublicAnchorEvidence {
  format: typeof PUBLIC_ANCHOR_FORMAT;
  doc: string;
  /** The public entry text the root was sent as. */
  entry: string;
  receipt: PublicLogReceipt | null;
  saltVersion: number;
  /** The salt, lower-case hexadecimal. */
  salt: string;
  head: SaltedHead;
  path: PathStep[];
}
