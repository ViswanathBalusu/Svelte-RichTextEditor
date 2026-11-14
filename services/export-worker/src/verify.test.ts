/**
 * Workers compile only converter bundles (09 §9.3 item 1; EXP-067 criteria 2 to 4): extra files, a
 * modified class, a loaded package, a raw TeX file, a wrong hash and a missing seal are refused
 * before the engine starts.
 */
import { bundleHashInput, canonicalJson, CLASS_VERSION } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import { buildBundle, classFiles } from './bundle-io.ts';
import { checkSeal, sealBundle, verifyBundle } from './verify.ts';

const pinned = { classFiles: classFiles(), classVersion: CLASS_VERSION };
const bundle = await buildBundle(demoDocument().envelope, { fonts: TEST_FONTS });

/** The bundle with `change` applied and its manifest made consistent again (a careful forger). */
async function forged(
  change: (files: Record<string, string>) => void,
): Promise<Record<string, string>> {
  const { createHash } = await import('node:crypto');
  const files = { ...bundle.files };
  change(files);
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const hashes: Record<string, string> = {};
  for (const n of Object.keys(files).sort()) if (n !== 'manifest.json') hashes[n] = sha(files[n]!);
  const manifest = JSON.parse(files['manifest.json']!) as Record<string, unknown>;
  manifest['files'] = hashes;
  manifest['bundleHash'] = sha(bundleHashInput(hashes, sha(canonicalJson(manifest['options']))));
  files['manifest.json'] = JSON.stringify(manifest);
  return files;
}

const reasons = (files: Record<string, string>, assets: Record<string, Uint8Array> = {}) =>
  verifyBundle(files, pinned, assets).map((d) => d.message);

describe('bundle checks before the engine starts (EXP-067)', () => {
  it('accepts what the converter wrote', () => {
    expect(verifyBundle(bundle.files, pinned, bundle.assets ?? {})).toEqual([]);
  });

  it('refuses an extra file, such as a raw .tex file or a package', async () => {
    expect(reasons({ ...bundle.files, 'evil.tex': '\\directlua{os.execute("x")}' })).toEqual([
      expect.stringContaining('evil.tex'),
    ]);
    expect(reasons({ ...bundle.files, 'foo.sty': '\\ProvidesPackage{foo}' })[0]).toContain(
      'foo.sty',
    );
    // Even with a manifest that lists it.
    const listed = await forged((f) => (f['evil.tex'] = 'x'));
    expect(reasons(listed)[0]).toContain('evil.tex');
  });

  it('refuses a modified class, even with a consistent manifest', async () => {
    const files = await forged((f) => (f['docedit.cls'] = f['docedit.cls']! + '\n\\directlua{}'));
    expect(reasons(files)).toContainEqual(
      expect.stringContaining('docedit.cls is not the pinned class file'),
    );
    const lua = await forged((f) => (f['docedit.lua'] = 'os.execute("id")'));
    expect(reasons(lua)).toContainEqual(
      expect.stringContaining('docedit.lua is not the pinned class file'),
    );
  });

  it('refuses a bundle that loads a package, inputs a file or runs Lua', async () => {
    const cases: Array<[string, (s: string) => string]> = [
      [
        'loads a package',
        (s) => s.replace('\\begin{document}', '\\usepackage{shellesc}\n\\begin{document}'),
      ],
      [
        'loads a package',
        (s) => s.replace('\\begin{document}', '\\RequirePackage{x}\n\\begin{document}'),
      ],
      [
        'runs Lua',
        (s) => s.replace('\\begin{document}', '\\begin{document}\\directlua{os.exit(1)}'),
      ],
      [
        'inputs a file',
        (s) => s.replace('\\begin{document}', '\\begin{document}\\input{/etc/passwd}'),
      ],
      [
        'changes how TeX reads',
        (s) => s.replace('\\begin{document}', '\\catcode`\\^^M=13\n\\begin{document}'),
      ],
      [
        'opens files or writes out',
        (s) => s.replace('\\begin{document}', '\\immediate\\write18{id}\\begin{document}'),
      ],
      ['house class exactly once', (s) => s.replace('{docedit}', '{article}')],
    ];
    for (const [why, edit] of cases) {
      const files = await forged((f) => (f['main.tex'] = edit(f['main.tex']!)));
      expect(reasons(files).join(' '), why).toContain(why);
    }
  });

  it('refuses a file whose hash is not the one the manifest lists', () => {
    const files = {
      ...bundle.files,
      'main.tex': bundle.files['main.tex']!.replace('Prices', 'Pricez'),
    };
    expect(reasons(files)).toContainEqual(expect.stringContaining('The hash of main.tex'));
    expect(reasons(files)).toContainEqual(expect.stringContaining('bundle hash'));
  });

  it('refuses an asset that is not the file its name names', () => {
    const name = `assets/${'a'.repeat(64)}.png`;
    expect(reasons(bundle.files, { [name]: new Uint8Array([1, 2, 3]) })[0]).toContain(
      'is not the file',
    );
    expect(reasons(bundle.files, { 'assets/x.sh': new Uint8Array() })[0]).toContain('assets/x.sh');
  });

  it('seals a bundle for one job only (provenance, criterion 4)', () => {
    const key = new Uint8Array(32).fill(7);
    const hash = bundle.manifest.bundleHash;
    const seal = sealBundle(key, 'job-1', hash);
    expect(checkSeal(key, 'job-1', hash, seal)).toBe(true);
    expect(checkSeal(key, 'job-2', hash, seal)).toBe(false);
    expect(checkSeal(key, 'job-1', '0'.repeat(64), seal)).toBe(false);
    expect(checkSeal(new Uint8Array(32), 'job-1', hash, seal)).toBe(false);
    expect(checkSeal(key, 'job-1', hash, 'not a seal')).toBe(false);
  });
});
