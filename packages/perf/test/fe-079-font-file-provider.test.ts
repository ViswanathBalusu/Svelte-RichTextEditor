/**
 * FE-079, criterion 4: a provider that measures from font files plugs into the layout engine
 * through the same `TextMeasurer` interface, the engine runs unchanged, and the S5 comparison
 * (`differences`, src/s5.ts) works on the two providers' results.
 *
 * The font-file providers are the two S10 kernels over the manifest's files (harfbuzzjs 1.6.1 and
 * the HarfRust module). The reference provider is the engine's deterministic stub. All three go
 * through one `layoutFlow` call with one set of other providers; nothing in the engine is
 * conditional on the provider. Node.js only: the module is read from `wasm/bin/`.
 */
import { loadDocument } from '@docedit/corpus';
import {
  firstFitBreaker,
  fixedWidthMeasurer,
  layoutFlow,
  toFlow,
  type BreakOpportunities,
  type CdmEnvelopeLike,
  type LayoutTree,
  type TextMeasurer,
} from '@docedit/layout';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fontManifest } from '../src/fonts.ts';
import { rustKernel } from '../src/kernel/rust-kernel.ts';
import { tsKernel } from '../src/kernel/ts-kernel.ts';
import { loadHarfbuzz } from '../src/shapers/harfbuzz.ts';
import { loadTextKernel } from '../src/shapers/harfrust.ts';
import { differences } from '../src/s5.ts';

const pkg = resolve(import.meta.dirname, '..');

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

let envelope: CdmEnvelopeLike;
let ts: TextMeasurer;
let rust: TextMeasurer;

/** The one call every provider goes through. */
function layout(measurer: TextMeasurer): LayoutTree {
  return layoutFlow(toFlow(envelope), {
    measurer,
    breaks: afterSpace,
    lineBreaker: firstFitBreaker,
  }).tree;
}

function lineWidths(tree: LayoutTree): number[] {
  const out: number[] = [];
  for (const page of tree.pages)
    for (const f of page.fragments)
      if (f.kind === 'paragraph') for (const l of f.lines) out.push(l.width);
  return out;
}

beforeAll(async () => {
  envelope = (await loadDocument('pages-20')).envelope as unknown as CdmEnvelopeLike;
  const tsk = tsKernel((await loadHarfbuzz()).shaper);
  const rk = rustKernel(
    (await loadTextKernel(new Uint8Array(readFileSync(join(pkg, 'wasm/bin/text-kernel.wasm')))))
      .module,
  );
  for (const f of fontManifest.fonts) {
    const bytes = new Uint8Array(readFileSync(join(pkg, 'fonts', f.file)));
    tsk.loadFace(f.file, bytes);
    rk.loadFace(f.file, bytes);
  }
  ts = tsk;
  rust = rk;
});

describe('a font-file provider behind the measurer interface (FE-079, criterion 4)', () => {
  it('runs the engine unchanged and records which provider measured', () => {
    for (const m of [fixedWidthMeasurer(), ts, rust]) {
      const tree = layout(m);
      expect(tree.measurer).toBe(m.id);
      expect(tree.pages.length).toBeGreaterThan(1);
      expect(lineWidths(tree).length).toBeGreaterThan(100);
    }
    expect(ts.id).not.toBe(rust.id);
  });

  it('gives the same lines with the two font-file providers, to within a hundredth of a point', () => {
    const a = lineWidths(layout(ts));
    const b = lineWidths(layout(rust));
    expect(b.length).toBe(a.length);
    const stats = differences(a, b);
    expect(stats.maxAbs).toBeLessThan(0.02);
  });

  it('lets the S5 comparison tell a font-file provider from the stub', () => {
    const real = lineWidths(layout(ts));
    const stub = lineWidths(layout(fixedWidthMeasurer()));
    const n = Math.min(real.length, stub.length);
    const stats = differences(real.slice(0, n), stub.slice(0, n));
    expect(stats.n).toBe(n);
    // The stub's widths are not the fonts' widths: a comparison must see that.
    expect(stats.overHalfPx).toBeGreaterThan(0);
  });
});
