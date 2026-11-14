/**
 * Writes the files the Word check opens (SPK-028): for every corpus file, the original, its R0
 * export, its R1 export after each scripted edit and the export with every paragraph regenerated.
 * Run from the package directory: node scripts/export-for-word.ts
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { everyParagraph, exportDocx, importDocx, scriptedEdits } from '../src/index.ts';
import { OUT_DIR, corpusFiles, readFile } from '../test/corpus.ts';
import { patchCases } from '../test/patch-cases.ts';

const root = join(OUT_DIR, 'word-check');
let written = 0;
for (const f of corpusFiles()) {
  const base = f.name.replace(/\.docx$/, '').replace('/', '__');
  const put = (dir: string, suffix: string, bytes: Uint8Array): void => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, `${base}${suffix}.docx`), bytes);
    written++;
  };
  mkdirSync(join(root, 'original'), { recursive: true });
  copyFileSync(f.path, join(root, 'original', `${base}.docx`));
  const bytes = readFile(f);
  const imported = await importDocx(bytes);
  put(
    'r0',
    '',
    (await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets)).bytes,
  );
  for (const e of scriptedEdits(imported.envelope, imported.sourceMap, imported.assets)) {
    if ('skipped' in e) continue;
    put(
      'r1',
      `.${e.name.replace(/\s+/g, '-')}`,
      (await exportDocx(e.envelope, bytes, imported.sourceMap, imported.assets)).bytes,
    );
  }
  const all = everyParagraph(imported.envelope, imported.sourceMap);
  put(
    'regen',
    '',
    (
      await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets, {
        regenerate: new Set(all.edited),
      })
    ).bytes,
  );
}
// The edits beyond the scripted ones (EXP-118, EXP-119, owner decision 2).
for (const c of await patchCases()) {
  const out = await exportDocx(c.envelope, c.bytes, c.imported.sourceMap, c.imported.assets);
  mkdirSync(join(root, 'patch'), { recursive: true });
  writeFileSync(join(root, 'patch', `${c.name}.docx`), out.bytes);
  written++;
}
console.log(`wrote ${written} exported files and ${corpusFiles().length} originals under ${root}`);
