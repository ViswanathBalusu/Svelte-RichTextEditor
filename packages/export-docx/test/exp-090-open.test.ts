/**
 * EXP-090 criterion 1 (lane w2): a package written by the direct writer opens in Microsoft Word and
 * in LibreOffice without a repair prompt. The projections of writer-docs.ts and the corpus
 * projections (the importer's output written again) are written to test-results, then
 *
 * - Word opens each one read-only with alerts off and without the repair option
 *   (tools/word-open/open-in-word.ps1). A package with unreadable content then fails to open,
 *   where an ordinary open would show the repair prompt; a damaged copy of a written package is
 *   opened too, and the test requires that one to fail, so a pass means something.
 * - LibreOffice converts each one to PDF (scripts/libreoffice-open-check.ps1, with `-Calibrate`,
 *   which also converts two damaged copies; the test requires the one with malformed XML to fail).
 *   LibreOffice has no repair prompt for .docx; it loads
 *   the file or refuses it, and "loaded" is the measurable form.
 *
 * Needs Windows with Word and LibreOffice; each half is skipped where its program is missing.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { importDocx, entryData, readZip } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { corpusFiles, readFile } from './corpus.ts';
import { writerDocs } from './writer-docs.ts';

const run = promisify(execFile);
const WORK_DIR = fileURLToPath(new URL('../test-results/exp-090-open/', import.meta.url));
const WORD_SCRIPT = fileURLToPath(new URL('../tools/word-open/open-in-word.ps1', import.meta.url));
const LO_SCRIPT = fileURLToPath(new URL('../scripts/libreoffice-open-check.ps1', import.meta.url));
const SOFFICE = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const windows = process.platform === 'win32';
const hasLibreOffice = windows && existsSync(SOFFICE);

/** Whether Word is registered (the COM class the script starts). */
async function wordInstalled(): Promise<boolean> {
  if (!windows) return false;
  try {
    await run('reg', ['query', 'HKCR\\Word.Application']);
    return true;
  } catch {
    return false;
  }
}
const hasWord = await wordInstalled();

const FILES = `${WORK_DIR}files/`;
/** A package with a part Word cannot read: the damaged copy that must not open. */
const DAMAGED = `${WORK_DIR}damaged.docx`;

/** Writes the packages once, whichever half runs first. */
let written: Promise<string[]> | undefined;
function packages(): Promise<string[]> {
  written ??= (async () => {
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(FILES, { recursive: true });
    const files: string[] = [];
    const put = (name: string, bytes: Uint8Array): void => {
      const p = `${FILES}${name}.docx`;
      writeFileSync(p, bytes);
      files.push(p);
    };
    for (const d of await writerDocs()) {
      const out = await writeDocx(d.envelope, d.assets, {
        instant: '2026-11-26T09:30:00.000Z',
        timeZone: 'Europe/London',
        title: `Open check ${d.name}`,
      });
      put(`writer-${d.name}`, out.bytes);
    }
    let n = 0;
    for (const f of corpusFiles()) {
      const imported = await importDocx(readFile(f));
      put(`corpus-${n++}`, (await writeDocx(imported.envelope, imported.assets)).bytes);
    }
    // The damaged copy: the first package with an element Word does not know in the body.
    const first = readFileSync(files[0]!);
    const zip = readZip(new Uint8Array(first));
    const entry = zip.entries.find((e) => e.name === 'word/document.xml')!;
    const xml = new TextDecoder().decode(entryData(zip, entry));
    expect(xml).toContain('<w:body>');
    writeFileSync(DAMAGED, await damage(new Uint8Array(first), xml));
    return files;
  })();
  return written;
}

/** Rewrites `word/document.xml` of a package with a stray element and an unclosed run. */
async function damage(bytes: Uint8Array, xml: string): Promise<Uint8Array> {
  const { zipSync, unzipSync } = await import('fflate');
  const parts = unzipSync(bytes);
  const broken = xml.replace('<w:body>', '<w:body><w:bogus w:x="1"/><w:p><w:r><w:t>');
  parts['word/document.xml'] = new TextEncoder().encode(broken);
  return zipSync(parts);
}

interface WordRow {
  file: string;
  opened: boolean;
  paragraphs: number;
  error: string | null;
}

describe('EXP-090 criterion 1: the written package opens without a repair prompt', () => {
  it.skipIf(!hasWord)(
    'opens every package in Microsoft Word, and refuses a damaged one',
    async () => {
      const files = await packages();
      const list = `${WORK_DIR}word-list.txt`;
      const out = `${WORK_DIR}word-result.json`;
      writeFileSync(list, [...files, DAMAGED].join('\n'));
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          WORD_SCRIPT,
          '-List',
          list,
          '-Out',
          out,
        ],
        { timeout: 1_500_000 },
      );
      const result = JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/, '')) as {
        word: string;
        rows: WordRow[];
      };
      const rows = result.rows;
      const control = rows.find((r) => r.file === DAMAGED)!;
      // The control: Word refuses what it would otherwise offer to repair.
      expect(control.opened).toBe(false);
      const checked = rows.filter((r) => r.file !== DAMAGED);
      expect(checked.length).toBe(files.length);
      expect(checked.filter((r) => !r.opened).map((r) => `${r.file}: ${r.error}`)).toEqual([]);
      expect(checked.every((r) => r.paragraphs > 0)).toBe(true);
      expect(result.word).toMatch(/^\d+/);
    },
    1_600_000,
  );

  it.skipIf(!hasLibreOffice)(
    'loads every package in LibreOffice, and refuses damaged ones',
    async () => {
      const files = await packages();
      const out = `${WORK_DIR}lo-result.json`;
      await run(
        'pwsh',
        ['-NoProfile', '-File', LO_SCRIPT, '-Dir', FILES, '-Result', out, '-Calibrate'],
        { timeout: 1_500_000 },
      );
      const r = JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/, '')) as {
        total: number;
        loaded: number;
        failed: string[];
        calibration: Array<{ file: string; loaded: boolean }>;
      };
      expect(r.total).toBe(files.length);
      expect(r.failed).toEqual([]);
      const by = Object.fromEntries(r.calibration.map((c) => [c.file, c.loaded]));
      expect(by['malformed-xml.docx']).toBe(false);
      // LibreOffice 26.8 reads a file that is not a package as plain text and writes a PDF of it,
      // so that second damaged file of the script is not a control here; the control file loads.
      expect(by['corpus-0.docx']).toBe(true);
    },
    1_600_000,
  );
});
