// FE-108 (source guard): the editor's interface and editing code never look up ids or selectors on
// the document, so every ARIA reference (aria-labelledby, aria-describedby, aria-controls, aria-owns,
// aria-activedescendant) and every `for` label can only resolve inside the element's own shadow root.
// This is a Node.js source check, not a DOM check: it stops the cross-root lookups that would break
// the references. It does not prove that each reference resolves at run time (FE-108 criteria 1 and 4
// need a browser run), and it is not the lint rule of criterion 2 (a root configuration change).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
/** Source trees that render or edit inside the element's shadow root. */
const SCANNED = ['packages/ui/src', 'packages/element/src', 'packages/engine/src'];
/** The PDF viewer runs as its own page (its own document), so it is not in the root. */
const EXCLUDED = [`packages${sep}element${sep}src${sep}pdf${sep}`];

const SOURCE = /\.(ts|svelte|js)$/;
/**
 * Test files are not editor code: they drive the real document on purpose (in a browser run), so
 * they are not scanned. Only the production source of the three trees is.
 */
const TEST_FILE = /\.test\.(ts|js)$/;
/**
 * Document-wide id and selector lookups: they reach outside the shadow root. Reads of body or head
 * (diagnostics in features/math.ts) are not lookups and are not matched.
 */
const GLOBAL_LOOKUP =
  /\bdocument\s*\.\s*(getElementById|getElementsByClassName|getElementsByName|getElementsByTagName|querySelector|querySelectorAll)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) out.push(path);
  }
  return out;
}

/** Each line of `file` that looks up the document outside the root, comment lines excepted. */
function globalLookups(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits: string[] = [];
  lines.forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    if (GLOBAL_LOOKUP.test(line)) hits.push(`${relative(REPO, file)}:${i + 1}`);
  });
  return hits;
}

describe('FE-108 (source guard): no document-wide id or selector lookups in the editor', () => {
  it('finds no document.getElementById or querySelector in the scanned trees', () => {
    const hits: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sourceFiles(join(REPO, dir))) {
        const rel = relative(REPO, file);
        if (EXCLUDED.some((e) => rel.includes(e))) continue;
        hits.push(...globalLookups(file));
      }
    }
    expect(hits).toEqual([]);
  });

  it('would catch a document-wide lookup (the guard itself)', () => {
    expect(GLOBAL_LOOKUP.test("const el = document.getElementById('x');")).toBe(true);
    expect(GLOBAL_LOOKUP.test('document.querySelectorAll(".a")')).toBe(true);
    expect(GLOBAL_LOOKUP.test('root.querySelector(".a")')).toBe(false);
    expect(GLOBAL_LOOKUP.test('bodyClassesAfter: document.body.className')).toBe(false);
  });
});
