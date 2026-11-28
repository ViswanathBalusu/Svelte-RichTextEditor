/**
 * SEC-053 criterion 1, the part that needs no image: the roots file of the curation step covers
 * the packages of the class's fixed list, and the Containerfile curates, pins its base by digest
 * and keeps the LuaTeX gate. The built image is checked by `sec-053-curated-image.podman.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLASS_PACKAGES } from './sec-053-curated-roots.ts';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const roots = read('../image/curated-roots.txt')
  .split('\n')
  .map((l) => l.replace(/#.*$/, '').trim())
  .filter(Boolean);
const containerfile = read('../Containerfile');

describe('SEC-053: the curated image is defined by a list', () => {
  it('has a root for every package of the class and of the compile', () => {
    for (const p of CLASS_PACKAGES.filter((n) => n !== 'biber'))
      expect(roots, `${p} is a root`).toContain(p);
    expect(roots).toContain('biber');
  });

  it('has no duplicate root', () => {
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('is applied by the Containerfile after the fonts are copied out and before the font caches are built', () => {
    const fonts = containerfile.indexOf('fonts.lua /opt/docedit/fonts');
    const curate = containerfile.indexOf('COPY curate.lua');
    const warm = containerfile.indexOf('luaotfload-tool --update');
    expect(fonts).toBeGreaterThan(-1);
    expect(curate).toBeGreaterThan(fonts);
    expect(warm).toBeGreaterThan(curate);
  });

  it('keeps the base pinned by digest and the LuaTeX 1.17 gate', () => {
    expect(containerfile).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
    expect(containerfile).toMatch(/luatex --version[^\n]*Version 1\\\.\(1\[7-9\]/);
  });
});
