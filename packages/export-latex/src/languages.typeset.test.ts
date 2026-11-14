/**
 * Languages (Node.js only): the converter's babel setup and the language marks (EXP-027). The tests
 * read main.tex, styles and the class source of the converter's bundle. They do not compile a PDF,
 * so they do not show that babel leaves the characters unchanged or that no spacing is inserted
 * (criterion 2); that criterion stays unticked. The class source is read to show that babel is
 * loaded through its ini files with shorthands off, which the class does and a compile would confirm.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { doc, para, run, type J } from '../test/docs.ts';

const CLASS = readFileSync(new URL('../class/docedit.cls', import.meta.url), 'utf8');

/** A paragraph of text, then a run of `text` marked with the language `tag`, then plain text. */
function marked(tag: string, text: string, id?: string): J {
  return para('Plain. ', id ? { id } : {}, [
    { type: 'text', text, marks: [{ type: 'lang', attrs: { value: tag } }] },
  ]);
}

describe("EXP-027 languages go through babel's ini interface, chosen from a fixed table (criterion 1)", () => {
  it('writes babel by its ini name and registers each marked language once, with its babel name', async () => {
    const b = await run(
      doc([
        marked('de-DE', 'Hallo Welt.'),
        marked('de-DE', 'Noch einmal.'),
        marked('fr-FR', 'Bonjour.'),
      ]),
    );
    const main = b.files['main.tex']!;
    expect(main).toContain('\\DEdeflang{1}{ngerman}{de}{de-DE}');
    expect(main).toContain('\\DEdeflang{2}{french}{fr}{fr-FR}');
    expect(main.match(/\\DEdeflang\{1\}/g)).toHaveLength(1);
    expect(main).toContain('\\DElang{1}{');
    expect(main).toContain('\\DElang{2}{');
  });

  it('loads babel only through the class macro, with the document language as the main language', async () => {
    const b = await run(doc([marked('de-DE', 'Hallo.')]));
    const main = b.files['main.tex']!;
    expect(main).toContain('\\DEbabel{british}{en-GB}');
    expect(main).not.toMatch(/\\usepackage(\[[^\]]*\])?\{babel\}/);
  });

  it('loads babel in the class through its ini files with shorthands off, and never a language option', () => {
    expect(CLASS).toContain('\\RequirePackage[shorthands=off]{babel}');
    expect(CLASS).toContain('\\babelprovide[import=#2, main]{#1}');
    expect(CLASS).toContain('\\babelprovide[import=#3]{#2}');
    expect(CLASS).not.toMatch(/\\usepackage\[[^\]]*\]\{babel\}/);
  });
});

describe('EXP-027 a tag with no entry prints in the document language and is named in a warning (criterion 3)', () => {
  it('reports language_unknown with the tag, and writes no language switch for it', async () => {
    const pid = 'p-lang-unknown';
    const b = await run(doc([marked('xx-YY', 'Unknown tag text.', pid)]));
    const warnings = b.diagnostics.filter((d) => d.code === 'language_unknown');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');
    expect(warnings[0]!.message).toContain('xx-YY');
    expect(warnings[0]!.blockId).toBe(pid);
    const main = b.files['main.tex']!;
    expect(main).toContain('Unknown tag text.');
    expect(main).not.toContain('\\DElang{');
    expect(main).not.toContain('xx-YY}');
  });

  it('warns once per unknown tag, however many runs carry it', async () => {
    const b = await run(doc([marked('xx-YY', 'One.'), marked('xx-YY', 'Two.')]));
    expect(b.diagnostics.filter((d) => d.code === 'language_unknown')).toHaveLength(1);
  });
});

describe('EXP-027 hyphenation follows settings.hyphenation (criterion 4)', () => {
  it('switches hyphenation off when settings.hyphenation is false or absent', async () => {
    const off = await run(doc([para('Some words.')], { settings: { hyphenation: false } }));
    const none = await run(doc([para('Some words.')]));
    expect(off.files['main.tex']).not.toContain('\\DEhyphenation');
    expect(none.files['main.tex']).not.toContain('\\DEhyphenation');
    expect(off.files['main.tex']).not.toContain('\\DEbabel');
  });

  it('switches hyphenation on only when settings.hyphenation is true', async () => {
    const on = await run(doc([para('Some words.')], { settings: { hyphenation: true } }));
    expect(on.files['main.tex']).toContain('\\DEhyphenation');
  });

  it('keeps the class default of no hyphenation until \\DEhyphenation is written', () => {
    expect(CLASS).toContain('\\hyphenpenalty=10000');
    expect(CLASS).toContain('\\newcommand*\\DEhyphenation{\\hyphenpenalty=50 }');
  });
});
