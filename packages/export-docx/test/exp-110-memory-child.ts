/**
 * EXP-110, criterion 2 (memory half): run by `exp-110-memory.test.ts` in a fresh Node.js process.
 * Prints one JSON line: whether the import was refused, the time it took, and the peak resident
 * set size (kilobytes, from process.resourceUsage) before and after the import. The baseline
 * includes the loaded modules and the bytes of the file, so the difference is the import's own peak.
 */
import { importDocx, ImportError } from '../src/index.ts';
import { readCase } from './exp-110-memory-cases.ts';

const path = process.argv[2];
if (path === undefined) throw new Error('usage: exp-110-memory-child.ts <case file>');
const bytes = readCase(path);
const baseKiB = process.resourceUsage().maxRSS;
const start = performance.now();
let refused = false;
let message = '';
try {
  await importDocx(bytes);
} catch (e) {
  refused = true;
  message = e instanceof ImportError ? `ImportError: ${e.message}` : String(e);
}
const ms = performance.now() - start;
const peakKiB = process.resourceUsage().maxRSS;
process.stdout.write(JSON.stringify({ refused, message, ms, baseKiB, peakKiB }) + '\n');
