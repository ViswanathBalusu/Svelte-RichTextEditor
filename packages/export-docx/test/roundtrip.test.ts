/**
 * SPK-028, R0 of ADR 0017 on every corpus file: import with the preservation layer, export with no
 * edit, and every part is byte-identical. The writer patches even unchanged parts here (it copies
 * a part raw only when the patched bytes equal the original), so this also proves the patcher.
 * Every imported document passes validate() with `preserve` in `requires`.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '@docedit/model/validate';
import { checkR0, exportDocx, importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const files = corpusFiles();

describe('the S11 corpus', () => {
  it('has the files SOURCES.md lists', () => {
    expect(files.length).toBeGreaterThanOrEqual(78);
  });
});

describe.each(files)('$name', (file) => {
  it('passes R0: same parts, every part byte-identical', async () => {
    const bytes = readFile(file);
    const imported = await importDocx(bytes);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    const r0 = checkR0(bytes, out.bytes);
    expect(r0.diff.changed, 'changed parts').toEqual([]);
    expect(r0.diff.missing, 'missing parts').toEqual([]);
    expect(r0.diff.added, 'added parts').toEqual([]);
    expect(out.regenerated, 'nodes regenerated without an edit').toEqual([]);
    expect(Object.values(out.parts).every((m) => m === 'copied')).toBe(true);
  });

  it('imports a document that passes validate() with preserve in requires', async () => {
    const imported = await importDocx(readFile(file));
    const result = validate(imported.envelope, { attachedAssets: imported.assets.ids() });
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
    expect(imported.envelope.requires).toContain('preserve');
  });
});
