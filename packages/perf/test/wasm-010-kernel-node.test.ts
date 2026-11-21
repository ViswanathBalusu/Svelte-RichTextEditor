/**
 * WASM-010: the kernel in Node.js. The WebAssembly file of the package loads in Node.js with no
 * browser and no worker; it takes the manifest's font files by path and hash; the layout engine
 * runs over it; and the reference outputs that WASM-011 compares every browser with are recorded
 * here and locked in `packages/layout-kernel/golden/reference.json`.
 *
 * `DOCEDIT_UPDATE_GOLDEN=1` rewrites the reference (then run Prettier on it). A change to it is a
 * deliberate one: it says what the kernel now computes.
 */
import { firstFitBreaker, layoutFlow, toFlow, type CdmEnvelopeLike } from '@docedit/layout';
import { loadDocument } from '@docedit/corpus';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  faceAlias,
  kernelIsBuilt,
  loadManifestFaces,
  loadNodeKernel,
  readKernelWasm,
  sha256Hex,
} from '../../layout-kernel/node/index.ts';
import type { LayoutKernel } from '../../layout-kernel/src/index.ts';
import {
  FONT_FOLDER,
  corpusMeasurer,
  loadHarnessFaces,
  manifestFaces,
  recordReference,
  uax14,
  type KernelReference,
} from './support/kernel-reference.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');
const goldenFile = resolve(import.meta.dirname, '../../layout-kernel/golden/reference.json');

describe.skipIf(!built)('the kernel in Node.js (WASM-010)', () => {
  let kernel: LayoutKernel;
  beforeAll(async () => {
    kernel = await loadNodeKernel();
    loadHarnessFaces(kernel);
  });

  it('starts from the package’s own WebAssembly file, in Node.js 22 or later, with no browser', async () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22);
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
    const bytes = readKernelWasm();
    // The file a browser fetches: the magic number and the version of the binary format.
    expect(Array.from(bytes.subarray(0, 8))).toEqual([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const other = await loadNodeKernel();
    expect(other.abi).toBe(kernel.abi);
    // Two kernels share nothing: faces loaded into one are not in the other.
    expect(other.faces.count()).toBe(0);
    expect(kernel.faces.count()).toBe(manifestFaces.length);
  });

  it('loads the manifest’s font files by path and hash', async () => {
    const fresh = await loadNodeKernel();
    const loaded = loadManifestFaces(fresh, manifestFaces, FONT_FOLDER);
    expect(loaded.added).toBe(manifestFaces.length);
    expect(loaded.aliases).toEqual(manifestFaces.map(faceAlias));
    for (const face of manifestFaces) {
      expect(fresh.faces.has(`de-font-${face.sha256}`)).toBe(true);
      expect(sha256Hex(new Uint8Array(readFileSync(join(FONT_FOLDER, face.file))))).toBe(
        face.sha256,
      );
    }
    // The same manifest again changes nothing (the kernel finds the faces held).
    expect(loadManifestFaces(fresh, manifestFaces, FONT_FOLDER).added).toBe(0);
  });

  it('refuses a file whose bytes are not the manifest’s, and a path that does not exist', async () => {
    const fresh = await loadNodeKernel();
    const first = manifestFaces[0]!;
    const wrong = manifestFaces[1]!;
    expect(() =>
      loadManifestFaces(fresh, [{ file: first.file, sha256: wrong.sha256 }], FONT_FOLDER),
    ).toThrow(/hashes to .* the manifest says/);
    expect(() =>
      loadManifestFaces(fresh, [{ file: 'files/missing.ttf', sha256: first.sha256 }], FONT_FOLDER),
    ).toThrow(/ENOENT/);
    expect(fresh.faces.count()).toBe(0);
  });

  it('serves the layout engine: the same pages from two kernels, with the kernel as the measurer', async () => {
    const second = await loadNodeKernel();
    loadHarnessFaces(second);
    const envelope = (await loadDocument('pages-1')).envelope as unknown as CdmEnvelopeLike;
    const run = (k: LayoutKernel): ReturnType<typeof layoutFlow> =>
      layoutFlow(toFlow(envelope), {
        measurer: corpusMeasurer(k),
        breaks: uax14,
        lineBreaker: firstFitBreaker,
      });
    const a = run(kernel);
    const b = run(second);
    expect(a.tree.pages.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tree.measurer).toContain('kernel/harfrust');
  });

  describe('the reference outputs (WASM-011 compares every browser with them)', () => {
    let recorded: KernelReference;
    beforeAll(async () => {
      recorded = await recordReference(kernel);
      if (process.env['DOCEDIT_UPDATE_GOLDEN'] === '1') {
        mkdirSync(dirname(goldenFile), { recursive: true });
        writeFileSync(goldenFile, JSON.stringify(recorded, null, 2) + '\n');
      }
    }, 120_000);

    it('lock advances, the kernel’s input, its segmentation and the lines of the shared corpus in the golden file', () => {
      const locked = JSON.parse(readFileSync(goldenFile, 'utf8')) as KernelReference;
      expect(locked.abi).toBe(recorded.abi);
      expect(locked.faces).toEqual(recorded.faces);
      expect(locked.shaping.length).toBe(recorded.shaping.length);
      for (const [i, c] of recorded.shaping.entries())
        expect(c.advances, `shaping case ${i}: ${c.text}`).toEqual(locked.shaping[i]!.advances);
      for (const name of Object.keys(recorded.paragraphs)) {
        const mine = recorded.paragraphs[name]!;
        const theirs = locked.paragraphs[name]!;
        expect(theirs, name).toBeDefined();
        expect(mine.length, name).toBe(theirs.length);
        for (const [i, p] of mine.entries()) {
          expect(p.input, `${name} paragraph ${i}`).toEqual(theirs[i]!.input);
          expect(p.runChecksums, `${name} paragraph ${i} advances`).toEqual(
            theirs[i]!.runChecksums,
          );
          expect(p.lines, `${name} paragraph ${i} lines`).toEqual(theirs[i]!.lines);
          expect(p.segmentation, `${name} paragraph ${i} segmentation`).toEqual(
            theirs[i]!.segmentation,
          );
        }
      }
    });

    it('cover every face of the manifest and every paragraph of the three documents', () => {
      expect(new Set(recorded.shaping.map((c) => c.face)).size).toBe(manifestFaces.length);
      expect(Object.keys(recorded.paragraphs).sort()).toEqual([
        'form-fields',
        'pages-1',
        'pages-20',
      ]);
      const lines = Object.values(recorded.paragraphs)
        .flat()
        .reduce((n, p) => n + p.lines.length, 0);
      expect(lines).toBeGreaterThan(1000);
    });
  });
});
