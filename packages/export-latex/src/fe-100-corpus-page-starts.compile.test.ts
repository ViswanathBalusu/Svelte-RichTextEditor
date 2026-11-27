/**
 * FE-100 criterion 5 (lane w1, 2026-11-27; Node.js only, sandbox, PostgreSQL not needed): the page
 * starts the page view lays out equal the PDF's, on a test corpus of generated multi-page documents.
 *
 * Each document is converted and compiled in the export worker's sandbox (Podman), which writes the
 * PDF and `layout.json` at line granularity. The file is validated (`validateLayoutJson`), its pins
 * are adopted (`adoptablePins`, nothing edited since `seq`) and the document is laid out by the
 * page view's engine (`toFlow`, `layoutFlow`) with the typeset page starts and line starts. Then, for
 * every page:
 *
 * - the page the engine lays out starts at the block and offset the PDF's page starts at, so the
 *   page count is the PDF's too;
 * - no page is marked as estimated and no pin was dropped, so the equality is not bought by
 *   dropping what disagrees;
 * - the first words that `pdftotext` prints at the top of the PDF's page are the words at the
 *   engine's page start, so the typeset start is itself the PDF's.
 *
 * The words of a paragraph are unique (`d<doc>p<k>w<i>`), which makes the last check exact. The
 * tolerance is the default of owner decision 248: one line. The measurer is the fixed-width stand-in
 * (`fixedWidthMeasurer`, as in the other layout tests), not the browser's: the editor's own breaks do
 * not matter here, since every line start of the file is adopted, but a piece wider than the column
 * would add a line, so the width per character is set under the typeset one. The page view in a
 * browser, with the real face, is a separate run (see the story's Notes).
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adoptablePins,
  fixedWidthMeasurer,
  firstFitBreaker,
  layoutFlow,
  toFlow,
  validateLayoutJson,
  type BreakOpportunities,
  type CdmEnvelopeLike,
  type ItemProviders,
  type ParagraphFragment,
} from '../../layout/src/index.ts';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const COMPILE_TIMEOUT_MS = 300_000;

/** The words of a string, without the punctuation at either end. */
function words(s: string): string[] {
  return s
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w !== '');
}

/** A small seeded generator (mulberry32), so the corpus is the same on every run. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Shape {
  readonly name: string;
  readonly seed: number;
  readonly paragraphs: number;
  readonly minWords: number;
  readonly maxWords: number;
  readonly justify: boolean;
}

/** Three documents of different shape: long paragraphs, short ones, and a justified mix. */
const CORPUS: readonly Shape[] = [
  { name: 'long', seed: 1, paragraphs: 24, minWords: 90, maxWords: 150, justify: false },
  { name: 'short', seed: 2, paragraphs: 90, minWords: 3, maxWords: 40, justify: false },
  { name: 'mixed-justified', seed: 3, paragraphs: 45, minWords: 8, maxWords: 130, justify: true },
];

function build(shape: Shape, index: number): { body: J[]; texts: Map<string, string> } {
  const next = rng(shape.seed);
  const body: J[] = [];
  const texts = new Map<string, string>();
  for (let k = 0; k < shape.paragraphs; k++) {
    const n = shape.minWords + Math.floor(next() * (shape.maxWords - shape.minWords + 1));
    const text = Array.from({ length: n }, (_v, i) => `d${index}p${k}w${i}`).join(' ');
    const p = para(text, shape.justify ? { align: 'justify' } : {});
    texts.set((p['attrs'] as J)['id'] as string, text);
    body.push(p);
  }
  return { body, texts };
}

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

/**
 * A character is 6.05 points at 11 points (em 0.55). The fullest typeset line of the corpus has 72
 * characters (435 points), which fits the 451-point column of the default A4 page with 72-point
 * margins, so a piece between two typeset line starts never needs a line of its own.
 */
const providers: ItemProviders = {
  measurer: fixedWidthMeasurer({ emWidth: 0.55 }),
  breaks: afterSpace,
  lineBreaker: firstFitBreaker,
};

/** The words `pdftotext -raw` prints on page `page`, or null when it cannot be read. */
function pageWords(pdf: Uint8Array, page: number, dir: string): string[] | null {
  const file = join(dir, `page-${page}.pdf`);
  writeFileSync(file, pdf);
  const r = spawnSync(
    'pdftotext',
    ['-enc', 'UTF-8', '-raw', '-f', String(page), '-l', String(page), file, '-'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (r.error || r.status !== 0) return null;
  return words(r.stdout);
}

describe.skipIf(!ready)(
  'FE-100 criterion 5: the page view lays out the PDF’s page starts on a test corpus',
  () => {
    CORPUS.forEach((shape, index) => {
      it(
        `the ${shape.name} document: every page starts where the PDF's page starts`,
        async () => {
          const { body, texts } = build(shape, index);
          const envelope = doc(body);
          const c = await convertAndCompile(
            envelope,
            {
              profile: 'final',
              title: `fe-100-${shape.name}`,
              instant: INSTANT,
              timeZone: 'Europe/London',
              suggestions: 'accept',
              layout: 'line',
              seq: 1,
            } as never,
            { minPasses: 2 },
          );
          if (!c.compile.ok || !c.compile.pdf)
            throw new Error(
              `the compile failed (${keep(`fe-100-${shape.name}`, c)}):\n${c.compile.log.slice(-1500)}`,
            );
          expect(c.layoutErrors).toEqual([]);

          const check = validateLayoutJson(c.layout);
          if (!check.ok)
            throw new Error(`layout.json is refused: ${check.problems.slice(0, 5).join('; ')}`);
          const typeset = check.layout;
          expect(typeset.granularity).toBe('line');
          expect(typeset.pages.length).toBeGreaterThanOrEqual(3);

          // Nothing was edited since the file's `seq`: every start is adopted.
          const pins = adoptablePins(typeset, new Set(), 'line');
          expect(pins.pages.length).toBe(typeset.pages.length);
          const flow = toFlow(envelope as unknown as CdmEnvelopeLike);
          const result = layoutFlow(flow, providers, {
            pins: { pages: pins.pages },
            lines: pins.lines,
          });

          // For the record: how many pages start elsewhere when the editor uses only its own breaks.
          const own = layoutFlow(flow, providers).tree.pages;
          const startOf = (p: (typeof own)[number] | undefined): string => {
            const f = p?.fragments.find((x): x is ParagraphFragment => x.kind === 'paragraph');
            return f ? `${f.blockId}:${f.lines[0]?.from ?? f.from}` : '-';
          };
          const ownDiffer = typeset.pages.filter(
            (t, i) => startOf(own[i]) !== `${t.starts?.blockId}:${t.starts?.offset}`,
          ).length;
          const pages = result.tree.pages;
          const rec = result.reconciliation!;
          const mismatches: string[] = [];
          if (pages.length !== typeset.pages.length)
            mismatches.push(
              `the engine lays out ${pages.length} pages, the PDF has ${typeset.pages.length}`,
            );
          if (rec.estimated.length !== 0)
            mismatches.push(`pages ${rec.estimated.join(', ')} are estimated`);
          if (rec.unmatched.length !== 0)
            mismatches.push(`${rec.unmatched.length} pins found no block or line in the layout`);
          if (rec.judgements.some((j) => j.decision === 'dropped'))
            mismatches.push('a pin was dropped');

          const dir = mkdtempSync(join(tmpdir(), 'docedit-fe-100-'));
          typeset.pages.forEach((typesetPage, i) => {
            const want = { n: typesetPage.n, starts: typesetPage.starts! };
            const page = pages[i];
            const first = page?.fragments.find(
              (f): f is ParagraphFragment => f.kind === 'paragraph',
            );
            if (!page || !first) {
              mismatches.push(`page ${want.n}: the engine's page holds no paragraph`);
              return;
            }
            const at = first.lines[0]?.from ?? first.from;
            if (first.blockId !== want.starts.blockId || at !== want.starts.offset)
              mismatches.push(
                `page ${want.n}: the engine starts at ${first.blockId}:${at}, the PDF at ${want.starts.blockId}:${want.starts.offset}`,
              );
            // The typeset start is the PDF's: the words at the top of the PDF page are the words at it.
            const text = texts.get(want.starts.blockId) ?? '';
            const expected = words(text.slice(want.starts.offset)).slice(0, 3);
            const top = pageWords(c.compile.pdf!, want.n, dir);
            if (top === null) mismatches.push(`page ${want.n}: pdftotext cannot read the page`);
            else if (!expected.some((w) => top.slice(0, 6).includes(w)))
              mismatches.push(
                `page ${want.n}: expected ${JSON.stringify(expected)} at the top of the PDF page, found ${JSON.stringify(top.slice(0, 6))}`,
              );
          });
          expect(mismatches).toEqual([]);
          console.info(
            `[FE-100 criterion 5] ${shape.name}: ${typeset.pages.length} pages, ` +
              `${pins.lines.length} line starts, ` +
              `${rec.judgements.filter((j) => j.decision === 'overflows').length} pages overflow within one line, ` +
              `0 estimated; with the editor's own breaks ${own.length} pages, ${ownDiffer} start elsewhere`,
          );
        },
        COMPILE_TIMEOUT_MS,
      );
    });
  },
);
