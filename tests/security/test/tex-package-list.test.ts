/**
 * SEC-053 criterion 2 (10 §3.8; 09 §9.3 item 5): the house class loads a fixed list of packages,
 * and a package outside the list fails the build.
 *
 * The check is a source audit that runs under `pnpm test`, so a failing audit fails the build. The
 * class is read from `packages/export-latex/class/docedit.cls`, and the gate below reads every
 * package and class the class loads, the same way the class audit of EXP-015 does
 * (`packages/export-latex/src/class.test.ts`). Two things are proved here and not there: the gate
 * refuses every loader command, not only `\RequirePackage` and `\usepackage`, and it refuses a
 * package added to the class (a mutated copy of the source), so the check can fail.
 *
 * Not proved here: that a LuaLaTeX run of the class loads only these packages. That needs the
 * export worker image (SEC-053 criterion 1 and EXP-073), which is not run in this tree.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLASS_PATH = fileURLToPath(
  new URL('../../../packages/export-latex/class/docedit.cls', import.meta.url),
);
const CLASS = readFileSync(CLASS_PATH, 'utf8');

/** The fixed list of 09 §9.3 item 5, as the class has it on 2026-11-13. Changing it is a class change. */
const FIXED_LIST: readonly string[] = [
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
];

/** The base class the house class is built on (`\LoadClass`). It is not a package and is listed on its own. */
const BASE_CLASSES: readonly string[] = ['article'];

/** Loader commands of a TeX class: each one loads a package or a class. */
const LOADER =
  /\\(RequirePackage|RequirePackageWithOptions|usepackage|LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

export interface Load {
  kind: 'package' | 'class';
  name: string;
}

/**
 * Every package or class the source loads, in order, with comments removed. The class redefines
 * `\usepackage` and `\RequirePackage` to refuse loads from a bundle, so those definitions are not
 * loads and are skipped.
 */
export function loadsOf(source: string): Load[] {
  const code = source
    .split('\n')
    .filter(
      (l) =>
        !/\\def\\(?:usepackage|RequirePackage|RequirePackageWithOptions|LoadClass|LoadClassWithOptions)\b/.test(
          l,
        ),
    )
    .map((l) => l.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');
  const out: Load[] = [];
  for (const m of code.matchAll(LOADER)) {
    const kind = m[1]!.startsWith('LoadClass') ? 'class' : 'package';
    for (const n of m[2]!.split(',')) out.push({ kind, name: n.trim() });
  }
  return out;
}

/** The loads that are not on the fixed list (packages) or the base class list (classes). */
export function loadsOutside(source: string): string[] {
  return loadsOf(source)
    .filter((l) =>
      l.kind === 'package' ? !FIXED_LIST.includes(l.name) : !BASE_CLASSES.includes(l.name),
    )
    .map((l) => l.name);
}

describe('SEC-053 criterion 2: the class loads a fixed list and nothing else', () => {
  it('the house class loads only packages on the fixed list (the build passes)', () => {
    expect(loadsOutside(CLASS)).toEqual([]);
  });

  it('the fixed list is the list of packages the class loads, in full', () => {
    const packages = loadsOf(CLASS)
      .filter((l) => l.kind === 'package')
      .map((l) => l.name);
    expect([...new Set(packages)].sort()).toEqual([...FIXED_LIST].sort());
  });

  it('a package added with \\RequirePackage fails the gate', () => {
    const lines = CLASS.split('\n');
    const at = lines.findIndex((l) => l.includes('\\RequirePackage{hyperref}'));
    expect(at).toBeGreaterThan(-1);
    lines.splice(at + 1, 0, '\\RequirePackage{minted}');
    expect(loadsOutside(lines.join('\n'))).toEqual(['minted']);
  });

  it('a package added with \\usepackage and options fails the gate, with a comment after it', () => {
    const mutated = `${CLASS}\n\\usepackage[draft]{tikz} % a comment after the load\n`;
    expect(loadsOutside(mutated)).toEqual(['tikz']);
  });

  it('a package added with \\RequirePackageWithOptions fails the gate', () => {
    const mutated = `${CLASS}\n\\RequirePackageWithOptions{shellesc}\n`;
    expect(loadsOutside(mutated)).toEqual(['shellesc']);
  });

  it('a class added with \\LoadClass fails the gate', () => {
    const mutated = `${CLASS}\n\\LoadClass{report}\n`;
    expect(loadsOutside(mutated)).toEqual(['report']);
  });

  it('a comma-separated list is read name by name, and each unlisted name is refused', () => {
    const mutated = `${CLASS}\n\\usepackage{xcolor,pstricks}\n`;
    expect(loadsOutside(mutated)).toEqual(['pstricks']);
  });

  it('a load written in a comment is not a load', () => {
    const mutated = `${CLASS}\n% \\RequirePackage{tikz}\n`;
    expect(loadsOutside(mutated)).toEqual([]);
  });
});
