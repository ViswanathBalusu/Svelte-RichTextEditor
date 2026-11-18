/**
 * EXP-015 criterion 2 (Node.js only, source audit): the house class builds headings on the kernel's
 * sectioning commands, lists and list labels with its own macros on the kernel list environment,
 * tab stops in Lua, and row spans without `multirow`. This reads `class/docedit.cls` and
 * `class/docedit.lua` as text. It does not compile anything, so it shows how the class is built,
 * not how the PDF looks; that needs a LuaLaTeX run, which is not done here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
const LUA = readFileSync(fileURLToPath(new URL('../class/docedit.lua', import.meta.url)), 'utf8');

/** The class source with its comment lines removed, so that a word in a comment does not count. */
function code(source: string): string {
  return source
    .split('\n')
    .map((l) => l.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');
}

const CLS = code(CLASS);
const LUA_CODE = LUA.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

describe('EXP-015 criterion 2: headings use the kernel sectioning commands', () => {
  it('redefines each sectioning command with \\@startsection, at its own level', () => {
    const levels = [
      ['section', 1],
      ['subsection', 2],
      ['subsubsection', 3],
      ['paragraph', 4],
      ['subparagraph', 5],
    ] as const;
    for (const [name, level] of levels) {
      const re = new RegExp(
        String.raw`\\renewcommand\\${name}\{\\@startsection\{${name}\}\{${level}\}`,
      );
      expect(CLS, name).toMatch(re);
    }
  });

  it('builds heading formatting from the class macros, not from a sectioning package', () => {
    expect(CLS).toMatch(/\\newcommand\\DE@hfmt\{/);
    expect(CLS).not.toMatch(/\\usepackage[^\n]*titlesec|\\RequirePackage[^\n]*titlesec/);
  });
});

describe('EXP-015 criterion 2: lists and labels use the kernel list and the class macros', () => {
  it('defines DElist on the kernel \\list environment', () => {
    // Comments are stripped from CLS, so the environment's opening brace ends its line.
    expect(CLS).toMatch(/\\newenvironment\{DElist\}\[1\]\{\s*\n\s*\\list\{\}/);
  });

  it('sets list labels with the class macro \\DE@labellayout, not a counter of LaTeX', () => {
    expect(CLS).toMatch(/\\newcommand\\DE@labellayout\[2\]\{/);
    expect(CLS).toMatch(/\\DE@labellayout\{/);
    // No list counter is created or stepped by the class (09 §3.1: labels are literal text).
    expect(CLS).not.toMatch(/\\newcounter\{(?:enum|item)/);
  });

  it('does not load enumitem', () => {
    expect(CLS).not.toMatch(/enumitem/);
  });
});

describe('EXP-015 criterion 2: tab stops are implemented in Lua', () => {
  it('defines the tab-stop functions in docedit.lua and calls them from the class', () => {
    expect(LUA_CODE).toMatch(/function docedit\.next_tab_stop\(/);
    expect(LUA_CODE).toMatch(/function docedit\.place_tab\(/);
    expect(LUA_CODE).toMatch(/function docedit\.deftabs\(/);
    expect(CLS).toMatch(/\\directlua\{docedit\.deftabs\(/);
    expect(CLS).toMatch(/\\directlua\{docedit\.labeltab\(/);
  });

  it('does not use tabto, which the class must not load', () => {
    expect(CLS).not.toMatch(/\\tabto\b|tabto\}/);
  });
});

describe('EXP-015 criterion 2: row spans do not use multirow', () => {
  it('defines \\DErowspan from \\vtop and \\vbox and never loads or calls multirow', () => {
    expect(CLS).toMatch(
      /\\newcommand\\DErowspan\[2\]\{\\par\\ifdefined\\tagpdfsetup\\tagpdfsetup\{table\/multirow=#1\}\\fi\s*\\setbox\\@tempboxa\\vtop\{#2\}\\vbox to\\z@\{\\kern-\\ht\\@tempboxa\\box\\@tempboxa\\vss\}\}/,
    );
    expect(CLS).not.toMatch(/\\multirow/);
    expect(LUA_CODE).not.toMatch(/multirow/);
  });
});
