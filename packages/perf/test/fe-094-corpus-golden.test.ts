/**
 * FE-094, criterion 2 (the layout half) and criterion 3: the corpus document `pages-20` is laid out
 * with the kernel as the measurer and compared with the layout tree and the line table stored in
 * `packages/painter/golden/`. A change to the engine, the measurer, the corpus or the fonts changes
 * the stored result, and the test fails until the files are written again, in a reviewed change:
 *
 *   DOCEDIT_UPDATE_GOLDEN=1 pnpm exec vitest run --project node packages/perf/test/fe-094-corpus-golden.test.ts
 *
 * The browsers paint the same stored lines (`packages/painter/src/fe-094-painted-widths.universal.test.ts`).
 * Node.js only; it reads the kernel's build (`pnpm --filter @docedit/layout-kernel build:wasm`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_DIR, kernelBuilt, layoutCorpus, treeText } from './support/fe-094-corpus.ts';

const treeFile = resolve(GOLDEN_DIR, 'fe-094-pages-20.tree.json');
const linesFile = resolve(GOLDEN_DIR, 'fe-094-pages-20.lines.json');
const update = process.env['DOCEDIT_UPDATE_GOLDEN'] === '1';

describe.skipIf(!kernelBuilt())('the corpus layout against the stored result (FE-094)', () => {
  it('lays out pages-20 as the stored tree and line table say', async () => {
    const { tree, golden } = await layoutCorpus('pages-20');
    const treeJson = treeText(tree);
    const linesJson = JSON.stringify(golden);
    if (update) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(treeFile, treeJson);
      writeFileSync(linesFile, linesJson);
    }
    expect(existsSync(treeFile), 'no stored tree: run with DOCEDIT_UPDATE_GOLDEN=1').toBe(true);
    expect(treeJson === readFileSync(treeFile, 'utf8'), 'the layout tree changed').toBe(true);
    expect(linesJson === readFileSync(linesFile, 'utf8'), 'the line table changed').toBe(true);
  });

  it('has lines to compare: several pages, runs in more than one face, and lines the browsers can paint', async () => {
    const { tree, golden } = await layoutCorpus('pages-20');
    expect(tree.pages.length).toBeGreaterThan(1);
    expect(golden.faces.length).toBeGreaterThan(1);
    const comparable = golden.lines.filter((l) => l.comparable);
    expect(comparable.length).toBeGreaterThan(100);
    expect(comparable.some((l) => l.runs.length > 1)).toBe(true);
  });
});
