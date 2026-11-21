/**
 * The kernel's reference outputs (WASM-010; the input of WASM-011). Node.js records, from the
 * shared corpus and the harness's font files, everything the cross-browser suite compares:
 *
 * - the advances of fixed lines of text, in each face, at several sizes, with other language and
 *   feature settings (shaping);
 * - for every paragraph the layout engine breaks while it lays a corpus document out: the kernel's
 *   input (text, runs, the break opportunities it is given, the column), a checksum of the advances
 *   of each run, the lines the kernel returns (line starts and ends, positions, widths), and the
 *   kernel's own segmentation of the text (WASM-007: its break opportunities by UAX #14 and its
 *   grapheme cluster boundaries by UAX #29).
 *
 * The break opportunities that the line breaker is given are an input (UAX #14 from `linebreak`
 * 1.1.0, the library of spike S10, which recorded the lines before the kernel found opportunities
 * itself), so the recorded lines do not move with the kernel's segmentation. The kernel's own
 * opportunities are recorded beside them; they are the library's and three more over the corpus
 * (`wasm-007-kernel-segmentation.test.ts` says which and why).
 *
 * `golden/reference.json` of `@docedit/layout-kernel` holds the result. Node.js writes it when
 * `DOCEDIT_UPDATE_GOLDEN=1`; the browsers and Node.js only read it.
 */
import { loadDocument } from '@docedit/corpus';
import {
  firstFitBreaker,
  layoutFlow,
  toFlow,
  type BreakOpportunities,
  type CdmEnvelopeLike,
  type FontKey,
  type LineBreaker,
  type ParagraphInput as EngineParagraph,
  type TextMeasurer,
} from '@docedit/layout';
import LineBreakerLib from 'linebreak';
import { resolve } from 'node:path';
import {
  faceAlias,
  loadManifestFaces,
  type ManifestFace,
} from '../../../layout-kernel/node/index.ts';
import type {
  BrokenLine,
  LayoutKernel,
  ParagraphInput,
  ParagraphRun,
} from '../../../layout-kernel/src/index.ts';
import { kernelTextMeasurer } from '../../../element/src/kernel-measure.ts';
import { fontManifest, resolveFace } from '../../src/fonts.ts';

/** The folder the manifest's `file` entries are relative to. */
export const FONT_FOLDER = resolve(import.meta.dirname, '../../fonts');
/** The corpus documents of the reference (the larger ones are not in it). */
export const DOCUMENTS = ['pages-1', 'form-fields', 'pages-20'] as const;
const UNITS = 1280;

export interface ShapingCase {
  readonly face: string;
  readonly sizeTwips: number;
  readonly language: string;
  readonly features: string;
  readonly text: string;
  readonly advances: number[];
}

export interface ParagraphCase {
  readonly id: string;
  readonly input: ParagraphInput;
  /** The kernel's checksum of the advances of each run (as little-endian 32-bit integers). */
  readonly runChecksums: number[];
  readonly lines: BrokenLine[];
  /** What the kernel's segmentation (WASM-007) gives for the paragraph's text. */
  readonly segmentation: {
    /** The break opportunities before the end of the text (UAX #14), UTF-16 offsets. */
    readonly breaks: number[];
    /** The extended grapheme cluster boundaries (UAX #29), UTF-16 offsets. */
    readonly graphemes: number[];
  };
}

export interface KernelReference {
  readonly $comment: string;
  readonly abi: number;
  /** Faces by path (from `packages/perf/fonts`) and hash. */
  readonly faces: ManifestFace[];
  readonly shaping: ShapingCase[];
  readonly paragraphs: Record<string, ParagraphCase[]>;
}

/** The faces of the harness's manifest, as the kernel loads them. */
export const manifestFaces: ManifestFace[] = fontManifest.fonts.map((f) => ({
  file: f.file,
  sha256: f.sha256,
}));

/** Loads every face of the harness's manifest into a kernel, by path and hash. */
export const loadHarnessFaces = (kernel: LayoutKernel): void => {
  loadManifestFaces(kernel, manifestFaces, FONT_FOLDER);
};

/** UAX #14 break opportunities, as the layout engine's provider interface wants them. */
export const uax14: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    const breaker = new LineBreakerLib(text);
    for (let b = breaker.nextBreak(); b; b = breaker.nextBreak())
      if (b.position < text.length) out.push(b.position);
    return out;
  },
};

const units = (points: number): number => Math.round(points * UNITS) + 0;
const twips = (sizePt: number): number => Math.max(1, Math.round(sizePt * 20));
export const aliasFor = (font: FontKey): string => faceAlias(resolveFace(font));

/** The engine's measurer over a kernel, with the corpus's families mapped to the manifest's faces. */
export function corpusMeasurer(kernel: LayoutKernel): TextMeasurer {
  const inner = kernelTextMeasurer(kernel);
  const map = (font: FontKey): FontKey => ({ ...font, family: aliasFor(font) });
  return {
    id: inner.id,
    advance: (font, text) => inner.advance(map(font), text),
    advances: (font, text) => inner.advances(map(font), text),
    lineMetrics: (font) => inner.lineMetrics(map(font)),
  };
}

/** The paragraphs the engine breaks while it lays the document out. */
export async function recordParagraphs(
  name: string,
  measurer: TextMeasurer,
): Promise<EngineParagraph[]> {
  const envelope = (await loadDocument(name)).envelope as unknown as CdmEnvelopeLike;
  const inputs: EngineParagraph[] = [];
  const recording: LineBreaker = {
    id: 'recording',
    breakParagraph(input, m, breaks) {
      inputs.push(input);
      return firstFitBreaker.breakParagraph(input, m, breaks);
    },
  };
  layoutFlow(toFlow(envelope), { measurer, breaks: uax14, lineBreaker: recording });
  return inputs;
}

/** The kernel's input for an engine paragraph, in advance units. */
export function toKernelInput(input: EngineParagraph): ParagraphInput {
  const text = input.runs.map((r) => r.text).join('');
  const runs: ParagraphRun[] = input.runs
    .filter((r) => r.text.length > 0)
    .map((r) => ({
      length: r.text.length,
      alias: aliasFor(r.font),
      sizeTwips: twips(r.font.sizePt),
      language: '',
      features: '',
      ...(r.width !== undefined ? { boxWidth: units(r.width) } : {}),
    }));
  return {
    text,
    runs,
    opportunities: uax14.opportunities(text, input.language),
    columnWidth: units(input.columnWidth),
    indentLeft: units(input.indentLeft ?? 0),
    indentRight: units(input.indentRight ?? 0),
    indentFirstLine: units(input.indentFirstLine ?? 0),
    defaultTabStop: units(input.defaultTabStop ?? 0),
    tabStops: (input.tabStops ?? []).map((s) =>
      typeof s === 'number'
        ? { position: units(s), align: 'left' as const }
        : { position: units(s.position), align: s.align },
    ),
  };
}

/** The checksum of each run's advances, as the kernel's own FNV-1a over their bytes. */
export function runChecksums(kernel: LayoutKernel, input: ParagraphInput): number[] {
  const out: number[] = [];
  let at = 0;
  for (const run of input.runs) {
    const text = input.text.slice(at, at + run.length);
    at += run.length;
    if (run.boxWidth !== undefined) {
      out.push(-1);
      continue;
    }
    const advances = kernel.shaper.advances(run, text);
    out.push(
      kernel.checksum(new Uint8Array(advances.buffer, advances.byteOffset, advances.byteLength)),
    );
  }
  return out;
}

const LATIN_LINES = [
  'The quick brown fox jumps over the lazy dog.',
  'Typography is the craft of arranging type to make written language legible.',
  'Pack my box with five dozen liquor jugs, and then 0123456789 more.',
  'AVATAR Wave Yes To Ty We Te Yo',
  'Zażółć gęślą jaźń — Příliš žluťoučký kůň úpěl ďábelské ódy',
  'Съешь ещё этих мягких французских булок, да выпей чаю.',
  'office affiliate fluffy difficult — ligatures: fi fl ffi ffl',
  'Ångström naïve café – 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 😀 é ä',
];
const CJK_LINES = [
  '日本語の文章です。吾輩は猫である。',
  '漢字とかなの混ざった行、「括弧」と句読点。',
];
const HANGUL_LINES = ['한글 문장입니다. 대한민국의 수도는 서울입니다.'];
const SIZES_TWIPS = [200, 240, 280, 11 * 20 + 10];
const SETTINGS: Array<{ language: string; features: string }> = [
  { language: '', features: '' },
  { language: 'pl', features: 'kern=0,liga=0' },
];

/** The shaping cases: each face with lines of its own script, at several sizes and settings. */
export function shapingCases(kernel: LayoutKernel): ShapingCase[] {
  const cases: ShapingCase[] = [];
  for (const face of fontManifest.fonts) {
    const lines =
      face.role === 'cjk' ? CJK_LINES : face.role === 'hangul' ? HANGUL_LINES : LATIN_LINES;
    const alias = faceAlias(face);
    for (const sizeTwips of SIZES_TWIPS)
      for (const { language, features } of SETTINGS)
        for (const text of lines)
          cases.push({
            face: face.sha256,
            sizeTwips,
            language,
            features,
            text,
            advances: Array.from(
              kernel.shaper.advances({ alias, sizeTwips, language, features }, text),
            ),
          });
  }
  return cases;
}

/** Records the whole reference from a kernel that holds the harness's faces. */
export async function recordReference(kernel: LayoutKernel): Promise<KernelReference> {
  const measurer = corpusMeasurer(kernel);
  const paragraphs: Record<string, ParagraphCase[]> = {};
  for (const name of DOCUMENTS) {
    paragraphs[name] = (await recordParagraphs(name, measurer)).map((engine, i) => {
      const input = toKernelInput(engine);
      return {
        id: `${engine.blockId ?? i}`,
        input,
        runChecksums: runChecksums(kernel, input),
        lines: kernel.shaper.breakParagraph(input),
        segmentation: {
          breaks: kernel.segmenter.opportunities(input.text),
          graphemes: kernel.segmenter.graphemeBoundaries(input.text),
        },
      };
    });
  }
  return {
    $comment:
      'Reference outputs of the layout kernel, recorded in Node.js (WASM-010): advances of fixed lines, and for every paragraph of the shared corpus the kernel input, the checksum of each run’s advances and the lines. The line breaker takes its break opportunities as an input (UAX #14 from linebreak 1.1.0); the kernel’s own segmentation of each paragraph’s text (WASM-007: break opportunities, UAX #14, and grapheme cluster boundaries, UAX #29) is recorded beside the lines. Rewritten by DOCEDIT_UPDATE_GOLDEN=1 on purpose only; WASM-011 compares every browser with it.',
    abi: kernel.abi,
    faces: manifestFaces,
    shaping: shapingCases(kernel),
    paragraphs,
  };
}
