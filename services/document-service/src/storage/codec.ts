/**
 * How a commit is written to the log (06 §4.1; 08 §2; FND-005): the payload as Zstandard-compressed
 * RFC 8785 JSON, the metadata that the hash covers, and the hash chain. The byte layout of the
 * chain is provisional until HIS-002 publishes it with test vectors; see
 * docs/adr/0020-commit-log-storage.md.
 *
 * Zstandard comes from node:zlib (Node.js 22.15 and later; marked experimental there).
 */
import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  SERVER_SESSION,
  isSnapshot,
  type LogCommit,
  type SnapshotReason,
  type StepJson,
  type ThreadAnchor,
} from '@docedit/authority';
import type { AttributionJson } from '@docedit/history';
import { canonicalize } from '@docedit/model';

/**
 * What the payload of a commit holds: the steps as applied, and what they imply. A snapshot commit
 * (04 §3.2) has no steps; its payload is the checkpoint reference (08 §2), which names the SHA-256
 * of the new content, so the hash chain covers the content too. The content itself is stored next
 * to the commit (`doc_snapshots`, migration 0030).
 */
export interface CommitPayload {
  steps: StepJson[];
  /** Region identifiers the commit removed, retired for good (I3). */
  retired: string[];
  /** Suggestion identifiers the commit used first (P4). */
  claimed: string[];
  /** A snapshot commit's checkpoint reference and reason. Absent for every other commit. */
  snapshot?: { checkpoint: string; reason: SnapshotReason };
  /**
   * The salted hash of the workflow evidence a control commit anchors (12 §7; FRW-041): the origin
   * (`sign` or `rules`) and the hash, nothing else. Absent from every other commit.
   */
  evidence?: { origin: 'sign' | 'rules'; evidenceHash: string };
}

/** The hashed metadata of one commit: the fields 08 §2 lists, in canonical form. */
export interface CommitMetadata {
  doc: string;
  seq: number;
  kind: LogCommit['kind'];
  id: string;
  user: string;
  session: string | null;
  agent: string | null;
  /** Server time, RFC 3339 in UTC with milliseconds (01 §8). */
  time: string;
  origin: string;
  /** Sorted by UTF-16 code units. */
  scopes: string[];
  base: number | null;
  rebased: boolean | null;
  revision: number;
  jti: string | null;
  cdm: number;
  engine: string;
  /** Bytes of the canonical payload before compression. */
  size: number;
}

export interface EncodedCommit {
  meta: CommitMetadata;
  /** UTF-8 of the canonical metadata. */
  metaBytes: Buffer;
  /** Zstandard-compressed canonical payload. */
  payload: Buffer;
  /** SHA-256 of the canonical payload. */
  payloadHash: Buffer;
}

/** The previous hash of the first commit of a log (provisional, ADR 0020). */
export const GENESIS_HASH: Buffer = Buffer.alloc(32);

const utf8 = (s: string) => Buffer.from(s, 'utf8');
const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/**
 * Encodes a commit for storage (08 §2; HIS-001). `base`, `rebased`, the token's `jti` and the agent
 * are recorded when the room stamped them and null otherwise: a control commit has no base and no
 * token, and a commit of a connection without an assistant identity has no agent.
 */
export function encodeCommit(doc: string, c: LogCommit): EncodedCommit {
  const payload: CommitPayload = { steps: c.steps, retired: c.retired, claimed: c.claimed };
  // Only a snapshot commit has the member, so the payloads of step and control commits, and their
  // hashes, are what they were before snapshot commits existed.
  if (isSnapshot(c))
    payload.snapshot = { checkpoint: c.snapshot.checkpoint, reason: c.snapshot.reason };
  // Likewise only an evidence anchor has this member, so no earlier hash changes.
  if (c.evidence !== undefined)
    payload.evidence = { origin: c.evidence.origin, evidenceHash: c.evidence.evidenceHash };
  const payloadJson = utf8(canonicalize(payload));
  const meta: CommitMetadata = {
    doc,
    seq: c.seq,
    kind: c.kind,
    id: c.id,
    user: c.user,
    // A server-authored commit has no session: the room's sentinel is stored as NULL (HIS-001).
    session: c.session === '' || c.session === SERVER_SESSION ? null : c.session,
    agent: c.agent ?? null,
    time: new Date(c.time).toISOString(),
    origin: c.origin,
    scopes: [...c.scopes].sort(),
    base: c.base ?? null,
    rebased: c.rebased ?? null,
    revision: c.revision,
    jti: c.jti ?? null,
    cdm: c.cdm,
    engine: c.engine,
    size: payloadJson.length,
  };
  return {
    meta,
    metaBytes: utf8(canonicalize(meta)),
    payload: zstdCompressSync(payloadJson),
    payloadHash: sha256(payloadJson),
  };
}

export function decodePayload(stored: Uint8Array): CommitPayload {
  const value = JSON.parse(zstdDecompressSync(stored).toString('utf8')) as CommitPayload;
  const out: CommitPayload = { steps: value.steps, retired: value.retired, claimed: value.claimed };
  if (value.snapshot) out.snapshot = value.snapshot;
  if (value.evidence) out.evidence = value.evidence;
  return out;
}

/** Content stored as a checkpoint is: canonical JSON text, compressed with Zstandard. */
export function encodeContent(canonicalText: string): Buffer {
  return zstdCompressSync(utf8(canonicalText));
}

export function decodeContent<T = unknown>(stored: Uint8Array): T {
  return JSON.parse(zstdDecompressSync(stored).toString('utf8')) as T;
}

/**
 * What the side object of a checkpoint holds (06 §2.2 step 3, §8; SYN-032 criterion 6): the comment
 * ranges at the checkpoint's `seq`, each anchor at that `seq`, and the attribution map (HIS-014,
 * ADR 0377). `v` is 1 for an object that carries the map.
 */
export interface CheckpointSide {
  v?: 1;
  seq: number;
  threads: ThreadAnchor[];
  attribution?: AttributionJson;
}

/** The side object as stored: canonical JSON (RFC 8785) compressed with Zstandard, like content. */
export function encodeSide(side: CheckpointSide): Buffer {
  return encodeContent(canonicalize(side));
}

export function decodeSide(stored: Uint8Array): CheckpointSide {
  const side = decodeContent<Partial<CheckpointSide>>(stored);
  // An object written with only the attribution map has no ranges and no `seq`.
  return { ...side, seq: side.seq ?? -1, threads: side.threads ?? [] };
}

/** hash = SHA-256(previous hash ‖ canonical metadata ‖ SHA-256(canonical payload)) (08 §2). */
export function chainHash(
  prev: Uint8Array | null,
  metaBytes: Uint8Array,
  payloadHash: Uint8Array,
): Buffer {
  return sha256(prev ?? GENESIS_HASH, metaBytes, payloadHash);
}

/** The canonical metadata bytes of a stored row, for verifying the chain (HIS-033 uses the same). */
export function metadataBytes(meta: CommitMetadata): Buffer {
  return utf8(canonicalize(meta));
}
