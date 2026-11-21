#!/usr/bin/env node
// Verifies that the head of a document's log was anchored (08 §12; HIS-036 criterion 6; ADR 0409).
// It needs no access to the service:
//
//   node services/signing-service/scripts/verify-anchor.ts <anchor file.json>
//        --root <root certificate (PEM or DER)>...
//        ( --proof <proof.json> | --leaves <leaf list.json> --doc <document id> )
//        [--bundle <log bundle.json>] [--previous <the anchor file before this one>]
//
// 1. The anchor file: the record's hash, the signature over it, the signer's chain to a root you
//    name, and the RFC 3161 time-stamp token over the signature value. The tool trusts no root of
//    its own.
// 2. The head: its leaf, folded along its inclusion path, is the root the signed record names. The
//    proof is the head and the path (what a relying party is given). An operator who holds the leaf
//    list of the record names a document instead, and the tool computes the path and prints it.
// 3. With `--bundle` (an exported log, `docedit-log-bundle/1`): the hash chain of the log, and that
//    the anchored head is the hash of the log at that `seq`. Checkpoints are not replayed here;
//    `verify-log` of `@docedit/history` does that.
// 4. With `--previous`: that the record names the hash of the record before it, so that a record
//    left out shows.
//
// It writes one JSON report to standard output and nothing else. Exit 0: the signature, the
// time-stamp, the path and the comparison with the chain all hold. 1: something does not verify.
// 2: the signature and the time-stamp hold, but the head was not compared with a chain (no proof or
// no bundle was given, or the bundle is incomplete). 3: an argument or file cannot be read.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  BUNDLE_FORMAT,
  type LogBundle,
  verifyBundle,
} from '../../../packages/history/src/chain.ts';
import {
  anchorPath,
  headCovered,
  parseHeadAnchorRecord,
  parseLeafList,
  type HeadProof,
} from '../../../packages/history/src/head-anchor.ts';
import { rootsOf, verifyBatchAnchorFile } from '../src/verify-sealed.ts';

function fail(reason: string): never {
  process.stdout.write(`${JSON.stringify({ status: 'unreadable', reason })}\n`);
  process.exit(3);
}

const args = process.argv.slice(2);
const files: string[] = [];
const rootFiles: string[] = [];
let proofFile: string | undefined;
let leavesFile: string | undefined;
let doc: string | undefined;
let bundleFile: string | undefined;
let previousFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  const value = (): string => args[++i] ?? fail(`${a} takes a value`);
  if (a === '--root') rootFiles.push(value());
  else if (a === '--proof') proofFile = value();
  else if (a === '--leaves') leavesFile = value();
  else if (a === '--doc') doc = value();
  else if (a === '--bundle') bundleFile = value();
  else if (a === '--previous') previousFile = value();
  else if (a === '--help' || a === '-h') {
    process.stdout.write(
      'usage: verify-anchor <anchor file.json> --root <file>... (--proof <file> | --leaves <file> --doc <id>) [--bundle <file>] [--previous <file>]\n',
    );
    process.exit(0);
  } else if (a.startsWith('--')) fail(`unknown option ${a}`);
  else files.push(a);
}
if (files.length !== 1) fail('give one anchor file');
if (rootFiles.length === 0) fail('name at least one trusted root with --root');
if (proofFile !== undefined && leavesFile !== undefined)
  fail('give a proof or a leaf list, not both');
if ((leavesFile === undefined) !== (doc === undefined))
  fail('--leaves and --doc are given together');

const read = (f: string): Buffer => {
  try {
    return readFileSync(f);
  } catch {
    return fail(`cannot read ${f}`);
  }
};
const json = (f: string, what: string): unknown => {
  try {
    return JSON.parse(read(f).toString('utf8'));
  } catch {
    return fail(`${what} is not JSON`);
  }
};
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

interface AnchorFile {
  record: string;
  recordSha256: string;
  cms: string;
}
const isAnchorFile = (v: unknown): v is AnchorFile =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as AnchorFile).record === 'string' &&
  typeof (v as AnchorFile).recordSha256 === 'string' &&
  typeof (v as AnchorFile).cms === 'string';

const file = json(files[0]!, 'the anchor file');
if (!isAnchorFile(file)) fail('the first file is not an anchor file');
const roots = rootsOf(rootFiles.map((f) => new Uint8Array(read(f))));

// 1. The signature and the time-stamp.
const signature = await verifyBatchAnchorFile(file, roots);
const parsed = parseHeadAnchorRecord(file.record);
const record = parsed.ok ? parsed.record : null;
const problems: string[] = [];
if (!parsed.ok) problems.push(`record: ${parsed.reason}`);

// 2. The head under the record's root.
let proof: HeadProof | null = null;
let covered: boolean | null = null;
if (proofFile !== undefined) {
  const p = json(proofFile, 'the proof') as Partial<HeadProof> | null;
  if (typeof p !== 'object' || p === null || typeof p.head !== 'object' || !Array.isArray(p.path))
    fail('the proof is not a head and a path');
  proof = { head: p.head!, path: p.path };
} else if (leavesFile !== undefined && doc !== undefined) {
  const list = await parseLeafList(read(leavesFile).toString('utf8'));
  if (!list.ok) fail(`the leaf list: ${list.reason}`);
  if (
    record !== null &&
    (list.tree.root !== record.root || list.tree.leaves.length !== record.leaves)
  )
    problems.push('the leaf list is not the one the record names');
  const path = await anchorPath(list.tree, doc);
  if (!path.ok) problems.push(`path: ${path.reason}`);
  else proof = { head: path.head, path: path.path };
}
if (proof !== null && record !== null) {
  const c = await headCovered(record, proof);
  if (!c.ok) problems.push(`proof: ${c.reason}`);
  else {
    covered = c.covered;
    if (!covered) problems.push('the head does not lead to the root of the record');
  }
}

// 3. The head against the chain of the log.
let chain: { status: string; head: number; commits: number; firstBadSeq?: number } | null = null;
let headMatchesChain: boolean | null = null;
if (bundleFile !== undefined) {
  const bundle = json(bundleFile, 'the bundle') as LogBundle | null;
  if (typeof bundle !== 'object' || bundle === null || bundle.format !== BUNDLE_FORMAT)
    fail(`the bundle is not of format ${BUNDLE_FORMAT}`);
  if (proof !== null) {
    // The chain and the payloads the bundle carries are checked here. Checkpoints are not replayed:
    // that is `verify-log` of `@docedit/history`, and it does not bear on the head.
    const report = await verifyBundle(
      { ...bundle, checkpoints: [] },
      { anchors: [{ seq: proof.head.seq, hash: proof.head.chainHead, source: 'anchor record' }] },
    );
    chain = {
      status: report.status,
      head: report.head,
      commits: report.commits,
      ...(report.firstBadSeq !== undefined ? { firstBadSeq: report.firstBadSeq } : {}),
    };
    const anchored = report.anchors.find((a) => a.source === 'anchor record');
    headMatchesChain = anchored?.result === 'match' && bundle.doc === proof.head.doc;
    if (report.status === 'altered') problems.push('the log does not verify');
    if (bundle.doc !== proof.head.doc) problems.push('the bundle is the log of another document');
    else if (anchored?.result === 'mismatch')
      problems.push('the anchored head is not the hash of the log at that seq');
    else if (anchored?.result !== 'match')
      problems.push('the log does not reach the seq of the anchored head');
  }
}

// 4. The link to the record before.
let previousMatches: boolean | null = null;
if (previousFile !== undefined) {
  const before = json(previousFile, 'the previous anchor file');
  if (!isAnchorFile(before)) fail('the previous file is not an anchor file');
  previousMatches = record !== null && record.previous === sha256Hex(before.record);
  if (!previousMatches) problems.push('the record does not name the record before it');
}

const signed = signature.ok && record !== null;
const failed = !signed || problems.length > 0;
const compared = covered === true && headMatchesChain === true && chain?.status !== 'incomplete';
const status = failed ? 'failed' : compared ? 'verified' : 'incomplete';
process.stdout.write(
  `${JSON.stringify({
    status,
    record,
    signature: {
      ok: signature.ok,
      timestampTime: signature.timestampTime,
      signer: signature.signer,
      problems: signature.problems,
    },
    proof,
    covered,
    chain,
    headMatchesChain,
    previousMatches,
    problems,
  })}\n`,
);
process.exit(status === 'verified' ? 0 : status === 'failed' ? 1 : 2);
