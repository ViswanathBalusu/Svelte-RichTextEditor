/**
 * Line-level offsets from a compile in the export worker's sandbox (Podman; lane U-EXP-049-064,
 * round 7): EXP-055 criterion 4 and EXP-057 criterion 1.
 *
 * The block text counts UTF-16 code units, each inline atom (an inline equation here) counts as
 * one unit, and an anchor (a bookmark target) counts as zero. The paragraph below mixes all three
 * with astral characters, so an offset that counts code points, atoms as zero or anchors as one
 * fails. Each line start is checked against the first word the PDF prints on that line. PDF line k
 * is not paragraph line k: `pdftotext` splits an inline equation with a raised superscript over two
 * text lines, so each line start is matched in order against the first words of the PDF lines after
 * the previous match, as in `exp-055-line-offsets.v-lane.compile.test.ts`. A line whose first unit
 * is an atom is skipped, because its first glyphs are math.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, type J } from '../test/docs.ts';
import { convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const ATOM = '\u0001';

function options(title: string): Record<string, unknown> {
  return {
    profile: 'preview',
    title,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'line',
  };
}

type Piece = { t: 'text'; s: string } | { t: 'eq' } | { t: 'anchor'; name: string };

/** The CDM content of a paragraph and the block text it stands for (an atom is one unit). */
function build(pieces: Piece[]): { content: J[]; text: string } {
  const content: J[] = [];
  let text = '';
  for (const p of pieces) {
    if (p.t === 'text') {
      text += p.s;
      const last = content[content.length - 1];
      if (last && last['type'] === 'text') last['text'] = `${last['text'] as string}${p.s}`;
      else content.push({ type: 'text', text: p.s });
    } else if (p.t === 'eq') {
      text += ATOM;
      content.push({ type: 'equation', attrs: { latex: 'x^2+y' } });
    } else {
      content.push({ type: 'anchor', attrs: { id: nid('an'), name: p.name } });
    }
  }
  return { content, text };
}

/** A paragraph of `words` words: astral words, an inline equation every 40 words, an anchor every 57. */
function mixedPara(words: number): { block: J; text: string } {
  const astral = '\u{1D400}';
  const pieces: Piece[] = [];
  for (let i = 0; i < words; i++) {
    if (i > 0) pieces.push({ t: 'text', s: ' ' });
    if (i % 40 === 20) {
      pieces.push({ t: 'eq' });
      pieces.push({ t: 'text', s: ' ' });
    }
    if (i % 57 === 30) pieces.push({ t: 'anchor', name: `exp-055-bm${i}` });
    pieces.push({ t: 'text', s: i % 3 === 0 ? `${astral}k${i}` : `q${i}` });
  }
  const { content, text } = build(pieces);
  return { block: { type: 'paragraph', attrs: { id: nid('p') }, content }, text };
}

/** A plain paragraph of numbered words, for the block-level check of EXP-057 criterion 1. */
function plainPara(tag: string, words: number): { block: J; text: string } {
  const text = Array.from({ length: words }, (_v, i) => `${tag}${i}`).join(' ');
  return {
    block: { type: 'paragraph', attrs: { id: nid('p') }, content: [{ type: 'text', text }] },
    text,
  };
}

const bare = (s: string): string => s.replace(/^[^A-Za-z0-9]+/, '');

describe.skipIf(!ready)(
  'EXP-055 criterion 4: inline atoms count as one unit, anchors as zero, UTF-16 units throughout',
  () => {
    it('gives each line start an offset at which the PDF prints that line, with atoms and anchors in the paragraph', async () => {
      const m = mixedPara(260);
      const pid = (m.block['attrs'] as J)['id'] as string;
      const c = await convertAndCompile(doc([m.block]), options('exp-055-atoms') as never, {
        minPasses: 2,
      });
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-055-atoms', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.layoutErrors).toEqual([]);
      const block = c.layout!.blocks[pid];
      expect(block?.lineStarts).toBeDefined();
      const starts = block!.lineStarts!;
      const text = m.text;
      expect(starts[0]).toBe(0);
      for (let k = 1; k < starts.length; k++) expect(starts[k]!).toBeGreaterThan(starts[k - 1]!);
      expect(starts[starts.length - 1]!).toBeLessThan(text.length);
      const lines = (pdfText(c.compile.pdf) ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      const firstWords = lines.map((l) => bare(l.split(/\s+/)[0]!));
      let checked = 0;
      let j = 0;
      const misses: string[] = [];
      expect(firstWords.length).toBeGreaterThanOrEqual(starts.length);
      // In order: an inline equation can put its superscript on a PDF text line of its own.
      for (let k = 0; k < starts.length; k++) {
        if (text[starts[k]!] === ATOM) continue;
        const expected = bare(text.slice(starts[k]!).split(' ')[0]!);
        if (expected === '') continue;
        let found = -1;
        for (let x = j; x < firstWords.length; x++) {
          const w = firstWords[x]!;
          if (w !== '' && (expected.startsWith(w) || w.startsWith(expected))) {
            found = x;
            break;
          }
        }
        if (found < 0) {
          misses.push(`line ${k}: expected ${expected} at ${starts[k]} after PDF line ${j}`);
          continue;
        }
        j = found + 1;
        checked++;
      }
      expect(misses).toEqual([]);
      expect(checked).toBeGreaterThan(10);
    }, 300_000);
  },
);

describe.skipIf(!ready)(
  'EXP-057 criterion 1: with granularity line, every block reports lineStarts',
  () => {
    it('reports lineStarts for a mixed paragraph and for a plain paragraph, each within the block text', async () => {
      const m = mixedPara(120);
      const p = plainPara('r', 300);
      const mid = (m.block['attrs'] as J)['id'] as string;
      const pl = (p.block['attrs'] as J)['id'] as string;
      const c = await convertAndCompile(
        doc([m.block, p.block]),
        options('exp-057-lines') as never,
        { minPasses: 2 },
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-057-lines', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.layoutErrors).toEqual([]);
      const layout = c.layout!;
      expect(layout.granularity).toBe('line');
      for (const [id, text] of [
        [mid, m.text],
        [pl, p.text],
      ] as const) {
        const starts = layout.blocks[id]?.lineStarts;
        expect(starts, `block ${id} has lineStarts`).toBeDefined();
        expect(starts!.length).toBeGreaterThan(1);
        expect(starts![0]).toBe(0);
        for (let k = 1; k < starts!.length; k++)
          expect(starts![k]!).toBeGreaterThan(starts![k - 1]!);
        expect(starts![starts!.length - 1]!).toBeLessThan(text.length);
      }
    }, 300_000);
  },
);
