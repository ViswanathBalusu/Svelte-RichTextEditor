// Which engine runs which semantics fixture (CDM-005 criterion 4, ADR 0361). The table below is the
// record that the owners of the layout engine (FE) and of the LaTeX class (EXP) review: `run` means
// a test of that package reads the fixture file, `gap` means none does. The test fails when the
// table and the test files disagree, when a cell of ADR 0361 says Run or Gap against them, when a
// test file that the record names does not exist or does not read its fixture, or when the record
// does not name a fixture file or one of the rosters the two engines keep. So the record cannot go
// stale without notice. Node.js only: it lists directories.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type State = 'run' | 'gap';
type Engine = 'layout' | 'latex';

const root = join(import.meta.dirname, '../../..');
const fixtures = join(root, 'packages/model/fixtures/semantics');
const record = readFileSync(join(root, 'docs/adr/0361-w1-CDM-005-fixture-review.md'), 'utf8');

const PACKAGES: Readonly<Record<Engine, string>> = { layout: 'layout', latex: 'export-latex' };
/** The roster each engine keeps in its own package (FE-077 criterion 6; EXP-115). */
const ROSTERS: Readonly<Record<Engine, string>> = {
  layout: 'packages/layout/src/fe-077-fixtures.test.ts',
  latex: 'packages/export-latex/src/exp-115-registry.test.ts',
};

const expected: Readonly<Record<string, Readonly<Record<Engine, State>>>> = {
  'cascade.json': { layout: 'run', latex: 'run' },
  'date-fields.json': { layout: 'gap', latex: 'run' },
  'header-growth.json': { layout: 'run', latex: 'run' },
  'line-spacing.json': { layout: 'run', latex: 'run' },
  'numbering-footnotes.json': { layout: 'run', latex: 'run' },
  'numbering-lists.json': { layout: 'run', latex: 'run' },
  'numbering-projections.json': { layout: 'run', latex: 'gap' },
  'numbering-references.json': { layout: 'run', latex: 'run' },
  'numbering-sequences.json': { layout: 'run', latex: 'run' },
  'paragraph-spacing.json': { layout: 'run', latex: 'run' },
  'tabs.json': { layout: 'run', latex: 'run' },
  'whitespace.json': { layout: 'gap', latex: 'gap' },
};

/** The test files in a package's `src` and `test` folders, by path from the package (with `/`). */
function tests(pkg: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const folder of ['src', 'test']) {
    let names: string[];
    try {
      names = readdirSync(join(root, 'packages', pkg, folder), { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.test.ts'))
        out.set(
          `${folder}/${name.replaceAll('\\', '/')}`,
          readFileSync(join(root, 'packages', pkg, folder, name), 'utf8'),
        );
    }
  }
  return out;
}

/**
 * Whether a test file reads a fixture file. It names the file by its path, or it loads it by name
 * through the loader of EXP-115 (`loadSemantics` in `packages/export-latex/test/exp-115-fixtures.ts`),
 * where the names may stand in a list beside the call. A roster that only lists the names (the
 * registry of EXP-115) reads nothing and does not count.
 */
function reads(source: string, name: string): boolean {
  if (source.includes(`fixtures/semantics/${name}`)) return true;
  if (!/\bloadSemantics\s*[<(]/.test(source)) return false;
  return source.includes(`'${name.slice(0, -'.json'.length)}'`);
}

const state = (files: ReadonlyMap<string, string>, name: string): State =>
  [...files.values()].some((source) => reads(source, name)) ? 'run' : 'gap';

/** The rows of the record's table: the cell of each engine, by fixture file. */
function rows(): Map<string, Readonly<Record<Engine, string>>> {
  const out = new Map<string, Readonly<Record<Engine, string>>>();
  for (const raw of record.split('\n')) {
    const line = raw.trimEnd();
    if (!line.startsWith('| `') || !line.endsWith(' |')) continue;
    const cells = line.slice(2, -2).split(' | ');
    const name = /^`([a-z-]+\.json)`$/.exec(cells[0] ?? '')?.[1];
    if (name && cells.length === 3) out.set(name, { layout: cells[1]!, latex: cells[2]! });
  }
  return out;
}

describe('semantics fixtures and the engines that run them (ADR 0361)', () => {
  const names = readdirSync(fixtures).filter((n) => n.endsWith('.json'));
  const files: Readonly<Record<Engine, Map<string, string>>> = {
    layout: tests(PACKAGES.layout),
    latex: tests(PACKAGES.latex),
  };
  const table = rows();

  it('the record covers every fixture file and no other', () => {
    expect(Object.keys(expected).sort()).toEqual([...names].sort());
    for (const name of names) expect(record, name).toContain(`\`${name}\``);
    expect([...table.keys()].sort()).toEqual([...names].sort());
  });

  it('the record names the roster each engine keeps, and both exist', () => {
    for (const roster of Object.values(ROSTERS)) {
      expect(existsSync(join(root, roster)), roster).toBe(true);
      expect(record, roster).toContain(`\`${roster}\``);
    }
  });

  it.each(names)('%s is run, or not, as the record says', (name) => {
    const found = { layout: state(files.layout, name), latex: state(files.latex, name) };
    expect(found).toEqual(expected[name]);
    // The cell of each engine starts with the same word.
    for (const engine of ['layout', 'latex'] as const)
      expect(table.get(name)![engine], `${name}, ${engine}`).toMatch(
        found[engine] === 'run' ? /^Run: / : /^Gap[,.]/,
      );
  });

  it.each(names)('every test file the record names for %s exists and reads it', (name) => {
    for (const engine of ['layout', 'latex'] as const) {
      const named = [...table.get(name)![engine].matchAll(/`((?:src|test)\/[\w./-]+\.test\.ts)`/g)];
      // A cell that says Run names at least one test file.
      if (expected[name]![engine] === 'run')
        expect(named.length, `${name}, ${engine}`).toBeGreaterThan(0);
      for (const [, path] of named) {
        const source = files[engine].get(path!);
        expect(source, `${PACKAGES[engine]}/${path}`).toBeDefined();
        expect(reads(source!, name), `${PACKAGES[engine]}/${path} reads ${name}`).toBe(true);
      }
    }
  });

  it('counts a loader call with the name in a list, and not a roster that only lists names', () => {
    const runner = "const FILES = ['numbering-lists'] as const;\nloadSemantics<File>(name);";
    expect(reads(runner, 'numbering-lists.json')).toBe(true);
    expect(reads(runner, 'numbering-footnotes.json')).toBe(false);
    expect(reads("const REGISTRY = { 'numbering-lists': {} };", 'numbering-lists.json')).toBe(
      false,
    );
    expect(reads("import f from '../../model/fixtures/semantics/tabs.json';", 'tabs.json')).toBe(
      true,
    );
    // The registry of EXP-115 is such a roster, and the numbering runner is such a runner.
    const registry = files.latex.get('src/exp-115-registry.test.ts');
    expect(registry).toBeDefined();
    for (const name of names) expect(reads(registry!, name), name).toBe(false);
    const numbering = files.latex.get('src/exp-115-numbering.compile.test.ts');
    expect(numbering).toBeDefined();
    expect(names.filter((n) => reads(numbering!, n)).sort()).toEqual([
      'numbering-footnotes.json',
      'numbering-lists.json',
      'numbering-references.json',
      'numbering-sequences.json',
    ]);
  });
});
