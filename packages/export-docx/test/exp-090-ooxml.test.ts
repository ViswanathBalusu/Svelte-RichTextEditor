/**
 * EXP-090 criterion 7: every package the DOCX writer produces validates against the Open XML
 * schemas (Office 2019 schema set, through the Open XML SDK's validator in tools/ooxml-validate).
 * The projections of writer-docs.ts and the corpus projections are written to test-results and
 * validated in one run of the validator. Needs the .NET 10 SDK and the NuGet package
 * DocumentFormat.OpenXml 3.5.1 (restored on first run).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importDocx } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { corpusFiles, readFile } from './corpus.ts';
import { writerDocs } from './writer-docs.ts';

const TOOL_DIR = fileURLToPath(new URL('../tools/ooxml-validate/', import.meta.url));
const WORK_DIR = fileURLToPath(new URL('../test-results/exp-090-ooxml/', import.meta.url));

interface ValidatorRow {
  file: string;
  opened: boolean;
  exception?: string;
  errors: {
    part: string | null;
    path: string | null;
    id: string;
    errorType: string;
    description: string;
  }[];
}

/** Writes one file of the given bytes under WORK_DIR, and returns its path. */
function put(name: string, bytes: Uint8Array): string {
  const p = `${WORK_DIR}${name}.docx`;
  writeFileSync(p, bytes);
  return p;
}

/** Runs the validator over the files and returns one row per file. */
function validate(files: string[]): ValidatorRow[] {
  const out = `${WORK_DIR}result.json`;
  execFileSync(
    'dotnet',
    [
      'run',
      '--project',
      `${TOOL_DIR}OoxmlValidate.csproj`,
      '-v',
      'q',
      '--',
      '--out',
      out,
      ...files,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 540_000 },
  );
  return JSON.parse(readFileSync(out, 'utf8')) as ValidatorRow[];
}

describe('EXP-090 criterion 7: the writer output validates against the OOXML schemas', () => {
  it('validates every writer projection with no schema error', async () => {
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
    const docs = await writerDocs();
    const files: string[] = [];
    for (const d of docs) {
      const out = await writeDocx(d.envelope, d.assets, {
        instant: '2026-11-06T09:30:00.000Z',
        timeZone: 'Europe/London',
        title: `Validation ${d.name}`,
      });
      files.push(put(`writer-${d.name}`, out.bytes));
    }
    const rows = validate(files);
    const problems = rows.flatMap((r) => {
      if (!r.opened) return [`${r.file}: not opened (${r.exception ?? ''})`];
      return r.errors.map((e) => `${r.file}: ${e.part ?? '?'} ${e.path ?? '?'} ${e.description}`);
    });
    expect(problems).toEqual([]);
    expect(rows.length).toBe(files.length);
  }, 600_000);

  it('validates the corpus projections (the importer output written by the writer)', async () => {
    mkdirSync(WORK_DIR, { recursive: true });
    const files: string[] = [];
    for (const f of corpusFiles()) {
      const imported = await importDocx(readFile(f));
      const out = await writeDocx(imported.envelope, imported.assets);
      files.push(put(`corpus-${files.length}`, out.bytes));
    }
    expect(files.length).toBeGreaterThan(0);
    const rows = validate(files);
    const problems = rows.flatMap((r) => {
      if (!r.opened) return [`${r.file}: not opened (${r.exception ?? ''})`];
      return r.errors.map((e) => `${r.file}: ${e.part ?? '?'} ${e.path ?? '?'} ${e.description}`);
    });
    expect(problems).toEqual([]);
  }, 600_000);

  it('the validator refuses a package it cannot read (so a pass means something)', () => {
    mkdirSync(WORK_DIR, { recursive: true });
    const bad = put('not-a-package', new TextEncoder().encode('not a zip'));
    const rows = validate([bad]);
    expect(rows[0]?.opened).toBe(false);
  }, 600_000);
});
