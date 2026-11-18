#!/usr/bin/env node
// Verifies a document's log and its hash chain (08 §12; 06 §9; HIS-033).
//
//   node packages/history/scripts/verify-log.ts <bundle.json | -> [--anchor <seq>:<hash>]...
//        [--anchors <file.json>] [--no-replay]
//
// A workflow evidence bundle (`docedit-workflow-evidence/1`, FRW-055) gives a verdict with findings.
// The bundle is the exported log of a document (`docedit-log-bundle/1`; ADR 0051): the metadata
// rows with their payload hashes and hashes, the payloads that are still held, checkpoints with
// their content hashes and the chain heads a host or an anchor recorded. The tool recomputes the
// chain, checks every payload it is given, compares the supplied heads, and replays the log from
// each checkpoint it can reach to the next one. It writes one JSON report to standard output and
// nothing else: no document text, not even in a reason.
//
// Exit codes: 0 intact, 1 altered, 2 incomplete (something could not be checked), 3 unreadable.
import { readFileSync } from 'node:fs';
import { cdmSchema } from '@docedit/model/prosemirror';
import { type Anchor, EXIT, type LogBundle, verifyBundle } from '../src/chain.ts';
import { isAuditSegment, verifySegment } from '../src/audit-segment.ts';
import {
  isWorkflowEvidenceBundle,
  verifyWorkflowEvidenceBundle,
} from '../src/workflow-evidence-bundle.ts';

function fail(reason: string): never {
  process.stdout.write(`${JSON.stringify({ status: 'unreadable', reason })}\n`);
  process.exit(EXIT.unreadable);
}

const args = process.argv.slice(2);
let file: string | undefined;
const anchors: Anchor[] = [];
let replay = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--anchor') {
    const m = /^(\d+):([0-9a-f]{64})$/.exec(args[++i] ?? '');
    if (!m) fail('--anchor takes <seq>:<64 hexadecimal digits>');
    anchors.push({ seq: Number(m[1]), hash: m[2]!, source: 'argument' });
  } else if (a === '--anchors') {
    let list: unknown;
    try {
      list = JSON.parse(readFileSync(args[++i] ?? '', 'utf8'));
    } catch {
      fail('the anchors file cannot be read as JSON');
    }
    if (!Array.isArray(list)) fail('the anchors file holds a list of { seq, hash }');
    for (const x of list as Anchor[]) anchors.push({ ...x, source: x.source ?? 'file' });
  } else if (a === '--no-replay') replay = false;
  else if (a === '--help' || a === '-h') {
    process.stdout.write(
      'usage: verify-log <bundle.json | -> [--anchor <seq>:<hash>]... [--anchors <file>] [--no-replay]\n',
    );
    process.exit(0);
  } else if (file === undefined) file = a;
  else fail(`unexpected argument ${a}`);
}
if (file === undefined) fail('no bundle given');

let bundle: LogBundle;
let parsed: unknown;
try {
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  parsed = JSON.parse(text);
  bundle = parsed as LogBundle;
} catch {
  fail('the bundle cannot be read as JSON');
}

// A workflow evidence bundle (FRW-055) is checked as a whole: the log segment and the evidence items.
if (isWorkflowEvidenceBundle(parsed)) {
  const verdict = await verifyWorkflowEvidenceBundle(parsed, { anchors });
  process.stdout.write(`${JSON.stringify(verdict)}
`);
  process.exit(
    verdict.ok ? EXIT.intact : verdict.log.status === 'incomplete' ? EXIT.incomplete : EXIT.altered,
  );
}

// An audit segment (HIS-037) is checked from its first seq, with the same checks as a whole log.
const report = isAuditSegment(parsed)
  ? await verifySegment(parsed, { anchors })
  : await verifyBundle(bundle, {
      anchors,
      ...(replay ? { schema: cdmSchema() } : {}),
    });
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(EXIT[report.status]);
