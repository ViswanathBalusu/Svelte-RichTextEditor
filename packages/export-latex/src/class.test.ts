/**
 * EXP-015 (Node.js only, source audit): the packages the house class loads are the fixed list of
 * 09 §9.3 item 5, none of the packages that do not work with tagging is among them, and the class
 * version in `docedit.cls` is the version the converter writes to `manifest.json`. These are checks
 * of the class source; that every listed package works with tagging in TeX Live 2026 needs a
 * LuaLaTeX compile, which is not run here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLASS_VERSION } from './convert.ts';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');

/** The packages the class loads itself, with or without options (comments are skipped), each once: babel has two load lines, one per branch of DEbabel. */
function loadedPackages(source: string): string[] {
  const code = source
    .split('\n')
    // The class redefines \usepackage and \RequirePackage to refuse loads from a bundle (EXP-015).
    .filter((l) => !/\\def\\(?:usepackage|RequirePackage)\b/.test(l))
    .map((l) => l.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');
  const names: string[] = [];
  for (const m of code.matchAll(/\\(?:RequirePackage|usepackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g))
    for (const name of m[1]!.split(',')) names.push(name.trim());
  return [...new Set(names)].sort();
}

/** The fixed list of 09 §9.3 item 5 as the class has it on 2026-11-13. A change to it is a change to this list. */
const FIXED_LIST = [
  'amsmath',
  'array',
  'babel',
  'colortbl',
  'fontspec',
  'geometry',
  'graphicx',
  'hyperref',
  'longtable',
  'lua-ul',
  'luacolor',
  'multicol',
  'unicode-math',
  'xcolor',
].sort();

/** Packages 09 §3.1 says the class must not load, because they do not work with tagging. */
const FORBIDDEN = ['titlesec', 'multirow', 'enumitem', 'tabto', 'caption', 'float'];

describe('EXP-015 house class source audit', () => {
  it('loads none of the packages that do not work with tagging (criterion 1, forbidden part)', () => {
    const loaded = loadedPackages(CLASS);
    for (const name of FORBIDDEN) expect(loaded).not.toContain(name);
  });

  it('loads exactly the fixed list of packages, and nothing else (criterion 3, class side)', () => {
    expect(loadedPackages(CLASS)).toEqual(FIXED_LIST);
  });

  it('declares the version the converter writes to manifest.json (criterion 4, manifest part)', () => {
    const provides = /\\ProvidesClass\{docedit\}\[\S+ v(\d+\.\d+\.\d+)/.exec(CLASS);
    expect(provides?.[1]).toBe(CLASS_VERSION);
  });
});
