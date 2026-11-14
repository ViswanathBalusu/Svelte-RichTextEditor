/**
 * Writes spec/export/diagnostic-codes-1.json from the worker's catalogue (EXP-065 criterion 4).
 *
 *   node services/export-worker/scripts/write-diagnostic-codes.ts
 *
 * The file is generated: edit `diagnostics.ts`, then run this script. The test
 * `src/exp-065-codes-artifact.test.ts` fails while the file is out of date.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnosticCodesFile } from '../src/exp-065-codes-artifact.ts';

const target = fileURLToPath(
  new URL('../../../spec/export/diagnostic-codes-1.json', import.meta.url),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, diagnosticCodesFile(), 'utf8');
process.stdout.write(`wrote ${target}\n`);
