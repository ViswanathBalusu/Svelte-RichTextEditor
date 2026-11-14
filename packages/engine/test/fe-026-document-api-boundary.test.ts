/**
 * The document API boundary (02 §5.1; FE-026 criterion 1): the interface, the element and the
 * host applications reach ProseMirror only through `@docedit/engine`. This is a source scan that
 * runs in Node.js. It is not the lint rule the criterion names; the dependency-cruiser rules in
 * `.dependency-cruiser.cjs` do not match an unresolved `prosemirror-*` import (see the story's
 * Notes), so this test is the mechanical check until that root rule is changed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Directories whose sources must not import ProseMirror. */
const SCANNED = ['packages/ui/src', 'packages/element/src', 'apps'];

const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  '.svelte-kit',
  'test-results',
  'build',
  'coverage',
]);
const SOURCE_EXT = /\.(ts|js|mjs|svelte|tsx|jsx)$/;

/**
 * An import, re-export, dynamic import or require of a `prosemirror-*` module. A bare mention in
 * a comment or a string that is not a module specifier is not matched.
 */
const PROSEMIRROR_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]prosemirror-[a-z-]+['"]/;

export interface BoundaryFinding {
  readonly line: number;
  readonly text: string;
}

/** Lines of one source file that import a `prosemirror-*` module. */
export function prosemirrorImports(source: string): BoundaryFinding[] {
  const found: BoundaryFinding[] = [];
  source.split('\n').forEach((text, i) => {
    if (PROSEMIRROR_IMPORT.test(text)) found.push({ line: i + 1, text: text.trim() });
  });
  return found;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (SOURCE_EXT.test(name)) yield path;
  }
}

describe('FE-026 criterion 1: no prosemirror-* import outside the editing core', () => {
  it('detects the import forms the boundary forbids', () => {
    const probes = [
      `import { Plugin } from 'prosemirror-state';`,
      `import type { EditorView } from "prosemirror-view";`,
      `export { Schema } from 'prosemirror-model';`,
      `const m = await import('prosemirror-transform');`,
      `import 'prosemirror-history';`,
      `const k = require('prosemirror-keymap');`,
      `<script lang="ts">import { keymap } from 'prosemirror-keymap';</script>`,
    ];
    for (const probe of probes) {
      expect(prosemirrorImports(probe), probe).toHaveLength(1);
    }
  });

  it('does not flag the document API or a mention that is not a module specifier', () => {
    const clean = [
      `import { createDocumentApi } from '@docedit/engine';`,
      `// The core is built on prosemirror-state; the shell never imports it.`,
      `const label = 'prosemirror-state';`,
    ];
    for (const line of clean) {
      expect(prosemirrorImports(line), line).toHaveLength(0);
    }
  });

  it('finds no prosemirror-* import in the interface, the element or the host applications', () => {
    const offences: string[] = [];
    let scanned = 0;
    for (const rel of SCANNED) {
      const dir = join(ROOT, rel);
      for (const file of sourceFiles(dir)) {
        scanned += 1;
        for (const f of prosemirrorImports(readFileSync(file, 'utf8'))) {
          offences.push(`${relative(ROOT, file)}:${f.line}: ${f.text}`);
        }
      }
    }
    // Non-vacuity: the scan reads the interface's own sources.
    expect(scanned).toBeGreaterThan(100);
    expect(offences).toEqual([]);
  });

  it('declares no prosemirror-* dependency in the interface, the element or the apps', () => {
    const manifests = ['packages/ui/package.json', 'packages/element/package.json'];
    for (const rel of manifests) {
      const pkg = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, unknown>;
      const deps = { ...(pkg['dependencies'] as object), ...(pkg['devDependencies'] as object) };
      expect(
        Object.keys(deps).filter((name) => name.startsWith('prosemirror-')),
        rel,
      ).toEqual([]);
    }
  });
});
