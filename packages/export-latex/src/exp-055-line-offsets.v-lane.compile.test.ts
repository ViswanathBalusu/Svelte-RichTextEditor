/**
 * EXP-055 criterion 4 (lane V-EXP-049-064, round 2; Podman, sandbox image through the machine
 * route): `lineStarts` count UTF-16 code units, each inline atom counts as one and each bookmark as
 * zero. The paragraph mixes astral characters (two UTF-16 units each), inline equations (atoms) and
 * bookmark anchors (zero), so a count by code points, atoms as zero or anchors as one moves every
 * later line start and fails.
 *
 * The check does not assume that PDF line k is paragraph line k: `pdftotext -raw` splits an inline
 * equation with a raised superscript over two text lines, so the PDF has more lines than the
 * paragraph. Each paragraph line start is matched in order against the first word of the PDF lines
 * that follow the previous match. A line that starts with an atom is skipped (its glyphs are math).
 *
 * Skipped when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
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

/** A paragraph of 260 words: astral words (every third), an inline equation every 40 words, an anchor every 57. */
function mixedParagraph(words: number): { block: J; text: string; id: string } {
  const astral = '\u{1D400}';
  const content: J[] = [];
  let text = '';
  const addText = (s: string): void => {
    text += s;
    const last = content[content.length - 1];
    if (last && last['type'] === 'text') last['text'] = `${last['text'] as string}${s}`;
    else content.push({ type: 'text', text: s });
  };
  for (let i = 0; i < words; i++) {
    if (i > 0) addText(' ');
    if (i % 40 === 20) {
      text += ATOM;
      content.push({ type: 'equation', attrs: { latex: 'x^2+y' } });
      addText(' ');
    }
    if (i % 57 === 30)
      content.push({ type: 'anchor', attrs: { id: nid('an'), name: `exp-055-v-bm${i}` } });
    addText(i % 3 === 0 ? `${astral}k${i}` : `q${i}`);
  }
  const id = nid('p');
  return { block: { type: 'paragraph', attrs: { id }, content }, text, id };
}

/** The first word of a line with punctuation and math glyph prefixes removed, for comparison. */
const bare = (s: string): string => s.replace(/^[^A-Za-z0-9]+/, '');

describe.skipIf(!ready)(
  'EXP-055 criterion 4 (lane V-EXP-049-064): UTF-16 line offsets with atoms and anchors',
  () => {
    it('gives each line start an offset at which the PDF prints that line, in order', async () => {
      const m = mixedParagraph(260);
      const c = await convertAndCompile(doc([m.block]), options('exp-055-v-offsets') as never, {
        minPasses: 2,
      });
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-055-v-offsets', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.layoutErrors).toEqual([]);
      const block = c.layout!.blocks[m.id];
      expect(block?.lineStarts).toBeDefined();
      const starts = block!.lineStarts!;
      expect(starts[0]).toBe(0);
      for (let k = 1; k < starts.length; k++) expect(starts[k]!).toBeGreaterThan(starts[k - 1]!);
      expect(starts[starts.length - 1]!).toBeLessThan(m.text.length);

      const pdfLines = (pdfText(c.compile.pdf) ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      const firstWords = pdfLines.map((l) => bare(l.split(/\s+/)[0]!));
      let j = 0;
      let checked = 0;
      const misses: string[] = [];
      for (let k = 0; k < starts.length; k++) {
        if (m.text[starts[k]!] === ATOM) continue;
        const expected = bare(m.text.slice(starts[k]!).split(' ')[0]!);
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
    }, 600_000);
  },
);
