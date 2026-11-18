/**
 * WASM-012 criterion 1: a lazy WebAssembly module has its own compressed-size budget, set from
 * S10's measurement, and the build report (FND-008) names a module that exceeds it, so that
 * `scripts/build.ts` fails. The chunks are synthetic; the last test reads the real build of the
 * crate when `pnpm --filter @docedit/layout-kernel build:wasm` has been run.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleReport,
  MODULE_BUDGETS,
  moduleBudgetViolations,
  sizeOf,
  type ChunkInfo,
} from '../scripts/bundle-report.ts';

const root = 'E:/repo';
const chunk = (fileName: string, ids: string[], extra: Partial<ChunkInfo> = {}): ChunkInfo => ({
  fileName,
  isEntry: false,
  isDynamicEntry: false,
  imports: [],
  dynamicImports: [],
  moduleIds: ids,
  code: `export const name = ${JSON.stringify(fileName)};`,
  ...extra,
});
const entry = chunk('doc-editor.js', [`${root}/packages/element/src/index.ts`], {
  isEntry: true,
  imports: ['chunks/editor.js'],
});
const editor = chunk('chunks/editor.js', [`${root}/packages/element/src/editor.ts`], {
  isDynamicEntry: true,
});

const KERNEL = 'assets/docedit_layout_kernel_bg-abc123.wasm';
const budget = MODULE_BUDGETS.find((b) => b.name === 'layout kernel')!;

describe('the layout kernel module budget (WASM-012 criterion 1)', () => {
  it('is S10 prototype size, rounded up, and applies to the kernel file only', () => {
    expect(budget.gzipBytes).toBe(420_000);
    expect(budget.source).toContain('419,844');
    expect(budget.match.test(KERNEL)).toBe(true);
    expect(budget.match.test('viewer/pdfjs/wasm/qcms_bg.wasm')).toBe(false);
    expect(budget.match.test('assets/docedit_layout_kernel-abc.js')).toBe(false);
  });

  it('passes a module within the budget and says nothing', () => {
    const report = bundleReport([entry, editor], null, [
      { fileName: KERNEL, source: randomBytes(10_000) },
    ]);
    expect(report.moduleBudgetViolations).toEqual([]);
    expect(report.lazy.find((f) => f.file === KERNEL)?.feature).toBe('webassembly');
  });

  it('names a module over the budget, with its size and where the figure comes from', () => {
    // Random bytes do not compress, so the gzip size is about the raw size.
    const big = randomBytes(budget.gzipBytes + 5_000);
    const report = bundleReport([entry, editor], null, [{ fileName: KERNEL, source: big }]);
    expect(report.moduleBudgetViolations).toHaveLength(1);
    const [violation] = report.moduleBudgetViolations;
    expect(violation).toContain(KERNEL);
    expect(violation).toContain('420000');
    expect(violation).toContain('S10');
  });

  it('does not hold another module to the kernel budget', () => {
    const big = randomBytes(budget.gzipBytes + 5_000);
    expect(
      moduleBudgetViolations([
        { file: 'viewer/pdfjs/wasm/jbig2.wasm', feature: 'webassembly', size: sizeOf(big) },
      ]),
    ).toEqual([]);
  });

  const dist = resolve(import.meta.dirname, '../../layout-kernel/dist');
  const file = resolve(dist, 'docedit_layout_kernel_bg.wasm');
  it.skipIf(!existsSync(file))('holds for the real build of the crate', () => {
    const size = sizeOf(readFileSync(file));
    expect(size.gzip).toBeLessThanOrEqual(budget.gzipBytes);
  });
});
