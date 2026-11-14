/**
 * Verifying a document's log and its hash chain (08 §2, §12; 06 §9; HIS-033), universal, so that
 * the command-line tool, the document service and a host can run the same checks.
 *
 * The layout is ADR 0020's (provisional until HIS-002 publishes test vectors):
 * `hash = SHA-256(prev ‖ M ‖ SHA-256(P))`, where `prev` is the hash of the commit at `seq − 1` or
 * 32 zero bytes for `seq` 1, `M` is the UTF-8 of the RFC 8785 JSON of the commit's metadata, and
 * `P` is the canonical payload. Each record keeps `SHA-256(P)`, so the chain verifies when a payload
 * was thinned, moved to a cold segment or replaced by a tombstone.
 *
 * Checks: the chain (the stored link to the previous hash and the recomputed hash), each payload
 * that is present against its stored hash, the head, chain heads supplied by a host or anchored
 * records, and every checkpoint that a replay can reach from the one before it. The report holds
 * sequence numbers, hashes and counts only: no document text, not even in a reason.
 */
import {
  canonicalize,
  documentHash,
  type JsonEnvelope,
  type JsonNode,
  sha256,
  toHex,
  utf8,
} from '@docedit/model';
import type { Schema } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';

export const BUNDLE_FORMAT = 'docedit-log-bundle/1';

/** The hashed metadata of one commit (ADR 0020; `CommitMetadata` of the document service). */
export interface ChainMetadata {
  doc: string;
  seq: number;
  kind: string;
  id: string;
  user: string;
  session: string | null;
  agent: string | null;
  time: string;
  origin: string;
  scopes: string[];
  base: number | null;
  rebased: boolean | null;
  revision: number;
  jti: string | null;
  cdm: number;
  engine: string;
  size: number;
}

export interface BundleCommit {
  meta: ChainMetadata;
  /** Lower-case hexadecimal SHA-256 of the canonical payload. */
  payloadHash: string;
  /** The stored link to the previous hash; null for `seq` 1. */
  prevHash: string | null;
  hash: string;
  /**
   * The payload (`{ steps, retired, claimed }`), when the bundle carries it; absent or null when it
   * was thinned, moved or tombstoned.
   */
  payload?: unknown;
}

export interface BundleCheckpoint {
  seq: number;
  /** SHA-256 of the canonical CDM form of the checkpoint (`documentHash` of its envelope). */
  contentHash: string;
  /** The checkpoint itself, needed only where a replay starts. */
  content?: JsonEnvelope;
  /** The envelope's `cdm` and `requires` when the content is not carried. */
  cdm?: number;
  requires?: string[];
}

export interface Anchor {
  seq: number;
  hash: string;
  /** Where the head came from: a webhook, an export manifest, an anchored record. */
  source?: string;
}

/** An exported log (the audit export of HIS-037 can carry this form). */
export interface LogBundle {
  format: typeof BUNDLE_FORMAT;
  doc: string;
  head: { seq: number; chainHead: string | null };
  commits: BundleCommit[];
  checkpoints?: BundleCheckpoint[];
  anchors?: Anchor[];
}

export type CheckKind = 'format' | 'gap' | 'chain' | 'payload' | 'head' | 'anchor' | 'checkpoint';

export interface Problem {
  check: CheckKind;
  seq?: number;
  /** Fixed wording: never document text. */
  reason: string;
  /** Whether it shows an alteration (a hash differs) rather than something missing. */
  altered: boolean;
}

export type VerifyStatus = 'intact' | 'altered' | 'incomplete';

export interface VerifyReport {
  status: VerifyStatus;
  doc: string;
  head: number;
  commits: number;
  /** Payloads present and checked against their stored hash. */
  payloadsChecked: number;
  /** Payloads not in the bundle (thinned, moved or tombstoned): the chain uses the stored hashes. */
  payloadsAbsent: number;
  /** The first `seq` whose record does not verify, if any. */
  firstBadSeq?: number;
  problems: Problem[];
  checkpoints: Array<{
    seq: number;
    result: 'match' | 'mismatch' | 'unchecked';
    from?: number;
    replayed?: number;
  }>;
  anchors: Array<{ seq: number; result: 'match' | 'mismatch' | 'unknown'; source?: string }>;
}

/** Exit codes of the command-line tool. */
export const EXIT: Readonly<Record<VerifyStatus | 'unreadable', number>> = {
  intact: 0,
  altered: 1,
  incomplete: 2,
  unreadable: 3,
};

const HEX64 = /^[0-9a-f]{64}$/;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const GENESIS = new Uint8Array(32);

/** `SHA-256(prev ‖ M ‖ payloadHash)` (08 §2; ADR 0020), as lower-case hexadecimal. */
export async function chainHash(
  prev: string | null,
  meta: ChainMetadata,
  payloadHash: string,
): Promise<string> {
  return toHex(
    await sha256(
      concat(prev ? fromHex(prev) : GENESIS, utf8(canonicalize(meta)), fromHex(payloadHash)),
    ),
  );
}

/** The SHA-256 of a canonical payload, and its size in bytes (the metadata's `size`). */
export async function payloadDigest(payload: unknown): Promise<{ hash: string; size: number }> {
  const bytes = utf8(canonicalize(payload));
  return { hash: toHex(await sha256(bytes)), size: bytes.length };
}

export interface VerifyOptions {
  /** The CDM schema, for replaying payloads between checkpoints; without it no replay runs. */
  schema?: Schema;
  /** Chain heads supplied besides those in the bundle. */
  anchors?: readonly Anchor[];
  /**
   * The first `seq` the bundle is expected to hold, for an audit segment (HIS-037) that starts
   * after `seq` 1. The link into that record is its stored previous hash; no gap is reported before it.
   */
  firstSeq?: number;
}

function bundleProblem(reason: string): VerifyReport {
  return {
    status: 'incomplete',
    doc: '',
    head: 0,
    commits: 0,
    payloadsChecked: 0,
    payloadsAbsent: 0,
    problems: [{ check: 'format', reason, altered: false }],
    checkpoints: [],
    anchors: [],
  };
}

/** Verifies a log bundle (see the module comment). */
export async function verifyBundle(
  bundle: LogBundle,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  if (!bundle || bundle.format !== BUNDLE_FORMAT || !Array.isArray(bundle.commits) || !bundle.head)
    return bundleProblem(`not a bundle of format ${BUNDLE_FORMAT}`);
  const problems: Problem[] = [];
  const add = (p: Problem) => problems.push(p);
  const commits = [...bundle.commits].sort((a, b) => a.meta.seq - b.meta.seq);
  const hashAt = new Map<number, string>();
  let payloadsChecked = 0;
  let payloadsAbsent = 0;
  let prev: string | null = null;
  let expected = options.firstSeq ?? 1;
  for (const c of commits) {
    const seq = c.meta?.seq;
    if (
      !Number.isSafeInteger(seq) ||
      !HEX64.test(c.hash ?? '') ||
      !HEX64.test(c.payloadHash ?? '')
    ) {
      add({
        check: 'format',
        ...(Number.isSafeInteger(seq) ? { seq } : {}),
        reason: 'a record is malformed',
        altered: false,
      });
      continue;
    }
    if (c.meta.doc !== bundle.doc)
      add({ check: 'chain', seq, reason: 'the record names another document', altered: true });
    if (seq !== expected) {
      // Lost, or left out of the bundle: the log is incomplete, and the link across the gap cannot
      // be checked, so the stored link is used from here on.
      add({
        check: 'gap',
        seq: expected,
        reason: `records ${expected} to ${seq - 1} are missing`,
        altered: false,
      });
      prev = null;
    }
    const storedPrev = c.prevHash;
    if (seq === 1 && storedPrev !== null)
      add({ check: 'chain', seq, reason: 'the first record has a previous hash', altered: true });
    if (prev !== null && storedPrev !== prev)
      add({
        check: 'chain',
        seq,
        reason: 'the previous hash does not match the preceding record',
        altered: true,
      });
    const link = prev ?? (seq === 1 ? null : storedPrev);
    if (link !== null && !HEX64.test(link)) {
      add({ check: 'format', seq, reason: 'the previous hash is malformed', altered: false });
    } else {
      const h = await chainHash(link, c.meta, c.payloadHash);
      if (h !== c.hash)
        add({ check: 'chain', seq, reason: 'the hash does not match the record', altered: true });
    }
    if (c.payload !== undefined && c.payload !== null) {
      const d = await payloadDigest(c.payload);
      payloadsChecked++;
      if (d.hash !== c.payloadHash)
        add({
          check: 'payload',
          seq,
          reason: 'the payload does not match its stored hash',
          altered: true,
        });
      else if (d.size !== c.meta.size)
        add({
          check: 'payload',
          seq,
          reason: 'the payload size does not match the record',
          altered: true,
        });
    } else payloadsAbsent++;
    hashAt.set(seq, c.hash);
    // Continue from the stored hash, so that a second alteration further on is found as well.
    prev = c.hash;
    expected = seq + 1;
  }
  const last = expected - 1;
  if (bundle.head.seq !== last)
    add({
      check: 'head',
      seq: bundle.head.seq,
      reason: `the head is ${bundle.head.seq} but the log ends at ${last}`,
      altered: bundle.head.seq < last,
    });
  else if ((bundle.head.chainHead ?? null) !== (hashAt.get(last) ?? null))
    add({
      check: 'head',
      seq: last,
      reason: 'the chain head does not match the last record',
      altered: true,
    });

  const anchors: VerifyReport['anchors'] = [];
  for (const a of [...(bundle.anchors ?? []), ...(options.anchors ?? [])]) {
    const stored = hashAt.get(a.seq);
    const entry: VerifyReport['anchors'][number] = {
      seq: a.seq,
      result: stored === undefined ? 'unknown' : stored === a.hash ? 'match' : 'mismatch',
    };
    if (a.source !== undefined) entry.source = a.source;
    anchors.push(entry);
    if (entry.result === 'mismatch')
      add({
        check: 'anchor',
        seq: a.seq,
        reason: 'an anchored head does not match the chain',
        altered: true,
      });
    else if (entry.result === 'unknown')
      add({
        check: 'anchor',
        seq: a.seq,
        reason: 'an anchored head lies outside the log',
        altered: false,
      });
  }

  const checkpoints = options.schema
    ? await verifyCheckpoints(bundle, commits, options.schema, add)
    : (bundle.checkpoints ?? []).map((k) => ({ seq: k.seq, result: 'unchecked' as const }));

  const bad = problems.filter((p) => p.seq !== undefined).map((p) => p.seq!);
  const report: VerifyReport = {
    status: problems.some((p) => p.altered)
      ? 'altered'
      : problems.length || checkpoints.some((k) => k.result === 'unchecked')
        ? 'incomplete'
        : 'intact',
    doc: bundle.doc,
    head: bundle.head.seq,
    commits: commits.length,
    payloadsChecked,
    payloadsAbsent,
    problems,
    checkpoints,
    anchors,
  };
  const alteredSeqs = problems.filter((p) => p.altered && p.seq !== undefined).map((p) => p.seq!);
  if (alteredSeqs.length) report.firstBadSeq = Math.min(...alteredSeqs);
  else if (bad.length) report.firstBadSeq = Math.min(...bad);
  return report;
}

interface PayloadSteps {
  steps: unknown[];
}

const hasSteps = (p: unknown): p is PayloadSteps =>
  typeof p === 'object' && p !== null && Array.isArray((p as PayloadSteps).steps);

/** Rebuilds each checkpoint from the one before it and compares the content hash (HIS-033). */
async function verifyCheckpoints(
  bundle: LogBundle,
  commits: readonly BundleCommit[],
  schema: Schema,
  add: (p: Problem) => void,
): Promise<VerifyReport['checkpoints']> {
  const out: VerifyReport['checkpoints'] = [];
  const list = [...(bundle.checkpoints ?? [])].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(commits.map((c) => [c.meta.seq, c]));
  for (let i = 0; i < list.length; i++) {
    const k = list[i]!;
    // A checkpoint whose content the bundle carries is checked against its own hash.
    if (k.content) {
      const h = await documentHash(k.content);
      if (h !== k.contentHash) {
        add({
          check: 'checkpoint',
          seq: k.seq,
          reason: 'a checkpoint does not match its content hash',
          altered: true,
        });
        out.push({ seq: k.seq, result: 'mismatch' });
        continue;
      }
    }
    // A replay from the nearest earlier checkpoint whose content the bundle carries.
    let start: BundleCheckpoint | undefined;
    for (let j = i - 1; j >= 0; j--)
      if (list[j]!.content) {
        start = list[j]!;
        break;
      }
    if (!start) {
      out.push({ seq: k.seq, result: k.content ? 'match' : 'unchecked' });
      continue;
    }
    let doc;
    try {
      doc = schema.nodeFromJSON(start.content!.doc);
    } catch {
      out.push({ seq: k.seq, result: 'unchecked', from: start.seq });
      continue;
    }
    let ok = true;
    let replayed = 0;
    for (let s = start.seq + 1; s <= k.seq && ok; s++) {
      const c = bySeq.get(s);
      if (!c || c.payload === undefined || c.payload === null || !hasSteps(c.payload)) {
        ok = false;
        break;
      }
      if (c.meta.kind === 'snapshot') {
        ok = false; // The content after a snapshot is its own checkpoint.
        break;
      }
      try {
        for (const json of c.payload.steps) {
          const r = Step.fromJSON(schema, json).apply(doc);
          if (!r.doc) throw new Error('step failed');
          doc = r.doc;
        }
      } catch {
        // The reason never carries the library's message: it can quote document text.
        add({ check: 'checkpoint', seq: s, reason: `commit ${s} does not replay`, altered: true });
        out.push({ seq: k.seq, result: 'mismatch', from: start.seq, replayed });
        ok = false;
        replayed = -1;
        break;
      }
      replayed++;
    }
    if (replayed < 0) continue;
    if (!ok) {
      out.push({ seq: k.seq, result: 'unchecked', from: start.seq });
      continue;
    }
    const h = await documentHash({
      cdm: k.cdm ?? start.content!.cdm,
      requires: k.requires ?? start.content!.requires,
      doc: doc.toJSON() as JsonNode,
    });
    if (h === k.contentHash) out.push({ seq: k.seq, result: 'match', from: start.seq, replayed });
    else {
      add({
        check: 'checkpoint',
        seq: k.seq,
        reason: 'a replay does not reach the checkpoint',
        altered: true,
      });
      out.push({ seq: k.seq, result: 'mismatch', from: start.seq, replayed });
    }
  }
  return out;
}
