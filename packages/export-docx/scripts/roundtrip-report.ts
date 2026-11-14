/**
 * The lossless round-trip report (EXP-120): R0 and R1 of ADR 0017 on every corpus file, with the
 * corpus version and the pass rates that release notes state. A failure names the file, the part
 * and the first differing element. Exit code 1 when anything fails.
 *
 * Run from the repository root: node packages/export-docx/scripts/roundtrip-report.ts [out.json]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkR0,
  checkR1,
  everyParagraph,
  exportDocx,
  importDocx,
  scriptedEdits,
} from '../src/index.ts';
import { CORPUS_DIR, corpusFiles, readFile } from '../test/corpus.ts';

interface FileReport {
  file: string;
  r0: { pass: boolean; failures: string[] };
  r1: Record<string, { pass: boolean | null; failures: string[]; skipped?: string }>;
}

const sources = readFileSync(join(CORPUS_DIR, 'SOURCES.md'));
const files = corpusFiles();
const reports: FileReport[] = [];
let r0Pass = 0;
let r1Applicable = 0;
let r1Pass = 0;
for (const f of files) {
  const bytes = readFile(f);
  const report: FileReport = { file: f.name, r0: { pass: false, failures: [] }, r1: {} };
  try {
    const imported = await importDocx(bytes);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    const r0 = checkR0(bytes, out.bytes);
    report.r0.pass = r0.pass && out.regenerated.length === 0;
    report.r0.failures = [
      ...r0.differences,
      ...r0.diff.missing.map((p) => `${p}: missing`),
      ...r0.diff.added.map((p) => `${p}: added`),
      ...(out.regenerated.length
        ? [`${out.regenerated.length} nodes regenerated without an edit`]
        : []),
    ];
    if (report.r0.pass) r0Pass++;
    const edits = scriptedEdits(imported.envelope, imported.sourceMap, imported.assets);
    for (const e of edits) {
      if ('skipped' in e) {
        report.r1[e.name] = { pass: null, failures: [], skipped: e.skipped };
        continue;
      }
      r1Applicable++;
      const written = await exportDocx(e.envelope, bytes, imported.sourceMap, imported.assets);
      const r1 = checkR1(bytes, written.bytes, imported.sourceMap, e.edit);
      report.r1[e.name] = { pass: r1.pass, failures: r1.violations };
      if (r1.pass) r1Pass++;
    }
    const all = everyParagraph(imported.envelope, imported.sourceMap);
    const regen = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets, {
      regenerate: new Set(all.edited),
    });
    const r1 = checkR1(bytes, regen.bytes, imported.sourceMap, all);
    r1Applicable++;
    if (r1.pass) r1Pass++;
    report.r1['regenerate every paragraph'] = { pass: r1.pass, failures: r1.violations };
  } catch (e) {
    report.r0.failures.push(`import or export failed: ${(e as Error).message}`);
  }
  reports.push(report);
}

const summary = {
  corpus: {
    files: files.length,
    version: createHash('sha256').update(sources).digest('hex').slice(0, 16),
    note: 'corpus version: the first 16 hexadecimal digits of the SHA-256 of corpus/SOURCES.md',
  },
  r0: { pass: r0Pass, of: files.length },
  r1: { pass: r1Pass, of: r1Applicable },
  failures: reports.flatMap((r) => [
    ...r.r0.failures.map((m) => `${r.file} R0: ${m}`),
    ...Object.entries(r.r1).flatMap(([edit, x]) =>
      x.failures.map((m) => `${r.file} R1 ${edit}: ${m}`),
    ),
  ]),
  files: reports,
};
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(
  `corpus ${summary.corpus.version} (${files.length} files): R0 ${r0Pass} of ${files.length}, R1 ${r1Pass} of ${r1Applicable}`,
);
for (const m of summary.failures.slice(0, 50)) console.log(`  ${m}`);
process.exit(summary.failures.length ? 1 : 0);
