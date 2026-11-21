/**
 * Anchoring chain heads in batches (08 §12; HIS-035, HIS-036; ADR 0409): the rules, universal, so
 * that the document service, the verification tool and a relying party compute the same things.
 *
 * Once an hour the service signs and time-stamps one record per tenant. The record names the root
 * of a Merkle tree over the heads of the tenant's documents that changed since the previous record.
 * This module holds what needs no key:
 *
 * - the leaf of a head: `SHA-256(0x00 ‖ document id (16 bytes) ‖ incarnation (16 bytes) ‖ seq
 *   (8 bytes, big endian) ‖ chain head (32 bytes))`;
 * - the tree: leaves sorted by document id, an inner node is `SHA-256(0x01 ‖ left ‖ right)`, and an
 *   odd node at a level is carried up unchanged. The prefixes keep a leaf from being read as a node;
 * - the inclusion path of one head, and the root a path leads to;
 * - the text of the record that is signed, and its reading;
 * - the check a relying party makes: the head's leaf, folded along its path, is the root the signed
 *   record names.
 *
 * The signature and the RFC 3161 time-stamp over the record are made by the signing service and
 * checked with its verifier; nothing here handles a key or a certificate. Whether the head is the
 * head of a log is `verifyBundle` (chain.ts), given the head as an anchor.
 */
import { sha256, toHex } from '@docedit/model';
import { type HistoryResult, refuse } from './types.ts';

/** The format name inside the signed record. */
export const HEAD_ANCHOR_FORMAT = 'docedit-anchor/1';

/** The head of one document's log: what a leaf is made of. */
export interface AnchoredHead {
  /** The document identifier, a UUID. */
  doc: string;
  /** The incarnation of the log, a UUID (04 §1). */
  incarnation: string;
  seq: number;
  /** The chain head at `seq`: lower-case hexadecimal SHA-256. */
  chainHead: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Why a head cannot be a leaf, or null. */
function headProblem(h: AnchoredHead): string | null {
  if (typeof h.doc !== 'string' || !UUID.test(h.doc)) return 'a document identifier is a UUID';
  if (typeof h.incarnation !== 'string' || !UUID.test(h.incarnation))
    return 'an incarnation is a UUID';
  if (!Number.isSafeInteger(h.seq) || h.seq < 1) return 'a head has a seq of 1 or more';
  if (typeof h.chainHead !== 'string' || !HEX64.test(h.chainHead))
    return 'a chain head is 64 lower-case hexadecimal digits';
  return null;
}

/** The leaf of a head, lower-case hexadecimal (ADR 0409 point 3). */
export async function anchorLeaf(head: AnchoredHead): Promise<HistoryResult<{ leaf: string }>> {
  const problem = headProblem(head);
  if (problem !== null) return refuse('validation_failed', problem);
  const bytes = new Uint8Array(1 + 16 + 16 + 8 + 32);
  bytes[0] = 0x00;
  bytes.set(fromHex(head.doc.replaceAll('-', '')), 1);
  bytes.set(fromHex(head.incarnation.replaceAll('-', '')), 17);
  // `seq` as 8 bytes, big endian: the high and the low 32 bits of a safe integer.
  const view = new DataView(bytes.buffer);
  view.setUint32(33, Math.floor(head.seq / 2 ** 32));
  view.setUint32(37, head.seq % 2 ** 32);
  bytes.set(fromHex(head.chainHead), 41);
  return { ok: true, leaf: toHex(await sha256(bytes)) };
}

async function node(left: string, right: string): Promise<string> {
  const bytes = new Uint8Array(1 + 32 + 32);
  bytes[0] = 0x01;
  bytes.set(fromHex(left), 1);
  bytes.set(fromHex(right), 33);
  return toHex(await sha256(bytes));
}

/** One head with its leaf, as the leaf list holds it. */
export interface AnchorLeaf extends AnchoredHead {
  leaf: string;
}

export interface AnchorTree {
  /** The root, lower-case hexadecimal. */
  root: string;
  /** The leaves in the order of the tree: sorted by document identifier. */
  leaves: AnchorLeaf[];
}

/** The levels of a tree from its leaves up to the root (the last level holds the root alone). */
async function levelsOf(leaves: readonly string[]): Promise<string[][]> {
  const levels: string[][] = [[...leaves]];
  while (levels[levels.length - 1]!.length > 1) {
    const below = levels[levels.length - 1]!;
    const above: string[] = [];
    for (let i = 0; i < below.length; i += 2) {
      const right = below[i + 1];
      // An odd node is carried up as it is.
      above.push(right === undefined ? below[i]! : await node(below[i]!, right));
    }
    levels.push(above);
  }
  return levels;
}

/**
 * The tree over a set of heads (ADR 0409 points 2 and 3). The order of `heads` does not matter. A
 * document appears once; an empty set has no tree, because a tenant with no change gets no anchor.
 */
export async function anchorTree(
  heads: readonly AnchoredHead[],
): Promise<HistoryResult<AnchorTree>> {
  if (heads.length === 0) return refuse('validation_failed', 'a tree needs at least one head');
  const sorted = [...heads].sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0));
  const leaves: AnchorLeaf[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i]!;
    if (i > 0 && sorted[i - 1]!.doc === h.doc)
      return refuse('validation_failed', 'each document appears once in a tree');
    const l = await anchorLeaf(h);
    if (!l.ok) return l;
    leaves.push({
      doc: h.doc,
      incarnation: h.incarnation,
      seq: h.seq,
      chainHead: h.chainHead,
      leaf: l.leaf,
    });
  }
  const levels = await levelsOf(leaves.map((l) => l.leaf));
  return { ok: true, root: levels[levels.length - 1]![0]!, leaves };
}

/** One step of an inclusion path: the sibling at a level, and the side it stands on. */
export interface PathStep {
  side: 'left' | 'right';
  hash: string;
}

/**
 * The inclusion path of a document's head in a tree, from the leaf's level upwards. A level at
 * which the node is carried up unchanged has no step. Refused when the document is not in the tree.
 */
export async function anchorPath(
  tree: Pick<AnchorTree, 'leaves'>,
  doc: string,
): Promise<HistoryResult<{ head: AnchoredHead; leaf: string; path: PathStep[] }>> {
  let at = tree.leaves.findIndex((l) => l.doc === doc);
  if (at < 0) return refuse('not_found', 'the document has no leaf in this tree');
  const found = tree.leaves[at]!;
  const levels = await levelsOf(tree.leaves.map((l) => l.leaf));
  const path: PathStep[] = [];
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level]!;
    const sibling = at % 2 === 0 ? nodes[at + 1] : nodes[at - 1];
    if (sibling !== undefined) path.push({ side: at % 2 === 0 ? 'right' : 'left', hash: sibling });
    at = Math.floor(at / 2);
  }
  return {
    ok: true,
    head: {
      doc: found.doc,
      incarnation: found.incarnation,
      seq: found.seq,
      chainHead: found.chainHead,
    },
    leaf: found.leaf,
    path,
  };
}

/** The root a leaf leads to along a path. Refused when the path is malformed. */
export async function rootFromPath(
  leaf: string,
  path: readonly PathStep[],
): Promise<HistoryResult<{ root: string }>> {
  if (!HEX64.test(leaf)) return refuse('validation_failed', 'a leaf is 64 hexadecimal digits');
  let at = leaf;
  for (const step of path) {
    if (
      typeof step !== 'object' ||
      step === null ||
      (step.side !== 'left' && step.side !== 'right') ||
      typeof step.hash !== 'string' ||
      !HEX64.test(step.hash)
    )
      return refuse('validation_failed', 'a path step is a side and 64 hexadecimal digits');
    at = step.side === 'left' ? await node(step.hash, at) : await node(at, step.hash);
  }
  return { ok: true, root: at };
}

/** What the signed record says. It holds identifiers, times, a count and hashes; no content. */
export interface HeadAnchorRecord {
  format: typeof HEAD_ANCHOR_FORMAT;
  tenant: string;
  /** The `to` of the tenant's previous record, or null for its first. */
  from: string | null;
  /** The time the heads were read, RFC 3339 in UTC with milliseconds. */
  to: string;
  /** The root of the tree, lower-case hexadecimal. */
  root: string;
  /** The number of leaves. */
  leaves: number;
  /** The SHA-256 of the tenant's previous record text, or null for its first. */
  previous: string | null;
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECORD_MEMBERS = 'format,from,leaves,previous,root,tenant,to';

function recordProblem(r: Omit<HeadAnchorRecord, 'format'>): string | null {
  if (typeof r.tenant !== 'string' || !UUID.test(r.tenant)) return 'the tenant is a UUID';
  if (typeof r.to !== 'string' || !TIME.test(r.to)) return 'to is a time in UTC with milliseconds';
  if (r.from !== null && (typeof r.from !== 'string' || !TIME.test(r.from)))
    return 'from is a time in UTC with milliseconds, or null';
  if (r.from !== null && r.from >= r.to) return 'from is before to';
  if (typeof r.root !== 'string' || !HEX64.test(r.root)) return 'the root is 64 hexadecimal digits';
  if (!Number.isSafeInteger(r.leaves) || r.leaves < 1) return 'leaves is a count of 1 or more';
  if (r.previous !== null && (typeof r.previous !== 'string' || !HEX64.test(r.previous)))
    return 'previous is 64 hexadecimal digits, or null';
  if ((r.from === null) !== (r.previous === null))
    return 'a first record has neither from nor previous, and a later one has both';
  return null;
}

/**
 * The record as the text that is signed: a JSON object with its members in alphabetical order and
 * no white space, so that every party rebuilds the same bytes from the members.
 */
export function headAnchorRecordText(
  r: Omit<HeadAnchorRecord, 'format'>,
): HistoryResult<{ text: string }> {
  const problem = recordProblem(r);
  if (problem !== null) return refuse('validation_failed', problem);
  return {
    ok: true,
    text: JSON.stringify({
      format: HEAD_ANCHOR_FORMAT,
      from: r.from,
      leaves: r.leaves,
      previous: r.previous,
      root: r.root,
      tenant: r.tenant,
      to: r.to,
    }),
  };
}

/**
 * Reads a signed record's text. Refused unless it has exactly the members of a record, each of the
 * right shape, and is the text `headAnchorRecordText` gives for them: one record has one text.
 */
export function parseHeadAnchorRecord(text: string): HistoryResult<{ record: HeadAnchorRecord }> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse('validation_failed', 'the record is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return refuse('validation_failed', 'the record is not an object');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== RECORD_MEMBERS)
    return refuse('validation_failed', 'the record does not have the members of an anchor record');
  if (o['format'] !== HEAD_ANCHOR_FORMAT)
    return refuse('validation_failed', `the record is not of format ${HEAD_ANCHOR_FORMAT}`);
  const record = o as unknown as HeadAnchorRecord;
  const again = headAnchorRecordText(record);
  if (!again.ok) return again;
  if (again.text !== text)
    return refuse('validation_failed', 'the record is not in its canonical form');
  return { ok: true, record };
}

/** What a relying party is given to prove that one head was covered by a record. */
export interface HeadProof {
  head: AnchoredHead;
  path: PathStep[];
}

/**
 * Whether a head was covered by a record: its leaf, folded along the path, is the record's root.
 * It says nothing about the signature over the record, and nothing about the log the head is of.
 */
export async function headCovered(
  record: Pick<HeadAnchorRecord, 'root'>,
  proof: HeadProof,
): Promise<HistoryResult<{ covered: boolean; leaf: string }>> {
  if (typeof proof !== 'object' || proof === null || !Array.isArray(proof.path))
    return refuse('validation_failed', 'a proof is a head and a path');
  const leaf = await anchorLeaf(proof.head);
  if (!leaf.ok) return leaf;
  const root = await rootFromPath(leaf.leaf, proof.path);
  if (!root.ok) return root;
  return { ok: true, covered: root.root === record.root, leaf: leaf.leaf };
}

/** The text of the leaf list that is stored next to a record, so that a path can be given later. */
export function leafListText(tree: AnchorTree): string {
  return JSON.stringify({
    format: 'docedit-anchor-leaves/1',
    root: tree.root,
    leaves: tree.leaves.map((l) => ({
      doc: l.doc,
      incarnation: l.incarnation,
      seq: l.seq,
      chainHead: l.chainHead,
      leaf: l.leaf,
    })),
  });
}

/**
 * Reads a stored leaf list and builds its tree again. Refused when it is not a leaf list, or when
 * the leaves do not lead to the root it names: a list that was changed gives no path.
 */
export async function parseLeafList(text: string): Promise<HistoryResult<{ tree: AnchorTree }>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse('validation_failed', 'the leaf list is not JSON');
  }
  const o = value as { format?: unknown; root?: unknown; leaves?: unknown } | null;
  if (
    typeof o !== 'object' ||
    o === null ||
    o.format !== 'docedit-anchor-leaves/1' ||
    typeof o.root !== 'string' ||
    !Array.isArray(o.leaves)
  )
    return refuse('validation_failed', 'not a leaf list of format docedit-anchor-leaves/1');
  const heads: AnchoredHead[] = [];
  for (const l of o.leaves as Array<Partial<AnchorLeaf> | null>) {
    if (typeof l !== 'object' || l === null)
      return refuse('validation_failed', 'a leaf is an object');
    heads.push({
      doc: l.doc as string,
      incarnation: l.incarnation as string,
      seq: l.seq as number,
      chainHead: l.chainHead as string,
    });
  }
  const tree = await anchorTree(heads);
  if (!tree.ok) return tree;
  if (tree.root !== o.root)
    return refuse('validation_failed', 'the leaves do not lead to the root the list names');
  return { ok: true, tree: { root: tree.root, leaves: tree.leaves } };
}
