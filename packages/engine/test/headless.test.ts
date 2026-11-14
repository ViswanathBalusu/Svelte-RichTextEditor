/**
 * The editing core runs in Node.js without a browser (02 §14; FE-121): the headless entry loads
 * with no DOM and reaches no module of the view layer (`prosemirror-view`, the web view, the DOM
 * helpers). The check walks the runtime imports of the package's own modules and of the
 * ProseMirror packages they reach; type-only imports are erased and do not count.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(import.meta.dirname, '../src');
const require = createRequire(resolve(import.meta.dirname, '../package.json'));

/** Module specifiers imported for their values (not `import type`, not `export type`). */
function valueImports(text: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)([^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(re)) {
    const what = m[2] ?? '';
    // `import { type A, type B } from` imports nothing at run time.
    const names = /\{([^}]*)\}/.exec(what)?.[1];
    if (names && names.split(',').every((n) => n.trim() === '' || n.trim().startsWith('type ')))
      continue;
    out.push(m[3]!);
  }
  return out;
}

function reach(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else if (spec.startsWith('prosemirror-')) visitPackage(spec);
      else packages.add(spec);
    }
  };
  const visitPackage = (name: string) => {
    if (packages.has(name)) return;
    packages.add(name);
    const main = require.resolve(name);
    const text = readFileSync(main, 'utf8');
    for (const m of text.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm))
      if (m[1]!.startsWith('prosemirror-')) visitPackage(m[1]!);
  };
  visit(entry);
  return new Set([
    ...[...seen].map((f) => f.slice(src.length + 1).replaceAll('\\', '/')),
    ...packages,
  ]);
}

describe('the editing core without a browser (FE-121)', () => {
  it('the headless entry reaches no view module and no prosemirror-view', () => {
    const reached = reach(resolve(src, 'headless.ts'));
    expect(reached.has('prosemirror-view')).toBe(false);
    expect(reached.has('prosemirror-gapcursor')).toBe(false);
    expect(reached.has('prosemirror-dropcursor')).toBe(false);
    for (const f of reached) {
      expect(f.startsWith('view/'), f).toBe(false);
      expect(f, f).not.toBe('view-support.ts');
      expect(f, f).not.toBe('subeditor.ts');
      expect(f, f).not.toBe('testing.ts');
    }
    // The main entry, with the web view, does reach it: the view layer is a separate part.
    expect(reach(resolve(src, 'index.ts')).has('prosemirror-view')).toBe(true);
  });

  it('loads and edits in Node.js with no DOM', async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    const { DocumentCore } = await import('../src/headless.ts');
    const { spikeDocument } = await import('../src/spike-document.ts');
    const core = new DocumentCore({ doc: spikeDocument() });
    expect(core.run('selectAll')).toBe(true);
    expect(core.run('italic')).toBe(true);
    expect(core.queryCommand('italic').active).toBe(true);
    expect(core.run('undo')).toBe(true);
    expect(core.queryCommand('italic').active).toBe(false);
    core.destroy();
  });
});
