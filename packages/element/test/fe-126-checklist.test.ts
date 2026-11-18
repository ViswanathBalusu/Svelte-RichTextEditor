/**
 * FE-126 criterion 3: the manual screen-reader checklist (docs/test-plan/accessibility-manual-pass.md)
 * covers list semantics, live regions, Escape and Ctrl+F6, dialogs and the guided flows, and each
 * of those sections has items. It also keeps the list of combinations (criterion 2, the list half).
 * The results table is not checked: no pass has been run.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(
  join(here, '../../../docs/test-plan/accessibility-manual-pass.md'),
  'utf8',
);

/** The body of the section whose heading starts with `heading`, up to the next heading of its level. */
function section(heading: string): string {
  const start = text.indexOf(`\n### ${heading}`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(4).search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next + 4);
}

describe('FE-126 criterion 3: the checklist covers what the criterion names', () => {
  const required: [string, RegExp][] = [
    ['3.1 List semantics', /list item/i],
    ['3.2 Live regions', /announced/i],
    ['3.3 Escape and Ctrl+F6', /Ctrl\+F6/],
    ['3.4 Dialogs', /focus/i],
    ['3.5 Guided flows', /accessibility checker/i],
  ];

  for (const [heading, word] of required) {
    it(`has the section ${heading}, with at least three items that mention what it tests`, () => {
      const body = section(heading);
      const items = body.split('\n').filter((l) => l.startsWith('- '));
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(body).toMatch(word);
    });
  }

  it('names Escape in the Escape and Ctrl+F6 section', () => {
    expect(section('3.3 Escape and Ctrl+F6')).toMatch(/Escape/);
  });

  it('lists screen-reader and browser combinations, each with an identifier', () => {
    const rows = text.split('\n').filter((l) => /^\| SR\d+ \|/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const systems = new Set(rows.map((r) => r.split('|')[4]?.trim()));
    expect([...systems].sort()).toEqual(['Android', 'Windows', 'iOS', 'macOS']);
  });
});
