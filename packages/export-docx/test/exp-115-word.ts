/**
 * Helpers for EXP-115 (Node.js, Windows with Word): the shared layout-semantics fixtures of
 * `packages/model` run against the DOCX writer. A case becomes a CDM document as the `format` text
 * of its fixture file says, the direct writer (`writeDocx`) writes it, Word lays it out and exports
 * it as PDF (`tools/word-layout/word-to-pdf.ps1`, Word COM, fields updated first), and `pdftotext`
 * reads the PDF. Labels are looked for in the extracted text and spacing is measured from the word
 * boxes of the PDF, as the LaTeX runners do (`packages/export-latex/src/exp-115-*.test.ts`).
 *
 * Every test title that uses these helpers starts with `[<fixture> x DOCX]` so that a failure in
 * CI names the fixture and the writer (EXP-115 criterion 3).
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { JsonEnvelope } from '@docedit/model';
import { AssetStore } from '../src/index.ts';
import { writeDocx, type WriteOptions } from '../src/writer.ts';

export type J = Record<string, unknown>;

export const SEMANTICS_DIR = fileURLToPath(
  new URL('../../model/fixtures/semantics/', import.meta.url),
);
const SCRIPT = fileURLToPath(new URL('../tools/word-layout/word-to-pdf.ps1', import.meta.url));
const run = promisify(execFile);

export function loadSemantics<T>(name: string): T {
  return JSON.parse(readFileSync(join(SEMANTICS_DIR, `${name}.json`), 'utf8')) as T;
}

export interface DefsFile {
  settings?: J;
  styles?: J[];
  numberings?: J[];
}
export interface DocCase {
  id: string;
  description: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  stories?: J[];
  body?: J[];
}

function mergeById(base: readonly J[], extra: readonly J[]): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The document of a case, assembled as the `format` of the fixture file says. */
export function documentOf(file: DefsFile, c: DocCase, body?: J[]): JsonEnvelope {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { ...file.settings, ...c.settings } },
            ...mergeById(file.styles ?? [], c.styles ?? []),
            ...mergeById(file.numberings ?? [], c.numberings ?? []),
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        ...(c.stories ?? []),
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body ?? c.body ?? [] },
      ],
    },
  } as unknown as JsonEnvelope;
}

export function* nodesOf(n: unknown): Generator<J> {
  if (!n || typeof n !== 'object') return;
  const node = n as J;
  if (typeof node['type'] === 'string') yield node;
  const content = node['content'];
  if (Array.isArray(content)) for (const c of content) yield* nodesOf(c);
}

export function findById(trees: readonly unknown[], id: string): J | undefined {
  for (const t of trees)
    for (const n of nodesOf(t)) if ((n['attrs'] as J | undefined)?.['id'] === id) return n;
  return undefined;
}

/** The text a paragraph prints: its text nodes, with `fill` giving the text of each field. */
export function printedText(n: J, fill: (field: J) => string): string {
  if (n['type'] === 'text') return String(n['text'] ?? '');
  if (n['type'] === 'footnote') return '';
  if (n['type'] === 'field') return fill(n);
  const content = n['content'];
  return Array.isArray(content) ? content.map((c) => printedText(c as J, fill)).join('') : '';
}

export const dense = (s: string): string => s.replace(/[\s\u00a0\u2007\u202f]+/g, '');

/** Options of every written document: the job's time, as the LaTeX runners give it. */
export const WRITE_OPTIONS: WriteOptions = {
  instant: '2026-11-06T10:00:00.000Z',
  timeZone: 'Europe/London',
  suggestions: 'accept',
};

/** Whether Word, PowerShell and `pdftotext` are here. */
export function wordAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  const word = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "if (Test-Path 'Registry::HKEY_CLASSES_ROOT\\Word.Application') { exit 0 } else { exit 1 }",
    ],
    { windowsHide: true },
  );
  if (word.status !== 0) return false;
  const pdf = spawnSync(process.env['DOCEDIT_PDFTOTEXT'] ?? 'pdftotext', ['-v'], {
    windowsHide: true,
  });
  return !pdf.error;
}

const dirs = new Map<string, string>();
/** The folder of the last run of dirName: a new one each run, as Word may still hold the files of the last. */
const dirOf = (dirName: string): string => dirs.get(dirName)!;

/**
 * Writes each document to `<dir>/<name>.docx`, lets Word lay them all out in one instance, and
 * returns the names of the PDFs it made. The folder is new under `test-results/` for each run.
 */
export async function layOutInWord(
  dirName: string,
  docs: ReadonlyMap<string, { env: JsonEnvelope; options?: WriteOptions; assets?: AssetStore }>,
): Promise<Set<string>> {
  const dir = fileURLToPath(
    new URL(`../test-results/${dirName}-${process.pid}-${Date.now()}/`, import.meta.url),
  );
  dirs.set(dirName, dir);
  mkdirSync(dir, { recursive: true });
  // Folders of earlier runs, when Word has let go of them (not an error when it has not).
  const parent = fileURLToPath(new URL('../test-results/', import.meta.url));
  for (const old of readdirSync(parent))
    if (old.startsWith(`${dirName}-`) && join(parent, old) + sep !== dir)
      try {
        rmSync(join(parent, old), { recursive: true, force: true });
      } catch {
        // still open in Word
      }
  for (const [name, d] of docs) {
    const out = await writeDocx(d.env, d.assets ?? new AssetStore(), {
      ...WRITE_OPTIONS,
      ...d.options,
    });
    writeFileSync(join(dir, `${name}.docx`), out.bytes);
  }
  await run(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Dir', dir],
    { timeout: 900_000, windowsHide: true },
  );
  return new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => f.slice(0, -4)),
  );
}

function pdftotext(pdfPath: string, args: string[]): string {
  const r = spawnSync(process.env['DOCEDIT_PDFTOTEXT'] ?? 'pdftotext', [...args, pdfPath, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext failed');
  return r.stdout;
}

/** The raw text of a laid-out PDF (`<dir>/<name>.pdf`). */
export function pdfTextOf(dirName: string, name: string): string {
  return pdftotext(join(dirOf(dirName), `${name}.pdf`), ['-raw', '-enc', 'UTF-8', '-nopgbrk']);
}

export interface Word {
  readonly text: string;
  readonly page: number;
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

/** The words of every page, in reading order, from `pdftotext -bbox` (points from the top left). */
export function wordsOf(dirName: string, name: string): Word[] {
  const xml = pdftotext(join(dirOf(dirName), `${name}.pdf`), ['-bbox']);
  const out: Word[] = [];
  let page = 0;
  for (const line of xml.split('\n')) {
    if (line.includes('<page ')) page++;
    const m =
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/.exec(
        line,
      );
    if (m)
      out.push({
        page,
        xMin: Number(m[1]),
        yMin: Number(m[2]),
        xMax: Number(m[3]),
        yMax: Number(m[4]),
        text: m[5]!,
      });
  }
  return out;
}
