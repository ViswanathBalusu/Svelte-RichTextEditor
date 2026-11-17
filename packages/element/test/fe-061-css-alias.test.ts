// FE-061 criterion 4, second part: the component CSS refers to no font file's family by name. A
// `font-family` declaration may hold only generic families, `system-ui`, the page-safe system
// stack (Georgia), custom properties, and hash aliases. Runs in Node.js.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FONT_ALIAS_PREFIX } from '../src/font-registration.ts';

const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'inherit',
  'initial',
  'unset',
  'georgia',
]);

/** The family names a `font-family` value names, outside `var(...)` and with its defaults read. */
function families(value: string): string[] {
  // Read the fallback of each var(--x, fallback) as part of the list.
  let flat = value;
  for (let i = 0; i < 8; i += 1) flat = flat.replace(/var\(\s*--[\w-]+\s*,?\s*([^()]*)\)/g, '$1');
  flat = flat.replace(/var\(\s*--[\w-]+\s*\)/g, '');
  return flat
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((name) => name.length > 0);
}

function cssFiles(): { name: string; text: string }[] {
  const dirs = [new URL('../src/styles/', import.meta.url), new URL('../src/pdf/viewer/', import.meta.url)];
  const out: { name: string; text: string }[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
      const text = readFileSync(new URL(name, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      out.push({ name, text });
    }
  }
  return out;
}

describe('the component CSS names no font by family (FE-061 criterion 4)', () => {
  it('has font-family declarations to check', () => {
    const count = cssFiles().reduce((n, f) => n + [...f.text.matchAll(/font-family\s*:/g)].length, 0);
    expect(count).toBeGreaterThan(0);
  });

  it('holds only generic families, the system stack or hash aliases in every font-family', () => {
    for (const { name, text } of cssFiles()) {
      for (const match of text.matchAll(/font-family\s*:\s*([^;}]+)[;}]/g)) {
        for (const family of families(match[1] ?? '')) {
          const ok = GENERIC.has(family.toLowerCase()) || family.startsWith(FONT_ALIAS_PREFIX);
          expect(ok, `${name}: "${family}" in "${match[0]}"`).toBe(true);
        }
      }
    }
  });

  it('does not name a bundled family such as Noto, STIX, Carlito or Liberation anywhere', () => {
    for (const { name, text } of cssFiles()) {
      expect(text, name).not.toMatch(/Noto|STIX|Carlito|Caladea|Liberation/i);
    }
  });
});
