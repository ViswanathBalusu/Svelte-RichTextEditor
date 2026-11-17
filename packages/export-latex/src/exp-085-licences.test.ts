/**
 * EXP-085 criterion 4 (Node.js only): the `tex` archive includes the licence of the house class and
 * the licence manifest of the packages the class relies on. The archive is read back member by
 * member. `LICENCE.txt` is compared with the project's `LICENSE` file, and `licences.json` is
 * checked against the class source: every package or class that `docedit.cls` loads by name has a
 * row with a licence. Nothing here compiles; the rows themselves were read from the worker image's
 * package database (see `licences.ts`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLASS_FILES, doc, para, run } from '../test/docs.ts';
import { archiveReadme, CLASS_LICENCE, texArchive } from './archive.ts';
import { CLASS_VERSION } from './convert.ts';
import { PACKAGE_LICENCES } from './licences.ts';

const dec = new TextDecoder();

function member(archive: Uint8Array, wanted: string): string | undefined {
  let at = 0;
  while (at + 512 <= archive.length) {
    const head = archive.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const nameEnd = head.indexOf(0);
    const name = dec.decode(head.subarray(0, nameEnd < 0 || nameEnd > 100 ? 100 : nameEnd));
    const size = parseInt(dec.decode(head.subarray(124, 135)).trim(), 8);
    if (name === wanted) return dec.decode(archive.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r/g, '');

async function archive() {
  const bundle = await run(doc([para('Body text.')]), { classFiles: CLASS_FILES });
  return { bundle, tar: texArchive(bundle) };
}

describe('EXP-085 criterion 4: the licences are in the archive', () => {
  it('includes the licence of the house class, word for word', async () => {
    const { tar } = await archive();
    const text = member(tar, 'LICENCE.txt');
    expect(text).toBe(read('../../../LICENSE'));
    expect(text).toContain('Apache License');
    expect(text).toContain('Version 2.0, January 2004');
    expect(CLASS_LICENCE).toBe('Apache-2.0');
  });

  it('includes a licence manifest that names the class and gives each package a licence', async () => {
    const { tar } = await archive();
    const manifest = JSON.parse(member(tar, 'licences.json') ?? 'null') as {
      houseClass: { name: string; version: string; licence: string; text: string };
      packages: { name: string; loads: string[]; licence: string; revision: number }[];
    };
    expect(manifest.houseClass).toMatchObject({
      name: 'docedit',
      version: CLASS_VERSION,
      licence: 'Apache-2.0',
      text: 'LICENCE.txt',
    });
    expect(manifest.packages).toEqual(PACKAGE_LICENCES);
    expect(manifest.packages.length).toBeGreaterThan(0);
    for (const p of manifest.packages) {
      expect(p.licence, p.name).toMatch(/^(lppl1\.3c?|gpl2)$/);
      expect(p.revision, p.name).toBeGreaterThan(0);
    }
    const names = manifest.packages.map((p) => p.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('has a row for every package and class that docedit.cls loads by name', async () => {
    const cls = read('../class/docedit.cls');
    const loaded = new Set<string>();
    for (const line of cls.split('\n')) {
      const code = line.replace(/(^|[^\\])%.*$/, '$1');
      for (const m of code.matchAll(/\\(?:RequirePackage|LoadClass)(?:\[[^\]]*\])?\{([^}#\\]+)\}/g))
        for (const name of m[1]!.split(',')) loaded.add(name.trim());
    }
    // The class loads at least the packages 09 §3.1 names; the scan must see them.
    for (const name of ['article', 'fontspec', 'hyperref', 'longtable', 'babel'])
      expect(loaded).toContain(name);
    const covered = new Set(PACKAGE_LICENCES.flatMap((p) => p.loads));
    expect([...loaded].filter((name) => !covered.has(name))).toEqual([]);
    // The packages that tagging and font loading bring in are listed too.
    for (const name of ['tagpdf', 'latex-lab', 'luaotfload'])
      expect(PACKAGE_LICENCES.map((p) => p.name)).toContain(name);
  });

  it('says in the README where the licences are', async () => {
    const { bundle } = await archive();
    const readme = archiveReadme(bundle);
    expect(readme).toContain('LICENCE.txt');
    expect(readme).toContain('licences.json');
    expect(readme).toContain(`licensed under ${CLASS_LICENCE}`);
  });

  it('adds no auxiliary file or log with them', async () => {
    const { tar } = await archive();
    expect(member(tar, 'main.log')).toBeUndefined();
    expect(member(tar, 'main.aux')).toBeUndefined();
  });
});
