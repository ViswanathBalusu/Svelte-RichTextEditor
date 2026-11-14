/**
 * Writes the files the Word check opens for the direct DOCX writer (EXP-090 to EXP-096): every
 * test document of test/writer-docs.ts (suggestions in each of their three modes, regions with
 * and without protection), and every corpus file written as a projection (owner decision 1).
 *
 * Run from the repository root:
 *   node packages/export-docx/scripts/writer-word-check.ts <directory>
 *   powershell.exe -NoProfile -ExecutionPolicy Bypass -File packages/export-docx/scripts/word-open-check.ps1 -Dir <directory> -Result <file.json>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importDocx } from '../src/index.ts';
import { type WriteOptions, writeDocx } from '../src/writer.ts';
import { corpusFiles, readFile } from '../test/corpus.ts';
import { writerDocs } from '../test/writer-docs.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: writer-word-check.ts <directory>');
mkdirSync(join(dir, 'features'), { recursive: true });
mkdirSync(join(dir, 'projections'), { recursive: true });
const base: WriteOptions = {
  instant: '2026-11-06T09:30:00.000Z',
  timeZone: 'Europe/London',
  title: 'The title',
};
let written = 0;
for (const d of await writerDocs()) {
  const variants: Array<[string, WriteOptions]> = [['', base]];
  if (d.name === 'suggestions')
    variants.push(
      ['.accept', { ...base, suggestions: 'accept' }],
      ['.reject', { ...base, suggestions: 'reject' }],
    );
  if (d.name === 'regions-forms')
    variants.push([
      '.protected',
      {
        ...base,
        regionEditableByEveryone: (id) => id !== 'lockedRegion0001',
        regionEditors: (id) => (id === 'lockedRegion0001' ? ['editor@example.com'] : []),
        approvedRegions: new Set(['lockedRegion0001']),
        bodyEditableByEveryone: true,
        grants: { lockedRegion0001: [{ role: 'editor' }] },
      },
    ]);
  for (const [suffix, opts] of variants) {
    const out = await writeDocx(d.envelope, d.assets, opts);
    writeFileSync(join(dir, 'features', `${d.name}${suffix}.docx`), out.bytes);
    written++;
  }
}
for (const f of corpusFiles()) {
  const imported = await importDocx(readFile(f));
  const out = await writeDocx(imported.envelope, imported.assets, base);
  writeFileSync(
    join(dir, 'projections', `${f.name.replace(/\.docx$/, '').replace('/', '__')}.docx`),
    out.bytes,
  );
  written++;
}
console.log(`wrote ${written} files under ${dir}`);
