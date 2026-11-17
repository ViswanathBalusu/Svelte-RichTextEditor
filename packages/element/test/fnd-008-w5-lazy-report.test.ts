/**
 * FND-008, criteria 2 and 3: the bundle report lists every lazy file with its size under the
 * feature it belongs to, and names the WebAssembly modules that must fail the build: one in the
 * first interactive set, or one inlined as base64 in any chunk (ADR 0016). The chunks here are
 * synthetic; `node scripts/build.ts` applies the same functions to the real build.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bundleReport,
  LAZY_FEATURES,
  lazyFeatureOf,
  sizeOf,
  wasmViolations,
  type ChunkInfo,
} from '../scripts/bundle-report.ts';

const root = 'E:/repo';
const WASM_BYTES = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x02]);
const WASM_BASE64 = Buffer.from(WASM_BYTES).toString('base64');

function chunk(fileName: string, ids: string[], extra: Partial<ChunkInfo> = {}): ChunkInfo {
  return {
    fileName,
    isEntry: false,
    isDynamicEntry: false,
    imports: [],
    dynamicImports: [],
    moduleIds: ids,
    code: `export const name = ${JSON.stringify(fileName)};`,
    ...extra,
  };
}

const entry = chunk('doc-editor.js', [`${root}/packages/element/src/index.ts`], {
  isEntry: true,
  imports: ['chunks/shared.js'],
});
const editor = chunk('chunks/editor.js', [`${root}/packages/element/src/editor.ts`], {
  isDynamicEntry: true,
  imports: ['chunks/shared.js'],
});
const shared = chunk('chunks/shared.js', [`${root}/packages/model/src/canonical.ts`]);
const lazyChunks = [
  chunk('chunks/OutlinePane-abc.js', [`${root}/packages/ui/src/components/OutlinePane.svelte`], {
    isDynamicEntry: true,
  }),
  chunk(
    'chunks/katex.min-abc.js',
    [`${root}/node_modules/.pnpm/katex@0.16.0/node_modules/katex/dist/katex.min.js`],
    { isDynamicEntry: true },
  ),
  chunk('chunks/viewer-frame-abc.js', [`${root}/packages/element/src/pdf/viewer-frame.ts`], {
    isDynamicEntry: true,
  }),
  chunk('chunks/spelling-abc.js', [`${root}/packages/ui/src/proofing/spelling.ts`], {
    isDynamicEntry: true,
  }),
  chunk('chunks/assistant-abc.js', [`${root}/packages/ui/src/assistant/panel.ts`], {
    isDynamicEntry: true,
  }),
  chunk('chunks/dep-client-abc.js', [`${root}/packages/backend-dep/src/backend.ts`], {
    isDynamicEntry: true,
  }),
  chunk('chunks/print-abc.js', [`${root}/packages/element/src/print.ts`], { isDynamicEntry: true }),
  // Not a dynamic entry and not needed first: a chunk two lazy chunks share.
  chunk('chunks/pane-shared-abc.js', [`${root}/packages/ui/src/pane-shared.ts`]),
];

const dirs: string[] = [];
function viewerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnd-008-w5-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'pdfjs', 'wasm'), { recursive: true });
  mkdirSync(join(dir, 'pdfjs', 'cmaps'), { recursive: true });
  writeFileSync(join(dir, 'pdf-viewer.html'), '<!doctype html><title>viewer</title>');
  writeFileSync(join(dir, 'assets', 'pdf-viewer-abc.js'), 'export const viewer = 1;');
  writeFileSync(join(dir, 'assets', 'pdf-viewer-abc.js.map'), '{}');
  writeFileSync(join(dir, 'assets', 'pdf.worker.min-abc.mjs'), 'export const worker = 1;');
  writeFileSync(join(dir, 'pdfjs', 'wasm', 'openjpeg.wasm'), WASM_BYTES);
  writeFileSync(join(dir, 'pdfjs', 'cmaps', '78-H.bcmap'), 'cmap');
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('the report lists every lazy file and its size (FND-008 criterion 2)', () => {
  const all = [entry, editor, shared, ...lazyChunks];
  const report = bundleReport(all, viewerDir(), [
    { fileName: 'assets/kernel-abc.wasm', source: WASM_BYTES },
    { fileName: 'chunks/print-abc.js.map', source: '{}' },
  ]);
  const featureOf = (file: string) => report.lazy.find((f) => f.file === file)?.feature;

  it('lists every chunk the first interactive editor does not need, with its size', () => {
    expect(report.firstInteractive.files).toEqual([
      'chunks/editor.js',
      'chunks/shared.js',
      'doc-editor.js',
    ]);
    for (const c of lazyChunks) {
      const listed = report.lazy.find((f) => f.file === c.fileName);
      expect(listed, c.fileName).toBeDefined();
      expect(listed?.size).toEqual(sizeOf(c.code));
    }
    for (const file of report.firstInteractive.files)
      expect(report.lazy.some((f) => f.file === file)).toBe(false);
  });

  it('names the feature of each: viewer, worker, math, panes, proofing, assistant', () => {
    expect(featureOf('viewer/assets/pdf-viewer-abc.js')).toBe('pdf viewer');
    expect(featureOf('viewer/pdf-viewer.html')).toBe('pdf viewer');
    expect(featureOf('chunks/viewer-frame-abc.js')).toBe('pdf viewer');
    expect(featureOf('viewer/assets/pdf.worker.min-abc.mjs')).toBe('pdf worker');
    expect(featureOf('chunks/katex.min-abc.js')).toBe('math editor');
    expect(featureOf('chunks/OutlinePane-abc.js')).toBe('panes');
    expect(featureOf('chunks/spelling-abc.js')).toBe('proofing');
    expect(featureOf('chunks/assistant-abc.js')).toBe('assistant');
    expect(featureOf('chunks/dep-client-abc.js')).toBe('dep client');
    expect(featureOf('chunks/print-abc.js')).toBe('other');
    expect(featureOf('chunks/pane-shared-abc.js')).toBe('other');
  });

  it('lists every WebAssembly module: an asset of the build and the ones pdf.js loads', () => {
    expect(featureOf('assets/kernel-abc.wasm')).toBe('webassembly');
    expect(featureOf('viewer/pdfjs/wasm/openjpeg.wasm')).toBe('webassembly');
    expect(report.lazy.find((f) => f.file === 'assets/kernel-abc.wasm')?.size.raw).toBe(
      WASM_BYTES.length,
    );
  });

  it('leaves out source maps and pdf.js data files', () => {
    expect(report.lazy.some((f) => f.file.endsWith('.map'))).toBe(false);
    expect(report.lazy.some((f) => f.file.includes('cmaps'))).toBe(false);
    expect(report.viewer.some((f) => f.file.includes('pdfjs/'))).toBe(false);
  });

  it('sums the files by feature, and names a feature the build does not have', () => {
    expect(report.lazyByFeature.map((f) => f.feature)).toEqual([...LAZY_FEATURES]);
    const total = report.lazyByFeature.reduce((n, f) => n + f.files, 0);
    expect(total).toBe(report.lazy.length);
    const wasm = report.lazyByFeature.find((f) => f.feature === 'webassembly')!;
    expect(wasm.files).toBe(2);
    expect(wasm.size.raw).toBe(2 * WASM_BYTES.length);
    const none = bundleReport([entry, editor, shared], null);
    expect(none.lazy).toEqual([]);
    expect(none.lazyByFeature.every((f) => f.files === 0 && f.size.gzip === 0)).toBe(true);
  });

  it('classifies by file name alone when it has no modules', () => {
    expect(lazyFeatureOf('chunks/HistoryPane-x.js')).toBe('panes');
    expect(lazyFeatureOf('assets/a.wasm?url')).toBe('webassembly');
  });
});

describe('a WebAssembly module in the first download fails the build (FND-008 criterion 3)', () => {
  const first = new Set(['doc-editor.js', 'chunks/editor.js', 'chunks/shared.js']);

  it('passes a build whose WebAssembly is a lazy file of its own', () => {
    const lazy = chunk('chunks/kernel-abc.js', [`${root}/packages/kernel/pkg/kernel_bg.wasm`], {
      isDynamicEntry: true,
      code: 'export default new URL("../assets/kernel-abc.wasm", import.meta.url);',
    });
    expect(wasmViolations([entry, editor, shared, lazy], first)).toEqual([]);
    expect(bundleReport([entry, editor, shared, lazy], null).wasmViolations).toEqual([]);
  });

  it('names a module bundled into a chunk of the first interactive set', () => {
    const bad = chunk('chunks/shared.js', [
      `${root}/packages/model/src/canonical.ts`,
      `${root}\\packages\\kernel\\pkg\\kernel_bg.wasm?init`,
    ]);
    const report = bundleReport([entry, editor, bad], null);
    expect(report.wasmViolations).toHaveLength(1);
    expect(report.wasmViolations[0]).toContain('chunks/shared.js');
    expect(report.wasmViolations[0]).toContain('packages/kernel/pkg/kernel_bg.wasm');
  });

  it('counts the DEP client’s chunks as part of the first download', () => {
    const dep = chunk(
      'chunks/dep-client-abc.js',
      [`${root}/packages/backend-dep/src/backend.ts`, `${root}/packages/kernel/pkg/k.wasm`],
      { isDynamicEntry: true },
    );
    expect(bundleReport([entry, editor, shared, dep], null).wasmViolations).toHaveLength(1);
  });

  it.each([
    ['a data URI', `const u = "data:application/wasm;base64,${WASM_BASE64}";`],
    ['a string literal', `const b = '${WASM_BASE64}'; const m = atob(b);`],
    ['a template literal', `const b = \`${WASM_BASE64}\`;`],
    ['an octet-stream data URI', `fetch("data:application/octet-stream;base64,${WASM_BASE64}")`],
  ])('names a module inlined as base64 in %s, in any chunk', (_name, code) => {
    const lazy = chunk('chunks/kernel-abc.js', [], { isDynamicEntry: true, code });
    const found = wasmViolations([entry, editor, shared, lazy], first);
    expect(found).toEqual(['chunks/kernel-abc.js holds a WebAssembly module inlined as base64']);
    const initial = chunk('doc-editor.js', entry.moduleIds as string[], { isEntry: true, code });
    expect(wasmViolations([initial, editor, shared], first)).toHaveLength(1);
  });

  it('does not take the same letters inside other base64 data for a module', () => {
    const font = chunk('chunks/katex-fonts-abc.js', [], {
      isDynamicEntry: true,
      code: `const font = "data:font/woff2;base64,d09GMgABAAAAAGFzbQEAAAAAGFzbQ";`,
    });
    expect(wasmViolations([entry, editor, shared, font], first)).toEqual([]);
  });
});
