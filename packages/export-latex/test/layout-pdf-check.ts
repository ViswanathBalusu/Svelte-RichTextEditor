/**
 * Checks of `layout.json` against the pages of the PDF (EXP-056; Node.js only). Each check returns
 * its mismatches as sentences that name the document and the page, so that a failing run says
 * where it failed.
 *
 * The PDF side is read with poppler: `pdfinfo` for the size of each page and `pdftotext -raw` for
 * its text.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PagePoint {
  widthPt: number;
  heightPt: number;
}

/** The pages as `layout.json` gives them (the fields the checks read). */
export interface LayoutPage {
  n: number;
  setup: string;
  starts: { blockId: string; offset: number } | null;
  opensWith: string;
}

export function popplerAvailable(): boolean {
  return (
    !spawnSync('pdfinfo', ['-v'], { encoding: 'utf8' }).error &&
    !spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).error
  );
}

function withPdf<T>(pdf: Uint8Array, run: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-layout-pdf-'));
  try {
    const file = join(dir, 'main.pdf');
    writeFileSync(file, pdf);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The size of each page in points, from `pdfinfo -f 1 -l <pages>`. */
export function pageSizes(pdf: Uint8Array, pages: number): PagePoint[] {
  return withPdf(pdf, (file) => {
    const r = spawnSync('pdfinfo', ['-f', '1', '-l', String(pages), file], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.error || r.status !== 0) throw new Error('pdfinfo is not installed or failed');
    const sizes: PagePoint[] = [];
    for (const m of r.stdout.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm))
      sizes[Number(m[1]) - 1] = { widthPt: Number(m[2]), heightPt: Number(m[3]) };
    return sizes;
  });
}

/** The text of each page, from `pdftotext -raw`, one call a page. */
export function pageTexts(pdf: Uint8Array, pages: number): string[] {
  return withPdf(pdf, (file) => {
    const out: string[] = [];
    for (let n = 1; n <= pages; n++) {
      const r = spawnSync(
        'pdftotext',
        ['-enc', 'UTF-8', '-raw', '-f', String(n), '-l', String(n), file, '-'],
        { encoding: 'utf8', timeout: 60_000 },
      );
      if (r.error || r.status !== 0) throw new Error('pdftotext is not installed or failed');
      out.push(r.stdout);
    }
    return out;
  });
}

/**
 * What the page setup of each page is, by its `setup` name: the size that the document gives it,
 * and the marker that the document prints on the pages that it governs.
 */
export interface SetupExpectation {
  /** The setup's name, as `layout.json` reports it. */
  setup: string;
  widthPt: number;
  heightPt: number;
  /** A word that the document prints on every page of this setup and on no other. */
  marker: string;
}

/**
 * Compares the `setup` of every page with the setup in force on it. The setup in force is found
 * from the PDF alone: the marker word that the page prints names the section, and the page's own
 * size must be the size of that section's setup. A tolerance of 0.5 pt covers the rounding of the
 * size in the PDF.
 */
export function setupMismatches(
  documentName: string,
  pages: readonly LayoutPage[],
  pdf: Uint8Array,
  expectations: readonly SetupExpectation[],
): string[] {
  const sizes = pageSizes(pdf, pages.length);
  const texts = pageTexts(pdf, pages.length);
  const out: string[] = [];
  if (sizes.length !== pages.length)
    out.push(`${documentName}: layout.json has ${pages.length} pages and the PDF ${sizes.length}`);
  for (const p of pages) {
    const text = texts[p.n - 1] ?? '';
    const inForce = expectations.find((e) => text.includes(e.marker));
    if (!inForce) {
      out.push(`${documentName}, page ${p.n}: the page prints no marker of any setup`);
      continue;
    }
    if (p.setup !== inForce.setup)
      out.push(
        `${documentName}, page ${p.n}: layout.json says setup "${p.setup}", the setup in force there is "${inForce.setup}"`,
      );
    const size = sizes[p.n - 1];
    if (
      !size ||
      Math.abs(size.widthPt - inForce.widthPt) > 0.5 ||
      Math.abs(size.heightPt - inForce.heightPt) > 0.5
    )
      out.push(
        `${documentName}, page ${p.n}: the PDF page is ${size?.widthPt} x ${size?.heightPt} pt and setup "${inForce.setup}" is ${inForce.widthPt} x ${inForce.heightPt} pt`,
      );
  }
  return out;
}
