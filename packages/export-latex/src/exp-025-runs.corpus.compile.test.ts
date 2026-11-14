/**
 * EXP-025 criterion 3 (lane U-EXP-017-032): the text of the exported PDF equals the input, for a
 * fixed corpus of runs. Node.js only; the bundle compiles in the export worker's sandbox (Podman)
 * and `pdftotext -raw` reads the text back. The corpus is written in this file, not taken from
 * `packages/corpus`: it covers the cases EXP-025 names (dashes, quotes typed as backticks, the
 * `fi`/`fl` ligature pairs, accents, Cyrillic) and the run marks that do not change the text.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** One line per paragraph. Each string is short enough to fit one line of the page. */
const CORPUS: Array<{ text: string; marks?: J[] }> = [
  { text: 'Plain sentence with ordinary words.' },
  { text: 'Dashes -- and --- and a hyphen - in between.' },
  { text: 'Backtick quotes `like this` and straight "double" quotes.' },
  { text: 'Ligature pairs: office, flow, affix, traffic, final.' },
  { text: 'Accents: café, naïve, Ångström, Straße, señor.' },
  { text: 'Cyrillic: Привет, мир.' },
  { text: 'Punctuation: ; : ! ? ( ) [ ] / & % # $ ~ ^.' },
  { text: 'Bold run', marks: [{ type: 'bold' }] },
  { text: 'Italic run', marks: [{ type: 'italic' }] },
  { text: 'Underlined run', marks: [{ type: 'underline', attrs: { style: 'single' } }] },
];

/** Lines of the PDF text that are page numbers, which the class may print in the footer. */
const PAGE_NUMBER = /^\d+$/;

describe.skipIf(!ready)(
  'EXP-025 criterion 3: the extracted PDF text equals the input for the corpus',
  () => {
    it('returns every run of the corpus unchanged, in order, and nothing else but page numbers', async () => {
      const body = CORPUS.map((row) =>
        para('', {}, [
          { type: 'text', text: row.text, ...(row.marks ? { marks: row.marks } : {}) },
        ]),
      );
      const c = await convertAndCompile(doc(body), {
        profile: 'preview',
        title: 'exp-025-corpus',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf) {
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);
      }
      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');

      const lines = text
        .split(/\r?\n/)
        .map((l) => l.replace(/\f/g, '').trimEnd())
        .filter((l) => l !== '' && !PAGE_NUMBER.test(l));
      expect(lines).toEqual(CORPUS.map((row) => row.text));
    }, 240_000);
  },
);
