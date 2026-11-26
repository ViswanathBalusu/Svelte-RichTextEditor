#!/usr/bin/env node
// Verifies a finalised workflow from its evidence bundle and its sealed PDF (12 §8.2 step 4, §10;
// FRW-055 criterion 2). It needs no access to the service:
//
//   node services/signing-service/scripts/verify-final.ts <bundle.json> <sealed.pdf>
//        --root <root certificate (PEM or DER)>... [--anchor <anchor file.json>]
//        [--pdftotext <command>] [--skip-certificate]
//
// 1. The bundle: the hash chain over the log segment, each control commit's payload, every salted
//    evidence commitment, and that each signing, completion and decline is in the chain.
// 2. The PDF: every signature and time-stamp by `/ByteRange`, to the roots you name. The tool
//    trusts no root of its own.
// 3. With `--anchor`: the signed, time-stamped chain head at completion, and that it is the
//    bundle's chain at that `seq`.
// 4. The certificate of completion in the PDF: its chain head is the hash of the bundle's commit at
//    the sequence number it names, and it names this document and workflow. The text is read with
//    `pdftotext` (poppler; `--pdftotext` names it); `--skip-certificate` leaves this check out, and
//    then the report says `skipped`.
//
// It writes one JSON report to standard output and nothing else. Exit 0: everything checked is
// intact. 1: something is altered or does not verify. 2: the log segment is incomplete. 3: an
// argument or file cannot be read. It does not say who anyone is: a participant's authentication
// is as asserted by the host.
import { readFileSync } from 'node:fs';
import {
  isWorkflowEvidenceBundle,
  verifyWorkflowEvidenceBundle,
} from '../../../packages/history/src/workflow-evidence-bundle.ts';
import { pdfText, readCertificate } from '../src/certificate-head.ts';
import { rootsOf, verifyAnchorFile, verifySealedPdf } from '../src/verify-sealed.ts';

function fail(reason: string): never {
  process.stdout.write(`${JSON.stringify({ status: 'unreadable', reason })}\n`);
  process.exit(3);
}

const args = process.argv.slice(2);
const files: string[] = [];
const rootFiles: string[] = [];
let anchorFile: string | undefined;
let pdftotext = 'pdftotext';
let skipCertificate = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--root') rootFiles.push(args[++i] ?? fail('--root takes a file'));
  else if (a === '--anchor') anchorFile = args[++i] ?? fail('--anchor takes a file');
  else if (a === '--pdftotext') pdftotext = args[++i] ?? fail('--pdftotext takes a command');
  else if (a === '--skip-certificate') skipCertificate = true;
  else if (a === '--help' || a === '-h') {
    process.stdout.write(
      'usage: verify-final <bundle.json> <sealed.pdf> --root <file>... [--anchor <file>] [--pdftotext <command>] [--skip-certificate]\n',
    );
    process.exit(0);
  } else files.push(a);
}
if (files.length !== 2) fail('give the bundle and the sealed PDF');
if (rootFiles.length === 0) fail('name at least one trusted root with --root');

const read = (f: string): Buffer => {
  try {
    return readFileSync(f);
  } catch {
    return fail(`cannot read ${f}`);
  }
};
let bundle: unknown;
try {
  bundle = JSON.parse(read(files[0]!).toString('utf8'));
} catch {
  fail('the bundle is not JSON');
}
if (!isWorkflowEvidenceBundle(bundle)) fail('the first file is not a workflow evidence bundle');
const roots = rootsOf(rootFiles.map((f) => new Uint8Array(read(f))));

const evidence = await verifyWorkflowEvidenceBundle(bundle);
const seal = await verifySealedPdf(new Uint8Array(read(files[1]!)), roots);

let anchor: Awaited<ReturnType<typeof verifyAnchorFile>> | null = null;
let anchorMatches: boolean | null = null;
if (anchorFile !== undefined) {
  let parsed: { record: string; recordSha256: string; cms: string };
  try {
    parsed = JSON.parse(read(anchorFile).toString('utf8'));
  } catch {
    fail('the anchor file is not JSON');
  }
  anchor = await verifyAnchorFile(parsed, roots);
  const rec = anchor.record;
  const at = rec === null ? undefined : bundle.log.commits.find((c) => c.meta.seq === rec.seq);
  anchorMatches =
    rec !== null &&
    at !== undefined &&
    at.hash === rec.chainHead &&
    rec.document === bundle.doc &&
    rec.workflow === bundle.workflow;
}

// 4. The certificate pages: the text of the PDF names the document and the workflow, the sequence
//    number at completion and the chain head at that number; the head must be the hash of the
//    bundle's commit at that number. The text is read with pdftotext.
let certificate: {
  status: 'matches' | 'differs' | 'absent' | 'skipped';
  completedSeq: number | null;
  chainHead: string | null;
  bundleHead: string | null;
  problems: string[];
} = { status: 'skipped', completedSeq: null, chainHead: null, bundleHead: null, problems: [] };
if (!skipCertificate) {
  const text = pdfText(new Uint8Array(read(files[1]!)), pdftotext);
  if (!text.ok && text.missing)
    fail(
      `${text.reason}; install poppler (pdftotext), name it with --pdftotext, or leave this check out with --skip-certificate`,
    );
  const c = readCertificate(text.ok ? text.text : '');
  const at =
    c.completedSeq === null
      ? undefined
      : bundle.log.commits.find((x) => x.meta.seq === c.completedSeq);
  const problems: string[] = text.ok ? [] : [text.reason];
  if (c.chainHead === null || c.completedSeq === null)
    problems.push('the PDF has no certificate of completion with a chain head');
  else {
    if (at === undefined)
      problems.push(`the bundle has no commit at sequence number ${c.completedSeq}`);
    else if (at.hash !== c.chainHead)
      problems.push(`the certificate's chain head is not the bundle's hash at ${c.completedSeq}`);
  }
  if (c.documentId !== null && c.documentId !== bundle.doc)
    problems.push('the certificate names another document');
  if (c.workflowId !== null && c.workflowId !== bundle.workflow)
    problems.push('the certificate names another workflow');
  certificate = {
    status:
      c.chainHead === null || c.completedSeq === null
        ? 'absent'
        : problems.length === 0
          ? 'matches'
          : 'differs',
    completedSeq: c.completedSeq,
    chainHead: c.chainHead,
    bundleHead: at?.hash ?? null,
    problems,
  };
}

const ok =
  evidence.ok &&
  seal.ok &&
  (anchor === null || (anchor.ok && anchorMatches === true)) &&
  (certificate.status === 'matches' || certificate.status === 'skipped');
process.stdout.write(
  `${JSON.stringify({ status: ok ? 'intact' : 'failed', evidence, seal, anchor, anchorMatches, certificate })}\n`,
);
process.exit(ok ? 0 : evidence.log.status === 'incomplete' && seal.ok ? 2 : 1);
