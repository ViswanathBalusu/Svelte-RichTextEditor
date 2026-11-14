/**
 * Forced colours of the shell (UX-062, criterion 1). This is a source check of the stylesheet that
 * the shell ships: the `@media (forced-colors: active)` block of `src/styles/shell.css` must use
 * system colours only, and its focus indicator must stay distinguishable with a system colour. No
 * browser renders the shell here; the emulated run is UX-062's Playwright criterion, not claimed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/shell.css', import.meta.url)),
  'utf8',
);

const MEDIA = '@media (forced-colors: active) {';

/** The text of the forced-colours block: from its opening brace to the matching closing brace. */
function forcedBlock(css: string): string {
  const start = css.indexOf(MEDIA);
  if (start < 0) throw new Error('shell.css has no @media (forced-colors: active) block');
  let depth = 0;
  for (let i = start + MEDIA.length - 1; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return css.slice(start + MEDIA.length, i);
    }
  }
  throw new Error('the forced-colours block is not closed');
}

/** The rules of a block as selector and declarations, in source order. */
function rules(block: string): Array<{ selector: string; body: string }> {
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim(),
    body: m[2]!,
  }));
}

/** The CSS system colour keywords (CSS Color 4, section 6.2), in lower case. */
const SYSTEM_COLOURS = new Set([
  'canvas',
  'canvastext',
  'linktext',
  'visitedtext',
  'activetext',
  'buttonface',
  'buttontext',
  'buttonborder',
  'field',
  'fieldtext',
  'highlight',
  'highlighttext',
  'selecteditem',
  'selecteditemtext',
  'mark',
  'marktext',
  'graytext',
  'accentcolor',
  'accentcolortext',
]);

const COLOUR_PROPERTIES = [
  'background',
  'background-color',
  'color',
  'border-color',
  'outline',
  'box-shadow',
];

/** The declarations of a rule body as [property, value] pairs. */
function declarations(body: string): Array<[string, string]> {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.includes(':'))
    .map((d) => {
      const at = d.indexOf(':');
      return [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim()] as [string, string];
    });
}

describe('forced colours of the shell (UX-062, criterion 1)', () => {
  const block = forcedBlock(CSS);
  const all = rules(block);

  it('has a forced-colours block whose rules the parser reads (so the checks below are not empty)', () => {
    expect(all.length).toBe(11);
    expect(all.some((r) => r.selector === '.de-avatar')).toBe(true);
    expect(all.some((r) => r.selector === '.de-shell :focus-visible')).toBe(true);
  });

  it('uses no hard-coded colour in the block: no hex, rgb() or hsl() value', () => {
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/i);
  });

  it('gives every colour declaration of the block a system colour keyword', () => {
    for (const { selector, body } of all) {
      for (const [property, value] of declarations(body)) {
        if (!COLOUR_PROPERTIES.includes(property)) continue;
        const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
        const system = words.some((w) => SYSTEM_COLOURS.has(w));
        expect(system, `${selector} sets ${property}: ${value}`).toBe(true);
      }
    }
  });

  it('keeps the focus indicator of the shell in a system colour, visible and solid', () => {
    const focus = all.find((r) => r.selector === '.de-shell :focus-visible');
    expect(focus, 'the focus rule of the shell is in the block').toBeDefined();
    const outline = declarations(focus!.body).find(([p]) => p === 'outline');
    expect(outline).toBeDefined();
    const [, value] = outline!;
    expect(value).toMatch(/\b\d+px\b/);
    expect(value).toMatch(/\bsolid\b/);
    expect(value.toLowerCase()).toMatch(/\bhighlight\b/);
  });

  it('marks the selected and pressed states with a shape as well as a colour', () => {
    const state = all.find((r) => r.selector.includes("aria-pressed='true'"));
    expect(state).toBeDefined();
    const props = declarations(state!.body).map(([p]) => p);
    expect(props).toContain('box-shadow');
  });
});
