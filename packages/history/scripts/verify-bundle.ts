#!/usr/bin/env node
// Verifies a discovery or tenant export bundle offline (UX-087, UX-088; 08 §12; 13 §10).
//
//   node packages/history/scripts/verify-bundle.ts <directory>
//
// The directory holds `parts.json` and the parts it lists (`part-0001.tar`, ...), as the export job
// stores them. The tool checks each part against `parts.json`, each file against the manifest, each
// file against its documented format (docs/export-bundle-formats.md), the counts, every history
// file with the chain verifier, the heads against the manifest, and that no secret is in a file.
// It writes one JSON report to standard output and nothing else: no document text.
//
// Exit codes are those of `verify-log`: 0 intact, 1 altered, 2 incomplete, 3 unreadable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../src/chain.ts';
import { type PartsIndex, verifyExportBundle } from '../src/export-bundle.ts';

function fail(reason: string): never {
  process.stdout.write(`${JSON.stringify({ status: 'unreadable', reason })}\n`);
  process.exit(EXIT.unreadable);
}

const dir = process.argv[2];
if (dir === undefined || dir === '--help' || dir === '-h') {
  process.stdout.write('usage: verify-bundle <directory with parts.json>\n');
  process.exit(dir === undefined ? EXIT.unreadable : 0);
}
let index: Uint8Array;
try {
  index = new Uint8Array(readFileSync(join(dir, 'parts.json')));
} catch {
  fail('parts.json cannot be read in the directory');
}
const parts = new Map<string, Uint8Array>();
try {
  const listed = (JSON.parse(Buffer.from(index).toString('utf8')) as PartsIndex).parts;
  for (const p of Array.isArray(listed) ? listed : []) {
    try {
      parts.set(p.name, new Uint8Array(readFileSync(join(dir, p.name))));
    } catch {
      // A missing part is reported by the verifier.
    }
  }
} catch {
  fail('parts.json is not JSON');
}
const report = await verifyExportBundle({ parts, index });
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(EXIT[report.status]);
