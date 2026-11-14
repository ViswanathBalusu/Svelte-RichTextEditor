/**
 * EXP-106, criterion 4, at the importer: a tenant font with the family name of a built-in entry
 * is decided by the manifest's order (the first entry that names the family wins), and the result
 * lists the family once, with the tenant entry that replaced it. The tenant's fonts come from
 * BE-047; here the manifest stands for them (`ImportOptions.fonts.manifest`).
 */
import { describe, expect, it } from 'vitest';
import { importDocx } from '../src/index.ts';
import { BUILTIN_FONT_MANIFEST, type FontManifestEntry } from '../src/font-substitution.ts';
import { corpusFiles, readFile } from './corpus.ts';

/** The corpus files that name Calibri, found by the importer's own default result. */
async function calibriFiles() {
  const found = [];
  for (const file of corpusFiles()) {
    const imported = await importDocx(readFile(file), { fonts: { manifest: [] } });
    if (imported.fonts.some((f) => f.from === 'Calibri')) found.push(file);
  }
  return found;
}

describe(
  'EXP-106 criterion 4: a tenant font with the same family name',
  { timeout: 300_000 },
  () => {
    it('is decided by the manifest order and listed once, in an import of a corpus file', async () => {
      const files = await calibriFiles();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const bytes = readFile(file);
        const tenant: FontManifestEntry = {
          family: 'Calibri',
          replacement: 'Tenant Sans',
          source: 'tenant',
        };
        const first = await importDocx(bytes, {
          fonts: { manifest: [tenant, ...BUILTIN_FONT_MANIFEST] },
        });
        const lines = first.fonts.filter((f) => f.from === 'Calibri');
        expect(lines).toEqual([expect.objectContaining({ to: 'Tenant Sans', source: 'tenant' })]);

        // The same family, with the built-in entry first: the built-in one decides.
        const builtinFirst = await importDocx(bytes, {
          fonts: { manifest: [...BUILTIN_FONT_MANIFEST, tenant] },
        });
        expect(builtinFirst.fonts.filter((f) => f.from === 'Calibri')).toEqual([
          expect.objectContaining({ to: 'Carlito', source: 'builtin' }),
        ]);
      }
    });

    it('lists a tenant entry that keeps the same family name, so the choice shows', async () => {
      const [file] = await calibriFiles();
      const same: FontManifestEntry = {
        family: 'Calibri',
        replacement: 'Calibri',
        source: 'tenant',
      };
      const imported = await importDocx(readFile(file!), {
        fonts: { manifest: [same, ...BUILTIN_FONT_MANIFEST] },
      });
      expect(imported.fonts.filter((f) => f.from === 'Calibri')).toEqual([
        expect.objectContaining({ to: 'Calibri', source: 'tenant' }),
      ]);
    });
  },
);
