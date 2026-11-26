#!/usr/bin/env node
// Checks a head of a document's log against the public transparency log (08 §12; SEC-067; ADR 0409).
// It needs no network and no access to the service:
//
//   node services/document-service/scripts/verify-public-anchor.ts <evidence.json | segment.json>
//        --log-key <the log's public key text, or a file that holds it>
//        [--bundle <log bundle or audit segment>]
//
// The first file is either one piece of public anchor evidence (`docedit-public-anchor/1`: the
// public entry, the log's receipt, the head, the tenant's salt and the inclusion path) or an audit
// segment (`docedit-audit-segment/1`) that carries them in `publicAnchors`. A segment is also the
// log that is checked, unless `--bundle` names another. The log's public key comes from you, not
// from the receipt.
//
// It checks, and reports on its own: the entry, the proof of the head in the entry's root, the
// receipt (the checkpoint's signature with the log's key, the checkpoint, the inclusion proof) and
// the chain up to the head. It writes one JSON report to standard output and nothing else.
//
// Exit 0: everything holds and the log ends at the anchored head. 1: something does not verify,
// among them a chain rewritten after its root was published ("the head of the log at seq N is not in
// the published root"). 2: nothing is wrong, but something could not be checked (no log given, no
// receipt yet, no key). 3: an argument or a file cannot be read. 4: "not yet anchored": the log
// reaches past the anchored head, and the commits after it are covered only when the next root is
// published; the report names the end of the period of the root that covers the head. This is not a
// failure. Between a commit and the end of the period that follows it, a head is in this state.
import { readFileSync } from 'node:fs';
import { isAuditSegment, PUBLIC_ANCHOR_FORMAT, type PublicAnchorEvidence } from '@docedit/history';
import { parseVerifierKey } from '../src/transparency/tlog.ts';
import {
  PUBLIC_ANCHOR_EXIT,
  verifyPublicAnchor,
  type PublicAnchorReport,
} from '../src/transparency/verify-public-anchor.ts';

function fail(reason: string): never {
  process.stdout.write(`${JSON.stringify({ status: 'unreadable', reason })}\n`);
  process.exit(3);
}

const args = process.argv.slice(2);
let file: string | undefined;
let keyArg: string | undefined;
let bundleFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--log-key') keyArg = args[++i];
  else if (a === '--bundle') bundleFile = args[++i];
  else if (a === '--help' || a === '-h') {
    process.stdout.write(
      'usage: verify-public-anchor <evidence.json | segment.json> --log-key <key | file> [--bundle <file>]\n',
    );
    process.exit(0);
  } else if (file === undefined) file = a;
  else fail(`unexpected argument ${a}`);
}
if (file === undefined) fail('no evidence or segment given');

function json(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail(`${what} cannot be read as JSON`);
  }
}

let logKey;
if (keyArg !== undefined) {
  let text = keyArg;
  try {
    if (!/^[^+\s]+\+[0-9a-f]{8}\+/.test(keyArg)) text = readFileSync(keyArg, 'utf8');
  } catch {
    fail('the log key is neither a key text nor a readable file');
  }
  logKey = parseVerifierKey(text);
  if (logKey === null) fail('the log key is not a verifier key (name+hash+base64)');
}

const input = json(file, 'the evidence') as Record<string, unknown> | null;
let evidence: PublicAnchorEvidence[];
let chain;
if (isAuditSegment(input)) {
  evidence = input.publicAnchors ?? [];
  chain = input;
} else if (
  input !== null &&
  typeof input === 'object' &&
  input['format'] === PUBLIC_ANCHOR_FORMAT
) {
  evidence = [input as unknown as PublicAnchorEvidence];
} else {
  fail(`the file is neither ${PUBLIC_ANCHOR_FORMAT} evidence nor an audit segment`);
}
if (bundleFile !== undefined) {
  const given = json(bundleFile, 'the bundle') as { doc?: unknown; commits?: unknown } | null;
  if (given === null || typeof given !== 'object' || !Array.isArray(given.commits))
    fail('the bundle is neither a log bundle nor an audit segment');
  chain = given as typeof chain;
}
if (evidence.length === 0)
  fail('the segment carries no public anchor: the service has none for this range');

const reports: PublicAnchorReport[] = [];
for (const e of evidence) reports.push(await verifyPublicAnchor(e, { logKey, chain }));
const order = ['failed', 'incomplete', 'not-yet-anchored', 'verified'] as const;
const status = order.find((s) => reports.some((r) => r.status === s))!;
process.stdout.write(`${JSON.stringify({ status, reports })}\n`);
process.exit(PUBLIC_ANCHOR_EXIT[status]);
