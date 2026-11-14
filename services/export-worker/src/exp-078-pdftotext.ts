/**
 * EXP-078 (lane V-EXP-065-080): the text positions of a PDF, read with poppler's `pdftotext
 * -bbox-layout`. The binary is named by DOCEDIT_PDFTOTEXT, or looked up on the PATH. The file is
 * written to a new temporary directory, which is removed afterwards.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parsePages, type PageText } from './exp-078-reference-diff.ts';

const run = promisify(execFile);

export function pdftotextCli(): string {
  return process.env['DOCEDIT_PDFTOTEXT'] ?? 'pdftotext';
}

export async function pdfTextPositions(pdf: Uint8Array): Promise<PageText[]> {
  const dir = await mkdtemp(join(tmpdir(), 'docedit-exp-078-'));
  try {
    const input = join(dir, 'in.pdf');
    const output = join(dir, 'out.html');
    await writeFile(input, pdf);
    await run(pdftotextCli(), ['-bbox-layout', '-enc', 'UTF-8', input, output], {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return parsePages(await readFile(output, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
