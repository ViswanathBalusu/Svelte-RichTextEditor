/**
 * The text of a PDF, for the checks of EXP-001 criteria 2 and 4 and EXP-061 criterion 5: poppler's
 * or xpdf's `pdftotext -raw` (S4 §5 uses it the same way), when it is installed; null otherwise, and
 * the tests that need it skip. The PDF is the test's own output, compiled from its own document.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let available: boolean | undefined;

export function pdftotextAvailable(): boolean {
  if (available === undefined) {
    const r = spawnSync('pdftotext', ['-v'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    available =
      r.error === undefined &&
      (r.status === 0 || r.status === 99 || /pdftotext/i.test(`${r.stdout}${r.stderr}`));
  }
  return available;
}

/** The text of `pdf`, page by page (pages end with a form feed), or null without pdftotext. */
export function pdfText(
  pdf: Uint8Array,
  opts: { first?: number; last?: number } = {},
): string | null {
  if (!pdftotextAvailable()) return null;
  const dir = mkdtempSync(join(tmpdir(), 'docedit-pdftext-'));
  try {
    const file = join(dir, 'in.pdf');
    writeFileSync(file, pdf);
    const range = [
      ...(opts.first ? ['-f', String(opts.first)] : []),
      ...(opts.last ? ['-l', String(opts.last)] : []),
    ];
    const r = spawnSync('pdftotext', ['-enc', 'UTF-8', '-raw', ...range, file, '-'], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return r.status === 0 ? r.stdout : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Text with every run of white space made one space, for comparing reading order. */
export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
