/**
 * WASM-009: hyphenation with TeX patterns in the kernel. These tests start the real build of the
 * crate in Node.js, load the bundled pattern files on demand, and check them against what TeX
 * itself does with the same words (`test/hyphenation-reference.json`, recorded by
 * `scripts/hyphenation-reference.ts` from lualatex and babel).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PATTERNS_DIR,
  hyphenationReader,
  kernelIsBuilt,
  loadNodeKernel,
  readHyphenationManifest,
} from '../node/index.ts';
import {
  ensureHyphenation,
  findLanguage,
  runLanguage,
  utf16Units,
  type LayoutKernel,
  type ParagraphInput,
} from './index.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

const root = resolve(import.meta.dirname, '../../..');
const fonts = resolve(import.meta.dirname, '../../perf/fonts/files');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const manifest = readHyphenationManifest();
const reference = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../test/hyphenation-reference.json'), 'utf8'),
) as { languages: Record<string, Array<{ word: string; hyphenated: string }>> };

/** A reader that counts what is read. */
function countingReader(): { read: (file: string) => Promise<Uint8Array>; files: string[] } {
  const inner = hyphenationReader();
  const files: string[] = [];
  return {
    files,
    read: (file) => {
      files.push(file);
      return inner(file);
    },
  };
}

/** The word with a hyphen at each offset the kernel gives. */
function hyphenated(kernel: LayoutKernel, tag: string, word: string): string {
  const at = kernel.hyphenation.word(tag, word);
  let out = '';
  for (let i = 0; i < word.length; i++) out += (at.includes(i) ? '-' : '') + word[i];
  return out;
}

async function withFont(): Promise<LayoutKernel> {
  const kernel = await loadNodeKernel();
  const bytes = new Uint8Array(readFileSync(resolve(fonts, 'NotoSerif-Regular.ttf')));
  kernel.faces.load('', 'serif', sha256(bytes), bytes);
  return kernel;
}

const TEXT =
  'Hyphenation algorithms separate extraordinarily internationalisation responsibilities and documentation';

/** A paragraph of one run in a language, in a column of the given width in points. */
function paragraph(language: string, columnPt: number, hyphenate: boolean): ParagraphInput {
  return {
    text: TEXT,
    runs: [{ length: TEXT.length, alias: 'serif', sizeTwips: 240, language, features: '' }],
    opportunities: [...TEXT.matchAll(/ /g)].map((m) => m.index! + 1),
    columnWidth: columnPt * 1280,
    hyphenate,
  };
}

describe.skipIf(!built)('hyphenation in the kernel (WASM-009)', () => {
  describe('off by default (02 §9.3)', () => {
    it('reads no pattern file and loads no language when settings.hyphenation is false or absent', async () => {
      const kernel = await withFont();
      const spy = countingReader();
      for (const settings of [{}, { hyphenation: false, lang: 'en-US' }]) {
        const result = await ensureHyphenation(
          kernel,
          manifest,
          settings,
          ['en-US', 'de'],
          spy.read,
        );
        expect(result).toEqual({ loaded: [], held: [], missing: [], failed: [] });
      }
      expect(spy.files).toEqual([]);
      expect(kernel.hyphenation.tags()).toEqual([]);
    });

    it('hyphenates no line, even when the patterns are loaded, unless the paragraph asks for it', async () => {
      const kernel = await withFont();
      await ensureHyphenation(
        kernel,
        manifest,
        { hyphenation: true },
        ['en-US'],
        hyphenationReader(),
      );
      expect(kernel.hyphenation.has('en-US')).toBe(true);
      const off = kernel.shaper.breakParagraph(paragraph('en-US', 120, false));
      expect(off.some((l) => l.hyphen)).toBe(false);
      const on = kernel.shaper.breakParagraph(paragraph('en-US', 120, true));
      expect(on.some((l) => l.hyphen)).toBe(true);
    });
  });

  describe('with it on', () => {
    it('loads the language of the text on demand, once, and reads only its files', async () => {
      const kernel = await withFont();
      const spy = countingReader();
      const settings = { hyphenation: true, lang: 'de-DE' };
      const first = await ensureHyphenation(kernel, manifest, settings, ['en-GB', 'de'], spy.read);
      expect(first.loaded.sort()).toEqual(['de-1996', 'en-gb']);
      expect(first.failed).toEqual([]);
      expect(spy.files.sort()).toEqual(
        ['hyph-de-1996.pat.txt', 'hyph-en-gb.hyp.txt', 'hyph-en-gb.pat.txt'].sort(),
      );
      const before = spy.files.length;
      const again = await ensureHyphenation(kernel, manifest, settings, ['en-GB'], spy.read);
      expect(again.held.sort()).toEqual(['de-1996', 'en-gb']);
      expect(spy.files.length).toBe(before);
      expect(kernel.hyphenation.tags()).toEqual(['de-1996', 'en-gb']);
      // The language of a run is its lang mark, else settings.lang.
      expect(runLanguage('fr', settings)).toBe('fr');
      expect(runLanguage(undefined, settings)).toBe('de-DE');
      expect(findLanguage(manifest, 'en')?.tag).toBe('en-us');
      expect(findLanguage(manifest, 'de-AT')?.tag).toBe('de-1996');
    });

    it('splits a word where TeX does, for every word and language of the reference', async () => {
      const kernel = await loadNodeKernel();
      await ensureHyphenation(
        kernel,
        manifest,
        { hyphenation: true },
        Object.keys(reference.languages),
        hyphenationReader(),
      );
      let compared = 0;
      for (const [tag, words] of Object.entries(reference.languages)) {
        for (const { word, hyphenated: tex } of words) {
          expect(hyphenated(kernel, tag, word), `${tag} ${word}`).toBe(tex);
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(90);
    });

    it('splits a word that begins with a capital in the same places', async () => {
      const kernel = await loadNodeKernel();
      await ensureHyphenation(
        kernel,
        manifest,
        { hyphenation: true },
        ['en-US'],
        hyphenationReader(),
      );
      expect(hyphenated(kernel, 'en-US', 'Hyphenation')).toBe('Hy-phen-ation');
      expect(hyphenated(kernel, 'en-US', 'HYPHENATION')).toBe('HY-PHEN-ATION');
    });

    it('ends a line inside a word with a hyphen, counted in the line, at least the minimum from each end', async () => {
      const kernel = await withFont();
      await ensureHyphenation(
        kernel,
        manifest,
        { hyphenation: true },
        ['en-US'],
        hyphenationReader(),
      );
      const lines = kernel.shaper.breakParagraph(paragraph('en-US', 120, true));
      const style = { alias: 'serif', sizeTwips: 240, language: 'en-US', features: '' };
      const hyphenWidth = kernel.shaper.width(style, '-');
      const hyphenLines = lines.filter((l) => l.hyphen);
      expect(hyphenLines.length).toBeGreaterThan(0);
      const { left, right } = findLanguage(manifest, 'en-US')!;
      for (const line of hyphenLines) {
        // Inside a word: letters on both sides.
        expect(TEXT[line.to - 1]).toMatch(/\p{L}/u);
        expect(TEXT[line.to]).toMatch(/\p{L}/u);
        const wordStart = TEXT.lastIndexOf(' ', line.to - 1) + 1;
        const wordEnd =
          TEXT.indexOf(' ', line.to) === -1 ? TEXT.length : TEXT.indexOf(' ', line.to);
        expect(line.to - wordStart).toBeGreaterThanOrEqual(left);
        expect(wordEnd - line.to).toBeGreaterThanOrEqual(right);
        // The width holds the text of the line and the hyphen drawn after it.
        const text = TEXT.slice(line.from, line.to).replace(/ +$/, '');
        expect(line.width).toBe(kernel.shaper.width(style, text) + hyphenWidth);
        expect(line.width).toBeLessThanOrEqual(120 * 1280);
      }
      // Every line but the last that does not end at a hyphen ends at a space.
      for (const line of lines.slice(0, -1)) if (!line.hyphen) expect(TEXT[line.to - 1]).toBe(' ');
      // The lines cover the text.
      expect(lines[0]!.from).toBe(0);
      expect(lines.at(-1)!.to).toBe(TEXT.length);
    });

    it('hyphenates a run by its own language: a run in a language without patterns stays whole', async () => {
      const kernel = await withFont();
      await ensureHyphenation(
        kernel,
        manifest,
        { hyphenation: true },
        ['en-US'],
        hyphenationReader(),
      );
      const split = TEXT.indexOf('internationalisation');
      const mixed = (first: string): ParagraphInput => ({
        ...paragraph('en-US', 70, true),
        runs: [
          { length: split, alias: 'serif', sizeTwips: 240, language: first, features: '' },
          {
            length: TEXT.length - split,
            alias: 'serif',
            sizeTwips: 240,
            language: 'en-US',
            features: '',
          },
        ],
      });
      const english = kernel.shaper.breakParagraph(mixed('en-US'));
      const partly = kernel.shaper.breakParagraph(mixed('xx'));
      // With English in both runs a word of the first run is split; with no patterns for it, never.
      expect(english.some((l) => l.hyphen && l.to < split)).toBe(true);
      expect(partly.some((l) => l.hyphen && l.to < split)).toBe(false);
      expect(partly.some((l) => l.hyphen && l.to > split)).toBe(true);
    });
  });

  describe('a language without patterns', () => {
    it('is not hyphenated, and nothing fails', async () => {
      const kernel = await withFont();
      const spy = countingReader();
      const result = await ensureHyphenation(
        kernel,
        manifest,
        { hyphenation: true },
        ['tlh', 'sk', 'hu', ''],
        spy.read,
      );
      expect(result.missing.sort()).toEqual(['hu', 'sk', 'tlh']);
      expect(result.failed).toEqual([]);
      expect(spy.files).toEqual([]);
      expect(kernel.hyphenation.word('sk', 'hyphenation')).toEqual([]);
      const lines = kernel.shaper.breakParagraph(paragraph('sk', 120, true));
      expect(lines.some((l) => l.hyphen)).toBe(false);
      expect(lines.length).toBeGreaterThan(1);
      // The same with no language at all, and with a bad tag.
      for (const language of ['', 'x', '--']) {
        const out = kernel.shaper.breakParagraph(paragraph(language, 120, true));
        expect(out.some((l) => l.hyphen)).toBe(false);
      }
    });

    it('is not an error to ask for a language the kernel was never given', async () => {
      const kernel = await loadNodeKernel();
      expect(kernel.hyphenation.has('en')).toBe(false);
      expect(kernel.hyphenation.word('en', 'hyphenation')).toEqual([]);
      expect(kernel.hyphenation.release('en')).toBe(false);
    });
  });

  describe('files and refusals', () => {
    it('a file that is not the manifest’s is refused, the language is not loaded and others still are', async () => {
      const kernel = await loadNodeKernel();
      const inner = hyphenationReader();
      const read = async (file: string): Promise<Uint8Array> => {
        const bytes = await inner(file);
        return file === 'hyph-fr.pat.txt' ? bytes.slice(0, bytes.length - 3) : bytes;
      };
      const result = await ensureHyphenation(
        kernel,
        manifest,
        { hyphenation: true },
        ['fr', 'es'],
        read,
      );
      expect(result.loaded).toEqual(['es']);
      expect(result.failed.map((f) => [f.tag, f.code])).toEqual([['fr', 'hash_mismatch']]);
      const missing = await ensureHyphenation(kernel, manifest, { hyphenation: true }, ['it'], () =>
        Promise.reject(new Error('offline')),
      );
      expect(missing.failed.map((f) => [f.tag, f.code])).toEqual([['it', 'read_failed']]);
      expect(kernel.hyphenation.tags()).toEqual(['es']);
    });

    it('the kernel refuses an empty pattern file, an empty tag and a bad minimum', async () => {
      const kernel = await loadNodeKernel();
      const code = (call: () => unknown): string => {
        try {
          call();
        } catch (error) {
          return (error as { code?: string }).code ?? String(error);
        }
        return 'no error';
      };
      expect(code(() => kernel.hyphenation.load('en', '% nothing\n', '', 2, 3))).toBe(
        'no_patterns',
      );
      expect(code(() => kernel.hyphenation.load('', 'a1b\n', '', 2, 3))).toBe('empty_tag');
      expect(code(() => kernel.hyphenation.load('en', 'a1b\n', '', 0, 3))).toBe('bad_minimum');
      expect(code(() => kernel.hyphenation.load('en', 'a1b\n', '', 2, 9))).toBe('bad_minimum');
      expect(kernel.hyphenation.tags()).toEqual([]);
    });

    it('releases a language and the aliases that stood for it', async () => {
      const kernel = await loadNodeKernel();
      await ensureHyphenation(kernel, manifest, { hyphenation: true }, ['en'], hyphenationReader());
      expect(kernel.hyphenation.has('en')).toBe(true);
      expect(kernel.hyphenation.release('en-us')).toBe(true);
      expect(kernel.hyphenation.has('en')).toBe(false);
      expect(utf16Units('ab').length).toBe(2);
    });
  });

  describe('the minimum characters and the house class (09 §3)', () => {
    it('are the ones LuaLaTeX sets under the class’s loading of babel, which is not always the file’s own', () => {
      const cls = readFileSync(resolve(root, 'packages/export-latex/class/docedit.cls'), 'utf8');
      // The class loads babel through its ini files, with shorthands off, and sets no minimum itself.
      expect(cls).toMatch(/babelprovide\[import=/);
      expect(cls).not.toMatch(/\\(left|right)hyphenmin/);
      const set = (
        reference as unknown as { minimums: Record<string, { left: number; right: number }> }
      ).minimums;
      for (const language of manifest.languages) {
        expect({ left: language.left, right: language.right }, language.tag).toEqual(
          set[language.tag],
        );
        const notice = readFileSync(resolve(PATTERNS_DIR, language.notice), 'utf8');
        const m = /typesetting:\s*%\s*left:\s*(\d+)\s*%\s*right:\s*(\d+)/.exec(
          notice.replace(/\r?\n/g, '\n'),
        );
        expect(language.fileMinimums, language.tag).toEqual({
          left: Number(m![1]),
          right: Number(m![2]),
        });
      }
      // French is the case where they differ: the file says 2 and 2, the class gets 2 and 3.
      expect(findLanguage(manifest, 'fr')).toMatchObject({
        left: 2,
        right: 3,
        fileMinimums: { left: 2, right: 2 },
      });
    });

    it('limit where a hyphen stands in the kernel: French takes three characters after the hyphen', async () => {
      const kernel = await loadNodeKernel();
      await ensureHyphenation(kernel, manifest, { hyphenation: true }, ['fr'], hyphenationReader());
      expect(hyphenated(kernel, 'fr', 'responsabilité')).toBe('res-pon-sa-bi-lité');
      const loose = kernel.hyphenation;
      const patterns = readFileSync(resolve(PATTERNS_DIR, 'hyph-fr.pat.txt'), 'utf8');
      loose.load('fr-file', patterns, '', 2, 2);
      expect(hyphenated(kernel, 'fr-file', 'responsabilité')).toBe('res-pon-sa-bi-li-té');
    });
  });

  describe('the bundled files and their licences', () => {
    const allowed = new Set(['MIT', 'BSD-3-Clause', 'LicenseRef-hyph-utf8-notice-preserved']);
    const borrowList = readFileSync(
      resolve(root, 'docs/research/2026-11-06-borrow-list.md'),
      'utf8',
    );

    it('every bundled file hashes to the manifest and carries its notice', () => {
      expect(manifest.languages.length).toBeGreaterThan(0);
      for (const language of manifest.languages) {
        for (const file of [language.patterns, language.exceptions]) {
          if (file === null) continue;
          const bytes = readFileSync(resolve(PATTERNS_DIR, file.file));
          expect(sha256(bytes), file.file).toBe(file.sha256);
          expect(bytes.length, file.file).toBe(file.bytes);
        }
        const notice = readFileSync(resolve(PATTERNS_DIR, language.notice), 'utf8');
        expect(notice, language.tag).toMatch(/copyright/i);
        expect(notice, language.tag).toMatch(/licen[cs]e/i);
      }
    });

    it('every bundled language is permissively licensed and is recorded as usable in the borrow list', () => {
      for (const language of manifest.languages) {
        expect(allowed.has(language.licence), `${language.tag}: ${language.licence}`).toBe(true);
        const row = borrowList.split('\n').find((l) => l.includes(`\`hyph-${language.tag}.tex\``));
        expect(row, `${language.tag} has no row in the borrow list`).toBeDefined();
        expect(row, language.tag).toMatch(/\|\s*Yes/);
        expect(row, language.tag).not.toMatch(/\*\*No\*\*/);
      }
    });

    it('a language whose patterns are copyleft is not bundled: Slovak and Hungarian are refused', () => {
      const tags = manifest.languages.map((l) => l.tag);
      for (const refused of ['sk', 'hu']) {
        expect(tags).not.toContain(refused);
        expect(Object.keys(manifest.refused)).toContain(refused);
        const row = borrowList.split('\n').find((l) => l.includes(`\`hyph-${refused}.tex\``));
        expect(row, refused).toMatch(/\*\*No\*\*/);
      }
    });
  });
});
