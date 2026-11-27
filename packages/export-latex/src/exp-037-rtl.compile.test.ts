/**
 * EXP-037: right-to-left and complex-script text in the PDF. Node.js only. The documents compile in
 * the export worker's sandbox (Podman) with the Noto faces of the fallback chain (owner decisions
 * 228 and 241; `services/export-worker/image/noto-fonts.json`). `pdftotext -bbox` gives the
 * position of every word, so the visual order and the margins are read from the PDF; `pdftotext
 * -raw` gives the text in the order of the content stream, which is the order of the input.
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convert } from './convert.ts';
import type { FontManifest } from './bundle.ts';
import { classFiles, convertAndCompile, imageFonts, sandboxReady } from '../test/harness.ts';
import { doc, para } from '../test/docs.ts';

const ready = (await sandboxReady()).ok;

/** Marks that pdftotext puts round a right-to-left run; they are not text of the document. */
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const HE1 = '\u05e9\u05dc\u05d5\u05dd';
const HE2 = '\u05e2\u05d5\u05dc\u05dd';
const AR1 = '\u0645\u0631\u062d\u0628\u0627';
const AR2 = '\u0628\u0627\u0644\u0639\u0627\u0644\u0645';
const HI1 = '\u0915\u094d\u0937\u0924\u094d\u0930\u093f\u092f';
const HI2 = '\u0928\u092e\u0938\u094d\u0924\u0947';
const TH1 = '\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35';

interface Word {
  text: string;
  x0: number;
  x1: number;
  y: number;
}

function pdfFile(pdf: Uint8Array): string {
  const file = join(mkdtempSync(join(tmpdir(), 'exp-037-')), 'a.pdf');
  writeFileSync(file, pdf);
  return file;
}

function poppler(tool: string, args: string[], pdf: Uint8Array, out = '-'): string {
  const r = spawnSync(tool, [...args, pdfFile(pdf), out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${tool} failed: ${r.stderr}`);
  return r.stdout;
}

/** The words of a PDF with their boxes, from `pdftotext -bbox`. */
function words(pdf: Uint8Array): Word[] {
  const xml = poppler('pdftotext', ['-bbox'], pdf);
  const out: Word[] = [];
  for (const m of xml.matchAll(
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/gu,
  ))
    out.push({ x0: Number(m[1]), y: Number(m[2]), x1: Number(m[3]), text: m[4]! });
  return out;
}

/** The words of each line, left to right. */
function lines(ws: Word[]): Word[][] {
  const byY = new Map<number, Word[]>();
  for (const w of ws) {
    const key = [...byY.keys()].find((y) => Math.abs(y - w.y) < 2) ?? w.y;
    byY.set(key, [...(byY.get(key) ?? []), w]);
  }
  return [...byY.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v.sort((a, b) => a.x0 - b.x0));
}

/** The text of the PDF in content stream order, without white space and direction marks, in NFKC. */
function extracted(pdf: Uint8Array): string {
  return poppler('pdftotext', ['-raw'], pdf)
    .replace(BIDI_MARKS, '')
    .normalize('NFKC')
    .replace(/\s+/gu, '');
}

/** The number of glyphs on each line of page 1, from the SVG of pdftocairo, top line first. */
function glyphsPerLine(pdf: Uint8Array): number[] {
  const dir = mkdtempSync(join(tmpdir(), 'exp-037-'));
  const svgFile = join(dir, 'a.svg');
  const r = spawnSync('pdftocairo', ['-svg', '-f', '1', '-l', '1', pdfFile(pdf), svgFile], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`pdftocairo failed: ${r.stderr}`);
  const svg = readFileSync(svgFile, 'utf8');
  const byY = new Map<string, number>();
  for (const m of svg.matchAll(/<use xlink:href="#glyph[\d-]+" x="[\d.]+" y="([\d.]+)"\/>/gu))
    byY.set(m[1]!, (byY.get(m[1]!) ?? 0) + 1);
  return [...byY.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, n]) => n);
}

const squash = (s: string): string => s.normalize('NFKC').replace(/\s+/gu, '');

const compile = (envelope: ReturnType<typeof doc>, profile: 'preview' | 'final' = 'preview') =>
  convertAndCompile(envelope, { profile, tagging: 'off', title: 'exp-037' } as never).then((c) => {
    if (!c.compile.ok || !c.compile.pdf) throw new Error(`the compile failed:\n${c.compile.log}`);
    return { ...c, pdf: c.compile.pdf };
  });

const fill = (w: string, n: number): string => Array.from({ length: n }, () => w).join(' ');

describe('EXP-037 criterion 2: complex scripts and the fallback chain (converter)', () => {
  it('checks every script of the image against the fallback chain, and reports what no face has', async () => {
    const fonts = await imageFonts();
    expect((fonts.fallback ?? []).map((f) => f.name)).toEqual([
      'STIX Two Math',
      'Noto Sans Arabic',
      'Noto Sans Hebrew',
      'Noto Sans Devanagari',
      'Noto Sans Thai',
      'Noto Sans CJK JP',
    ]);
    const body = [
      para(`${AR1} ${AR2}`),
      para(`${HE1} ${HE2}`),
      para(`${HI1} ${HI2}`),
      para(TH1),
      para('\u6587\u5b57 \u3072\u3089\u304c\u306a \ud55c\uad6d\uc5b4'),
    ];
    const ok = await convert(doc(body), {
      fonts,
      classFiles: classFiles(),
      profile: 'final',
    } as never);
    expect(ok.diagnostics.filter((d) => d.code === 'glyph_missing')).toEqual([]);
    // The same document against a chain that has the math face alone: every script is reported.
    const bare: FontManifest = { ...fonts, fallback: [fonts.math] };
    const bad = await convert(doc(body), {
      fonts: bare,
      classFiles: classFiles(),
      profile: 'final',
    } as never);
    const missing = bad.diagnostics.filter((d) => d.code === 'glyph_missing');
    expect(missing.length).toBeGreaterThanOrEqual(5);
    expect(missing.every((d) => d.severity === 'error')).toBe(true);
  });

  it('sets a document with a script that needs shaping with the HarfBuzz renderer, each run in its own face', async () => {
    const fonts = await imageFonts();
    const one = (renderer?: 'node' | 'harf') =>
      convert(doc([para(`Hindi ${HI1} text`)]), {
        fonts,
        classFiles: classFiles(),
        profile: 'final',
        ...(renderer ? { renderer } : {}),
      } as never);
    const hindi = await one();
    expect(hindi.files['main.tex']).toContain('renderer=harf');
    expect(hindi.files['main.tex']).toMatch(/\\DEr\{0\}\{Hindi \\DEscr\{1\}\{[^}]+\} text\}/u);
    expect(hindi.files['styles.tex']).toMatch(
      /\\DEscrfont\{1\}\{[0-9a-f]{64}\.ttf\}\{Devanagari\}/u,
    );
    // The caller's own choice stands, and a document without such a script keeps the node renderer.
    expect((await one('node')).files['main.tex']).toContain('renderer=node');
    const latin = await convert(doc([para('Plain text'), para(`${HE1} ${HE2}`)]), {
      fonts,
      classFiles: classFiles(),
      profile: 'final',
    } as never);
    expect(latin.files['main.tex']).toContain('renderer=node');
    expect(latin.files['main.tex']).not.toContain('DEscr{');
  });
});

describe.skipIf(!ready)('EXP-037: right-to-left paragraphs and complex scripts in the PDF', () => {
  it('criterion 1: a right-to-left paragraph is set from the right margin, with its indents and alignment mirrored', async () => {
    const rtl = { dir: 'rtl', indentLeft: 1440, indentFirstLine: 720 };
    const c = await compile(
      doc([
        para(fill(HE1, 4), { ...rtl, align: 'start' }),
        para(fill('Alpha', 4), { indentLeft: 1440, indentFirstLine: 720, align: 'start' }),
        para(fill(HE2, 60), { dir: 'rtl', indentRight: 1440, align: 'end' }),
        para(fill('Bravo', 60), { indentRight: 1440, align: 'start' }),
      ]),
    );
    const ls = lines(words(c.pdf));
    const right = 595.3 - 72;
    // Right to left, align start: the text starts at the right margin less the left indent (the
    // start side) and the first-line indent: 72 pt and 36 pt. The same properties from the left
    // margin in a left-to-right paragraph give 72 + 72 + 36 pt.
    expect(ls[0]!.at(-1)!.x1).toBeCloseTo(right - 108, 0);
    expect(ls[1]![0]!.x0).toBeCloseTo(72 + 108, 0);
    // Right to left, align end: the end side is the left one, so the lines are flush with the left
    // margin plus the right indent (72 pt), and the right edge is ragged.
    const heEnd = ls.slice(2).filter((l) => /[\u05d0-\u05ea]/u.test(l[0]!.text));
    expect(heEnd.length).toBeGreaterThan(2);
    expect(Math.min(...heEnd.map((l) => l[0]!.x0))).toBeCloseTo(72 + 72, 0);
    expect(heEnd.slice(1, -1).every((l) => Math.abs(l[0]!.x0 - (72 + 72)) < 0.6)).toBe(true);
    // The left-to-right control starts its lines at the left margin and ends them before the right
    // indent.
    const bravo = ls.filter((l) => l[0]!.text === 'Bravo');
    expect(bravo.length).toBeGreaterThan(2);
    expect(Math.max(...bravo.map((l) => l.at(-1)!.x1))).toBeLessThanOrEqual(right - 72 + 0.5);
  }, 300_000);

  it('criterion 1: settings.dir sets every paragraph right to left, and a paragraph can set it back', async () => {
    const c = await compile(
      doc([para(fill(HE1, 4)), para(fill('Alpha', 4), { dir: 'ltr' })], {
        settings: { dir: 'rtl' },
      }),
    );
    const [he, en] = lines(words(c.pdf));
    expect(he!.at(-1)!.x1).toBeCloseTo(595.3 - 72, 0);
    expect(en![0]!.x0).toBeCloseTo(72, 0);
  }, 300_000);

  it('criterion 2: Devanagari is shaped whole by HarfBuzz, and the other scripts of the chain are set', async () => {
    const c = await compile(
      doc([
        para(`Hindi ${HI1} ${HI2} text`),
        para(`Thai ${TH1} text`),
        para(`${AR1} ${AR2}`, { dir: 'rtl' }),
        para('\u6587\u5b57 \u3072\u3089\u304c\u306a \ud55c\uad6d\uc5b4'),
      ]),
    );
    expect(String(c.bundle.files['main.tex'])).toContain('renderer=harf');
    // The faces are in the PDF.
    const fonts = spawnSync('pdffonts', [pdfFile(c.pdf)], { encoding: 'utf8' }).stdout;
    for (const face of ['NotoSansDevanagari', 'NotoSansThai', 'NotoSansArabic', 'NotoSansCJKjp'])
      expect(fonts, face).toContain(face);
    // Shaped: the Devanagari line has 23 characters (5 + 8 + 6 + 4); the conjuncts of "kshatriya"
    // and "namaste" (ksha, tra, sta) are single glyphs, so fewer glyphs than characters are set.
    // The glyphs are counted in the SVG that `pdftocairo` writes, one `<use>` per glyph, by line.
    const glyphs = glyphsPerLine(c.pdf);
    expect(glyphs[0]!).toBeLessThan(23);
    expect(glyphs[0]!).toBeGreaterThan(14);
  }, 300_000);

  it('criterion 3: mixed left-to-right and right-to-left text follows the Unicode algorithm, and the text is the input', async () => {
    const mixed = [
      `Delta ${HE1} ${HE2} 123 Echo`,
      `Delta ${AR1} ${AR2} Echo 123`,
      `${HE1} ${HE2} and 45 words`,
    ];
    const c = await compile(doc(mixed.map((m) => para(m, { dir: 'rtl' }))));
    const ls = lines(words(c.pdf));
    // Paragraph 1 is right to left. From the right: Delta, the Hebrew words (the first one is the
    // right one), then the number, then Echo. So from the left: Echo, 123, the second Hebrew word,
    // the first Hebrew word, Delta. The two left-to-right words are not next to each other as one
    // run, because the space between a number and a letter takes the direction of the paragraph.
    const order = (l: Word[]): string[] =>
      l.flatMap((w) => {
        const text = w.text.replace(BIDI_MARKS, '');
        // pdftotext gives a Hebrew word whole or a letter at a time, according to the spacing of
        // the glyphs; either way the letters, read from the left, are in visual order.
        return /[\u05d0-\u05ea]/u.test(text) ? [...text].reverse() : [text];
      });
    expect(order(ls[0]!)).toEqual([
      'Echo',
      '123',
      ...[...HE2].reverse(),
      ...[...HE1].reverse(),
      'Delta',
    ]);
    // Paragraph 3 starts with the Hebrew words, which are then at the right; then nd 45 words is
    // one left-to-right run at the left.
    expect(order(ls[2]!)).toEqual([
      'and',
      '45',
      'words',
      ...[...HE2].reverse(),
      ...[...HE1].reverse(),
    ]);
    // The text of the PDF in content stream order is the input, in the order of the input.
    expect(extracted(c.pdf)).toBe(squash(mixed.join('')));
  }, 300_000);

  it('criterion 4: the display follows the implicit algorithm; embeddings and overrides of the input have no effect', async () => {
    const plain = `Delta ${HE1} ${HE2} 123 Echo`;
    const controls = `Delta \u202e${HE1}\u202c \u202b${HE2}\u202c \u2067123\u2069 \u202dEcho\u202c`;
    const a = await compile(doc([para(plain, { dir: 'rtl' })]));
    const b = await compile(doc([para(controls, { dir: 'rtl' })]));
    expect(words(b.pdf)).toEqual(words(a.pdf));
    expect(extracted(b.pdf)).toBe(extracted(a.pdf));
    // And no direction control reaches the TeX source.
    expect(String(b.bundle.files['main.tex'])).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u);
  }, 300_000);
});
