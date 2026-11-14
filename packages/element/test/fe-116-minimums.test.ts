// The integration guide lists the declared browser minimums, with their reasons, and matches the
// versions the build targets (02 §12; FE-116, criterion 3).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_MINIMUMS } from '../scripts/vite-configs.ts';

const ELEMENT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const guide = readFileSync(resolve(ELEMENT, 'docs/policies-and-side-effects.md'), 'utf8');

/** The lines of one `## ` section of the guide, from its heading up to the next `## `. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l === `## ${heading}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((l) => l.startsWith('## '));
  return next < 0 ? rest : rest.slice(0, next);
}

interface Row {
  browser: string;
  minimum: string;
  reason: string;
}

function minimumRows(lines: string[]): Row[] {
  return lines
    .filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.startsWith('| Browser'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .map(([browser = '', minimum = '', reason = '']) => ({ browser, minimum, reason }));
}

describe('the integration guide browser minimums (FE-116, criterion 3)', () => {
  const lines = section(guide, 'Browser minimums');
  const rows = minimumRows(lines);
  const rowFor = (browser: string): Row | undefined => rows.find((r) => r.browser === browser);

  it('has a Browser minimums section with a row for each browser family', () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.browser)).toEqual(['Chrome and Edge', 'Firefox', 'Safari']);
  });

  it('gives the same versions the build targets (BROWSER_MINIMUMS)', () => {
    const built = new Map<string, string>();
    for (const target of BROWSER_MINIMUMS) {
      const m = /^([a-z]+)(\d+)$/.exec(target);
      expect(m, `unexpected target ${target}`).not.toBeNull();
      built.set(m![1]!, m![2]!);
    }
    expect(rowFor('Chrome and Edge')?.minimum).toBe(built.get('chrome'));
    expect(built.get('edge')).toBe(built.get('chrome'));
    expect(rowFor('Firefox')?.minimum).toBe(built.get('firefox'));
    expect(rowFor('Safari')?.minimum).toBe(built.get('safari'));
  });

  it('gives a reason for each minimum, naming the selection API that sets it', () => {
    expect(rowFor('Chrome and Edge')?.reason).toContain('Selection.getComposedRanges()');
    expect(rowFor('Firefox')?.reason).toContain('shadow');
    expect(rowFor('Safari')?.reason).toContain('Selection.getComposedRanges()');
    for (const row of rows) {
      expect(row.reason.length, `no reason for ${row.browser}`).toBeGreaterThan(0);
    }
  });

  it('states that browsers below the minimums are unsupported', () => {
    expect(lines.join('\n')).toMatch(/Browsers below them are unsupported/);
  });
});
