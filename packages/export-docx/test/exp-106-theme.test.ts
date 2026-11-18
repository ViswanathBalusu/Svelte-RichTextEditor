/**
 * EXP-106, criteria 1 and 2 for families that a file names through its theme (`w:asciiTheme`), the
 * way recent Word files name Aptos, and for families in `w:docDefaults` and styles. The model keeps
 * only `w:ascii`, so these are read from the package (src/theme-fonts.ts). The document is not
 * changed (SR-M12).
 */
import { describe, expect, it } from 'vitest';
import { importDocx, jobWarnings } from '../src/index.ts';
import { familyKey } from '../src/font-substitution.ts';
import { NS } from '../src/ooxml.ts';
import { parseXml } from '../src/xml.ts';
import { rFontsFamilies, themeFonts } from '../src/theme-fonts.ts';
import { corpusFiles, readFile } from './corpus.ts';

const enc = new TextEncoder();
const W = NS.w;
const A = NS.a;

describe('themeFonts and rFontsFamilies', () => {
  const theme = parseXml(
    enc.encode(
      `<a:theme xmlns:a="${A}"><a:themeElements><a:fontScheme name="x">` +
        `<a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont>` +
        `<a:minorFont><a:latin typeface="Aptos"/></a:minorFont>` +
        `</a:fontScheme></a:themeElements></a:theme>`,
    ),
  ).root;

  it('reads the Latin typeface of the major and minor font', () => {
    expect(themeFonts(theme)).toEqual({ major: 'Aptos Display', minor: 'Aptos' });
  });

  it('gives nothing for a theme without a font scheme or with an empty typeface', () => {
    const none = parseXml(enc.encode(`<a:theme xmlns:a="${A}"/>`)).root;
    expect(themeFonts(none)).toEqual({});
    const empty = parseXml(
      enc.encode(
        `<a:theme xmlns:a="${A}"><a:themeElements><a:fontScheme><a:minorFont><a:latin typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
      ),
    ).root;
    expect(themeFonts(empty)).toEqual({});
  });

  const part = (inner: string) =>
    parseXml(enc.encode(`<w:document xmlns:w="${W}"><w:body>${inner}</w:body></w:document>`)).root;

  it('resolves a theme reference, which wins over the literal name, as in Word', () => {
    const root = part(
      `<w:rFonts w:ascii="Calibri" w:asciiTheme="minorHAnsi"/>` +
        `<w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/>` +
        `<w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="majorHAnsi"/>`,
    );
    expect(rFontsFamilies(root, themeFonts(theme))).toEqual([
      'Aptos',
      'Cambria',
      'Cambria',
      'Aptos Display',
      'Aptos Display',
    ]);
  });

  it('gives nothing for a theme slot the theme does not fill, and ignores East Asian slots', () => {
    const root = part(`<w:rFonts w:asciiTheme="minorHAnsi" w:eastAsia="MS Mincho" w:cs="Arial"/>`);
    expect(rFontsFamilies(root, {})).toEqual([]);
  });

  it('does not run out of stack on a very deep part', () => {
    const n = 20000;
    const root = part('<w:ins>'.repeat(n) + `<w:rFonts w:ascii="Tahoma"/>` + '</w:ins>'.repeat(n));
    expect(rFontsFamilies(root)).toEqual(['Tahoma']);
  });
});

describe('families named through the theme, over the S11 corpus', () => {
  const byName = (n: string) => corpusFiles().find((f) => f.name === n)!;

  it.each([
    'docx4j/76t52-round-8-control-word365.docx',
    'docx4j/cr043-tracked.docx',
    'docx4j/mc-txbx-block-word365.docx',
    'docx4j/review-for-word-word2010.docx',
  ])(
    '%s names Aptos only through its theme, and gets the default with a reflow warning',
    async (name) => {
      const f = byName(name);
      const imported = await importDocx(readFile(f));
      const aptos = imported.fonts.find((l) => familyKey(l.from) === 'aptos');
      expect(aptos, name).toMatchObject({ source: 'default', reflow: true });
      expect(aptos?.message).toContain('the document will reflow');
      // The document keeps what the file names: no node gains the family.
      expect(JSON.stringify(imported.envelope.doc)).not.toContain('Aptos');
      // The job's warning for it, once.
      const lines = jobWarnings(imported).filter(
        (w) => 'from' in w && familyKey(w.from) === 'aptos',
      );
      expect(lines).toHaveLength(1);
    },
  );

  it('a file whose theme font is Calibri lists Calibri as Carlito, from the theme alone', async () => {
    // docx4j/create-new-bitmap.docx names Calibri only through its theme (minor font).
    const imported = await importDocx(readFile(byName('docx4j/create-new-bitmap.docx')));
    expect(imported.fonts.find((l) => familyKey(l.from) === 'calibri')).toMatchObject({
      to: 'Carlito',
      source: 'builtin',
      reflow: false,
    });
  });

  it('lists each family once, whatever the number of parts that name it', async () => {
    for (const file of corpusFiles()) {
      const imported = await importDocx(readFile(file));
      const keys = imported.fonts.map((l) => familyKey(l.from));
      expect(new Set(keys).size, file.name).toBe(keys.length);
    }
  });
});
