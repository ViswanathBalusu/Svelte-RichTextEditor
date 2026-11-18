/**
 * Guard for UX-070, criteria 2 and 3 (not ticked): the assistant's code (`src/assistant`) and the
 * proofing request code (`src/proofing/request.ts`) are not imported statically by any module
 * outside them, so they cannot reach the initial chunk. Today nothing in the shell uses either, so
 * there is no chunk to show in a network trace; this test fails when a feature starts to use that
 * code through a static import instead of a dynamic `import()` in the pane table or a loader. The
 * presentation helpers of proofing (`present.ts`, `finding-actions.ts`) are small and are read by
 * the status bar and the context menu at start; they are not covered here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

const sources = readdirSync(srcDir, { recursive: true })
  .map(String)
  .filter((file) => /\.(ts|svelte)$/.test(file))
  .map((file) => ({
    file: file.split(sep).join('/'),
    text: readFileSync(join(srcDir, file), 'utf8'),
  }));

/** A static (non-type) import from a path that holds the named code. */
const staticImportOf = (target: RegExp) =>
  new RegExp(
    String.raw`^\s*(?:import|export)\s+(?!type\b)[^;'"]*?from\s+['"][^'"]*${target.source}['"]`,
    'm',
  );

const ASSISTANT = staticImportOf(/\/assistant\/[^'"]+/);
const PROOFING_REQUEST = staticImportOf(/\/proofing\/request\.ts/);

describe('assistant and proofing request code stay out of the initial chunk (UX-070, criteria 2 and 3)', () => {
  it('the patterns catch a static import and let a dynamic one and a type import through', () => {
    expect(ASSISTANT.test("import { x } from '../assistant/prompt.ts';")).toBe(true);
    expect(ASSISTANT.test("import type { X } from '../assistant/prompt.ts';")).toBe(false);
    expect(ASSISTANT.test("const m = import('../assistant/prompt.ts');")).toBe(false);
    expect(PROOFING_REQUEST.test("import { r } from './proofing/request.ts';")).toBe(true);
  });

  it('there is source for both, so the test is not empty', () => {
    expect(sources.some((s) => s.file.startsWith('assistant/'))).toBe(true);
    expect(sources.some((s) => s.file === 'proofing/request.ts')).toBe(true);
  });

  it('no module outside src/assistant imports it statically', () => {
    for (const { file, text } of sources)
      if (!file.startsWith('assistant/'))
        expect(ASSISTANT.test(text), `${file} imports assistant code statically`).toBe(false);
  });

  it('no module outside src/proofing imports the proofing request code statically', () => {
    for (const { file, text } of sources)
      if (!file.startsWith('proofing/'))
        expect(PROOFING_REQUEST.test(text), `${file} imports proofing/request.ts statically`).toBe(
          false,
        );
  });
});
