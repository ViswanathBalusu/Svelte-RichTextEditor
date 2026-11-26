/**
 * FE-094: the corpus document laid out with the kernel, and what the painter is asked to paint.
 * Node.js only (it reads the kernel's build and the harness's font files). The result is stored in
 * `packages/painter/golden/` (a layout tree and the lines with their runs and computed widths) and
 * the browsers paint it (`packages/painter/src/fe-094-painted-widths.universal.test.ts`).
 *
 * Fonts: the corpus names families; each run is given the harness's face for its family, weight and
 * style (`resolveFace`), by its editor alias (`de-font-<sha256>`, FE-061), so a painted run uses the
 * file the kernel measured. Only runs that the face has glyphs for can be compared: a line with
 * text of the CJK or Hangul role is listed and left out of the width comparison (no face of the
 * harness is chosen for it by family alone).
 */
import { loadDocument } from '@docedit/corpus';
import {
  firstFitBreaker,
  layoutFlow,
  serialiseTree,
  toFlow,
  type BreakOpportunities,
  type CdmEnvelopeLike,
  type FontKey,
  type LayoutTree,
  type TextMeasurer,
} from '@docedit/layout';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KERNEL_FILES, createKernel, type KernelGlue } from '../../../layout-kernel/src/index.ts';
import { kernelTextMeasurer } from '../../../element/src/kernel-measure.ts';
import { FlowText } from '../../../element/src/page-view/flow-text.ts';
import { fontManifest, resolveFace, roleOf } from '../../src/fonts.ts';

const pkg = resolve(import.meta.dirname, '../..');
export const KERNEL_DIST = resolve(pkg, '../layout-kernel/dist');
export const GOLDEN_DIR = resolve(pkg, '../painter/golden');

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const aliasOf = (file: string): string =>
  `de-font-${fontManifest.fonts.find((f) => f.file === file)!.sha256}`;

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

/** A face of the harness as the browser registers it. */
export interface GoldenFace {
  readonly alias: string;
  /** Path under `packages/perf/fonts/`. */
  readonly file: string;
  readonly weight: number;
  readonly style: 'normal' | 'italic';
}

/** One run of a stored line. */
export interface GoldenRun {
  readonly text: string;
  readonly alias: string;
  readonly sizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** The advance of the run in points, from the kernel. */
  readonly widthPt: number;
}

/** One line of the layout, with its runs and the width the measurer computed for them. */
export interface GoldenLine {
  readonly key: string;
  readonly block: string;
  readonly from: number;
  readonly to: number;
  /** The width of the runs, in points, from the kernel's advances. */
  readonly widthPt: number;
  /** True when every run is text of the latin role and holds no tab: the browser can be compared. */
  readonly comparable: boolean;
  readonly runs: readonly GoldenRun[];
}

export interface CorpusGolden {
  readonly document: string;
  readonly measurer: string;
  readonly faces: readonly GoldenFace[];
  readonly lines: readonly GoldenLine[];
}

export interface CorpusLayout {
  readonly tree: LayoutTree;
  readonly golden: CorpusGolden;
}

export function kernelBuilt(): boolean {
  try {
    readFileSync(resolve(KERNEL_DIST, KERNEL_FILES.wasm));
    return true;
  } catch {
    return false;
  }
}

/** Lays the document out with the kernel as the measurer, and lists every painted line. */
export async function layoutCorpus(document = 'pages-20'): Promise<CorpusLayout> {
  const glue = (await import(
    `${pathToFileURL(resolve(KERNEL_DIST, KERNEL_FILES.module)).href}?run=${Math.random()}`
  )) as KernelGlue;
  const kernel = createKernel(
    glue,
    new Uint8Array(readFileSync(resolve(KERNEL_DIST, KERNEL_FILES.wasm))),
  );
  for (const f of fontManifest.fonts) {
    const bytes = new Uint8Array(readFileSync(join(pkg, 'fonts', f.file)));
    if (sha256(bytes) !== f.sha256)
      throw new Error(`font file ${f.file} does not match the manifest`);
    kernel.faces.load('', aliasOf(f.file), f.sha256, bytes);
  }
  const inner = kernelTextMeasurer(kernel);
  const alias = (font: FontKey): FontKey => ({ ...font, family: aliasOf(resolveFace(font).file) });
  const measurer: TextMeasurer = {
    id: inner.id,
    advance: (font, text) => inner.advance(alias(font), text),
    advances: (font, text) => inner.advances(alias(font), text),
    lineMetrics: (font) => inner.lineMetrics(alias(font)),
  };
  const envelope = (await loadDocument(document)).envelope as unknown as CdmEnvelopeLike;
  const flow = toFlow(envelope);
  const tree = layoutFlow(flow, {
    measurer,
    breaks: afterSpace,
    lineBreaker: firstFitBreaker,
  }).tree;
  const text = new FlowText(flow, measurer);

  const used = new Map<string, GoldenFace>();
  const lines = new Map<string, GoldenLine>();
  const note = (blockId: string, from: number, to: number, ownText: boolean): void => {
    const key = `${blockId}:${from}:${to}`;
    const seen = lines.get(key);
    if (seen) {
      // A line the tree gives its own text (a field's value) is painted in one face, not from runs.
      if (ownText && seen.comparable) lines.set(key, { ...seen, comparable: false });
      return;
    }
    const runs = text.runs(blockId, from, to) ?? [];
    const stored: GoldenRun[] = [];
    let comparable = runs.length > 0;
    for (const run of runs) {
      const face = resolveFace({
        family: unquote(run.fontFamily),
        bold: run.bold,
        italic: run.italic,
      });
      const a = aliasOf(face.file);
      used.set(a, { alias: a, file: face.file, weight: face.weight, style: face.style });
      stored.push({
        text: run.text,
        alias: a,
        sizePt: run.fontSizePt,
        bold: run.bold,
        italic: run.italic,
        widthPt: round(
          run.text === '\t'
            ? 0
            : measurer.advance(
                {
                  family: unquote(run.fontFamily),
                  sizePt: run.fontSizePt,
                  bold: run.bold,
                  italic: run.italic,
                },
                run.text,
              ),
        ),
      });
      if (run.text.includes('\t') || roleOf(run.text) !== 'latin') comparable = false;
    }
    if (ownText) comparable = false;
    lines.set(key, {
      key,
      block: blockId,
      from,
      to,
      widthPt: round(text.width(blockId, from, to)),
      comparable,
      runs: stored,
    });
  };
  for (const page of tree.pages) {
    for (const part of [page.fragments, page.header, page.footer, page.footnotes]) {
      for (const f of part) {
        if (f.kind === 'paragraph')
          for (const l of f.lines) note(f.blockId, l.from, l.to, l.text !== undefined);
      }
    }
  }
  return {
    tree,
    golden: {
      document,
      measurer: measurer.id,
      faces: [...used.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
      lines: [...lines.values()],
    },
  };
}

/** The alias inside a `cssFamily` list of the page view: `"alias", serif`. */
function unquote(css: string): string {
  const m = /^"(.*)", serif$/.exec(css);
  return m?.[1] ?? css;
}

const round = (v: number): number => Math.round(v * 1e4) / 1e4;

export function treeText(tree: LayoutTree): string {
  return serialiseTree(tree);
}
