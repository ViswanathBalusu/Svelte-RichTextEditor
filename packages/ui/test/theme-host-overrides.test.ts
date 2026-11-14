/**
 * A host's `--de-` overrides apply on top of the built-in themes (UX-061, criterion 5).
 *
 * This is a source check of `src/styles/shell.css`. Each theme token must read the public `--de-`
 * property of the same name, as `--_de-x: var(--de-x, fallback)`. A host value set on the element or
 * on an ancestor is then what `var()` gives in every theme, and the theme's colour is only the
 * fallback. The check reads the stylesheet's text; it does not render the shell, and no browser
 * run is made here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/shell.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selector: string;
  body: string;
}

/** The top-level rules of the stylesheet (at-rules such as the forced-colours block are skipped). */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    if (selector.startsWith('@')) continue;
    out.push({ selector, body: m[2]! });
  }
  return out;
}

/**
 * The internal tokens a rule body declares. `bad` lists each declaration that does not read the
 * public property of the same name.
 */
function tokensOf(body: string): { names: string[]; bad: string[] } {
  const names: string[] = [];
  const bad: string[] = [];
  for (const decl of body.split(';')) {
    const d = decl.trim();
    if (!d.startsWith('--_de-')) continue;
    const m = /^--_de-([a-z0-9-]+)\s*:\s*var\(--de-([a-z0-9-]+),\s*(.+)\)$/.exec(d);
    if (!m || m[1] !== m[2]) bad.push(d);
    else names.push(m[1]!);
  }
  return { names, bad };
}

const ALL = rules();
const BASE = ALL.find((r) => r.selector === '.de-shell');
if (!BASE) throw new Error('shell.css has no .de-shell rule');
// The theme rules are those keyed on `data-theme` that set internal tokens; control rules keyed on
// it (such as the high-contrast borders of the buttons) set no token and are not themes.
const THEME_RULES = ALL.filter(
  (r) => r.selector.includes('data-theme=') && r.body.includes('--_de-'),
);

describe('host overrides on top of the built-in themes (UX-061, criterion 5)', () => {
  it('finds the base rule and each theme rule, so the checks below are not empty', () => {
    expect(tokensOf(BASE.body).names.length).toBeGreaterThan(20);
    expect(THEME_RULES.map((r) => r.selector)).toEqual(
      expect.arrayContaining([
        ".de-shell[data-theme='dark']",
        ".de-shell[data-theme='dark'][data-page-theme='follow']",
        ".de-shell[data-theme='high-contrast']",
      ]),
    );
  });

  it('gives every token of the base rule a public property of the same name as its default', () => {
    expect(tokensOf(BASE.body).bad).toEqual([]);
  });

  it('gives every token of each theme rule a public property of the same name, with the theme colour as the fallback', () => {
    for (const rule of THEME_RULES) {
      const { names, bad } = tokensOf(rule.body);
      expect(bad, rule.selector).toEqual([]);
      expect(names.length, rule.selector).toBeGreaterThan(0);
    }
  });

  it('declares every theme token in the base rule too, so no theme token lacks a host-reachable default', () => {
    const base = new Set(tokensOf(BASE.body).names);
    for (const rule of THEME_RULES) {
      for (const name of tokensOf(rule.body).names) {
        expect(base.has(name), `${name} in ${rule.selector}`).toBe(true);
      }
    }
  });
});
