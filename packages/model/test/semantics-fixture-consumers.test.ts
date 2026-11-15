// Which engine runs which semantics fixture (CDM-005 criterion 4, ADR 0361). The table below is the
// record that the owners of the layout engine (FE) and of the LaTeX class (EXP) review: `run` means
// a test of that package imports the fixture file, `gap` means none does. The test fails when the
// table and the test files disagree, or when ADR 0361 does not name a fixture file, so the record
// cannot go stale without notice. Node.js only: it lists directories.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type State = 'run' | 'gap';

const root = join(import.meta.dirname, '../../..');
const fixtures = join(root, 'packages/model/fixtures/semantics');
const record = readFileSync(join(root, 'docs/adr/0361-w1-CDM-005-fixture-review.md'), 'utf8');

const expected: Readonly<Record<string, { readonly layout: State; readonly latex: State }>> = {
  'cascade.json': { layout: 'gap', latex: 'run' },
  'date-fields.json': { layout: 'gap', latex: 'gap' },
  'header-growth.json': { layout: 'run', latex: 'run' },
  'line-spacing.json': { layout: 'run', latex: 'gap' },
  'numbering-footnotes.json': { layout: 'run', latex: 'gap' },
  'numbering-lists.json': { layout: 'run', latex: 'gap' },
  'numbering-projections.json': { layout: 'gap', latex: 'gap' },
  'numbering-references.json': { layout: 'gap', latex: 'gap' },
  'numbering-sequences.json': { layout: 'gap', latex: 'gap' },
  'paragraph-spacing.json': { layout: 'run', latex: 'run' },
  'tabs.json': { layout: 'run', latex: 'run' },
  'whitespace.json': { layout: 'gap', latex: 'gap' },
};

/** The text of every test file in a package's `src` and `test` folders. */
function tests(pkg: string): string {
  const out: string[] = [];
  for (const folder of ['src', 'test']) {
    let names: string[];
    try {
      names = readdirSync(join(root, 'packages', pkg, folder), { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.test.ts'))
        out.push(readFileSync(join(root, 'packages', pkg, folder, name), 'utf8'));
    }
  }
  return out.join('\n');
}

const state = (text: string, name: string): State =>
  text.includes(`fixtures/semantics/${name}`) ? 'run' : 'gap';

describe('semantics fixtures and the engines that run them (ADR 0361)', () => {
  const names = readdirSync(fixtures).filter((n) => n.endsWith('.json'));
  const layout = tests('layout');
  const latex = tests('export-latex');

  it('the record covers every fixture file and no other', () => {
    expect(Object.keys(expected).sort()).toEqual([...names].sort());
    for (const name of names) expect(record, name).toContain(`\`${name}\``);
  });

  it.each(names)('%s is run, or not, as the record says', (name) => {
    expect({ layout: state(layout, name), latex: state(latex, name) }).toEqual(expected[name]);
  });
});
