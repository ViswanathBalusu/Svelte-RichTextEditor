/**
 * CDM-008, criterion 8: the bundle report lists the size `packages/model` contributes to the first
 * interactive editor separately (13 §9). The chunks here are synthetic; the real figures come from
 * `node scripts/build.ts`, which writes dist/lib/bundle-report.json.
 */
import { describe, expect, it } from 'vitest';
import {
  bundleReport,
  packageOf,
  packageShares,
  sizeOf,
  type ChunkInfo,
} from '../scripts/bundle-report.ts';

const root = 'E:\\repo';
const text = (seed: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${seed}${i};`).join('');

function chunk(
  fileName: string,
  moduleSizes: Record<string, number>,
  extra: Partial<ChunkInfo> = {},
): ChunkInfo {
  return {
    fileName,
    isEntry: false,
    isDynamicEntry: false,
    imports: [],
    dynamicImports: [],
    moduleIds: Object.keys(moduleSizes),
    moduleSizes,
    code: text(fileName, 400),
    ...extra,
  };
}

const entry = chunk(
  'doc-editor.js',
  { [`${root}\\packages\\element\\src\\index.ts`]: 1000 },
  { isEntry: true, imports: ['shared.js'], dynamicImports: ['editor.js'] },
);
const editor = chunk(
  'editor.js',
  {
    [`${root}\\packages\\element\\src\\editor.ts`]: 2000,
    [`${root}\\packages\\model\\src\\validate\\index.ts`]: 3000,
    [`${root}/node_modules/.pnpm/prosemirror-model@1.0.0/node_modules/prosemirror-model/dist/index.js`]: 5000,
  },
  { isDynamicEntry: true, imports: ['shared.js'] },
);
const shared = chunk('shared.js', {
  [`${root}/packages/model/src/canonical.ts`]: 1500,
  [`${root}/packages/model/src/definition/cdm1.ts`]: 500,
});
const lazy = chunk(
  'math.js',
  { [`${root}/packages/model/src/math.ts`]: 9000 },
  { isDynamicEntry: true },
);

describe('the bundle report lists each package separately (CDM-008)', () => {
  it('names the package of a module', () => {
    expect(packageOf(`${root}\\packages\\model\\src\\index.ts`)).toBe('@docedit/model');
    expect(packageOf(`${root}/packages/element/src/editor.ts`)).toBe('@docedit/element');
    expect(
      packageOf(`${root}/node_modules/.pnpm/@scope+a@1.0.0/node_modules/@scope/a/index.js`),
    ).toBe('@scope/a');
    expect(packageOf('\0virtual:thing')).toBeNull();
  });

  it('lists @docedit/model on its own for the first interactive editor', () => {
    const report = bundleReport([entry, editor, shared, lazy], null);
    expect(report.firstInteractive.files).toEqual(['doc-editor.js', 'editor.js', 'shared.js']);
    const model = report.firstInteractiveByPackage.find((p) => p.package === '@docedit/model');
    // Three model modules in the set; the one in the lazy chunk is not counted.
    expect(model?.rendered).toBe(5000);
    expect(model?.share).toBeCloseTo(5000 / 13000, 10);
    expect(report.firstInteractiveByPackage.map((p) => p.package)).toEqual([
      '@docedit/model',
      'prosemirror-model',
      '@docedit/element',
    ]);
    expect(report.how).toContain('estimate');
  });

  it('splits every chunk’s gzip size between its packages', () => {
    const set = [entry, editor, shared];
    const shares = packageShares(set);
    const gzip = set.reduce((n, c) => n + sizeOf(c.code).gzip, 0);
    const sum = shares.reduce((n, p) => n + p.gzipEstimate, 0);
    // Each figure is rounded to a byte.
    expect(Math.abs(sum - gzip)).toBeLessThanOrEqual(shares.length);
    expect(shares.reduce((n, p) => n + p.share, 0)).toBeCloseTo(1, 10);
    const model = shares.find((p) => p.package === '@docedit/model')!;
    const expected = sizeOf(editor.code).gzip * 0.3 + sizeOf(shared.code).gzip;
    expect(model.gzipEstimate).toBe(Math.round(expected));
  });

  it('reports nothing per package when the bundler gave no module sizes', () => {
    const { moduleSizes: _unused, ...bare } = entry;
    expect(packageShares([bare])).toEqual([]);
  });
});
