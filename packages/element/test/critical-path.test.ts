// FE-119 criterion 2 (static part): the modules the element loads at connect time must not
// statically import the PDF viewer, the math editor, print or the read view. Those load with the
// first use (dynamic `import()`), so they are off the critical path. This walks the value imports
// (`import`, `export ... from`, side-effect imports; `import type` is erased and not walked) from
// the package entry. It is a source-level proxy: the network listing in a browser (FE-119
// criterion 2 in full) is not run here.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');
const ENTRY = resolve(SRC, 'index.ts');

/** Modules that must stay off the critical path (02 §2; FE-119 criterion 2). */
const OFF_CRITICAL_PATH = [
  'features/pdf.ts',
  'features/math.ts',
  'pdf/viewer-frame.ts',
  'pdf/messages.ts',
  'print.ts',
  'read-view.ts',
];

/** The value-import specifiers of one module, relative ones only, resolved to files. */
function staticImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
    // Comments first, so that a commented import is not walked.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const specifiers: string[] = [];
  const statement = /^\s*(import|export)\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]\s*;?/gm;
  const sideEffect = /^\s*import\s*['"]([^'"]+)['"]\s*;?/gm;
  for (const m of source.matchAll(statement)) {
    const [, keyword, clause, spec] = m;
    // `import type { … }` and `export type { … }` are erased; `import { type X }` is kept (verbatim).
    if (keyword === 'import' && /^type\s/.test(clause ?? '')) continue;
    if (keyword === 'export' && /^type\s/.test(clause ?? '')) continue;
    if (spec) specifiers.push(spec);
  }
  for (const m of source.matchAll(sideEffect)) if (m[1]) specifiers.push(m[1]);
  return specifiers.filter((s) => s.startsWith('.'));
}

/** Every source file reached by value imports from `start`, as paths relative to `src`. */
function reachable(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(file)) {
      queue.push(resolve(dirname(file), spec));
    }
  }
  return new Set([...seen].map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/')));
}

describe('the element entry (FE-119 criterion 2, static imports)', () => {
  const reached = reachable(ENTRY);

  it('reaches the core modules it needs at connect time', () => {
    expect(reached.has('doc-editor.ts')).toBe(true);
    expect(reached.has('register.ts')).toBe(true);
  });

  it('does not statically reach the PDF viewer, math editor, print or read view', () => {
    const onPath = OFF_CRITICAL_PATH.filter((f) => reached.has(f));
    expect(onPath).toEqual([]);
  });

  it('never reaches the editor chunk statically (it loads with the first document)', () => {
    // editor.ts is the one dynamically imported chunk the element uses; a static reach would
    // put the whole editor on the critical path.
    expect(reached.has('editor.ts')).toBe(false);
  });
});
