/**
 * EXP-110 criterion 1: the importer's success rate on the corpus of real Word files, and its
 * warnings per file, are recorded; a rate below the agreed one fails the run.
 *
 * The agreed rate is owner decision 54 (docs/owner-decisions-2026-11-15.md): 100 percent of the
 * corpus, where "a failing file is fixed or removed with a written reason". A file removed from the
 * count is named in `REMOVED` below with its reason; the list is empty because no file is removed.
 *
 * The report is written to `test-results/exp-110-import-rate.json` (ignored by Git): per file the
 * outcome, the time of the import, the number of warnings and report lines, and per generator (the
 * corpus folder: docx4j, poi, python-docx) and overall the count and the rate. The summary is also
 * printed. This test is part of `pnpm test`, so a drop below the rate fails the run that CI makes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importDocx, ImportError } from '../src/index.ts';
import { OUT_DIR, corpusFiles, readFile } from './corpus.ts';

/** The agreed rate: all of the corpus (owner decision 54). */
const AGREED_RATE = 1;
/** Corpus files taken out of the count, each with the written reason. Empty: none is removed. */
const REMOVED: Readonly<Record<string, string>> = {};

interface FileResult {
  file: string;
  source: string;
  ok: boolean;
  /** The refusal, when the file did not import. */
  error: string | null;
  ms: number;
  warnings: number;
  reportLines: number;
}

async function attempt(name: string, source: string, bytes: Uint8Array): Promise<FileResult> {
  const start = performance.now();
  try {
    const r = await importDocx(bytes);
    return {
      file: name,
      source,
      ok: true,
      error: null,
      ms: performance.now() - start,
      warnings: r.warnings.length,
      reportLines: r.report.length,
    };
  } catch (e) {
    return {
      file: name,
      source,
      ok: false,
      error: e instanceof ImportError ? `ImportError: ${e.message}` : String(e),
      ms: performance.now() - start,
      warnings: 0,
      reportLines: 0,
    };
  }
}

describe('EXP-110 criterion 1: the importer succeeds on the corpus, and the result is recorded', () => {
  it('imports every file that is counted, records the rate and the warnings per file, and holds the agreed rate', async () => {
    const files = corpusFiles();
    expect(files.length).toBeGreaterThan(20);
    // A removal names a file that exists, and has a reason.
    for (const [name, reason] of Object.entries(REMOVED)) {
      expect(
        files.some((f) => f.name === name),
        `${name} is not in the corpus`,
      ).toBe(true);
      expect(reason.length, `${name} needs a written reason`).toBeGreaterThan(20);
    }
    const results: FileResult[] = [];
    for (const f of files) {
      if (f.name in REMOVED) continue;
      results.push(await attempt(f.name, f.source, readFile(f)));
    }
    const rate = (rs: FileResult[]): number => rs.filter((r) => r.ok).length / rs.length;
    const bySource: Record<string, { files: number; imported: number; rate: number }> = {};
    for (const source of [...new Set(results.map((r) => r.source))]) {
      const rs = results.filter((r) => r.source === source);
      bySource[source] = {
        files: rs.length,
        imported: rs.filter((r) => r.ok).length,
        rate: rate(rs),
      };
    }
    const overall = {
      files: results.length,
      imported: results.filter((r) => r.ok).length,
      rate: rate(results),
      removed: Object.keys(REMOVED),
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'exp-110-import-rate.json'),
      JSON.stringify({ agreedRate: AGREED_RATE, overall, bySource, files: results }, null, 2),
    );
    console.info(
      `[EXP-110 rate] ${overall.imported} of ${overall.files} imported (${(overall.rate * 100).toFixed(1)} percent); ` +
        Object.entries(bySource)
          .map(([s, v]) => `${s} ${v.imported}/${v.files}`)
          .join(', '),
    );
    const failed = results.filter((r) => !r.ok).map((r) => `${r.file}: ${r.error}`);
    // The failing files are named in the message, so a drop can be read without a rerun.
    expect(failed, 'files that did not import').toEqual([]);
    expect(overall.rate).toBeGreaterThanOrEqual(AGREED_RATE);
    // Warnings are recorded per file (a count, possibly zero).
    for (const r of results) expect(Number.isInteger(r.warnings)).toBe(true);
  }, 600_000);
});
