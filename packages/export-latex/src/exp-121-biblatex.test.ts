/**
 * EXP-121 on the biblatex route (Node.js only; owner decision 16): the bundle holds a `.bib` file
 * made through the `bibField` and `bibKey` emitters, every citation is a biblatex command with the
 * key of its source, and the bibliography is printed by biblatex at its block. Nothing here compiles;
 * `exp-121-biblatex.compile.test.ts` runs biber in the sandbox.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { codes, decodeStrings, doc, nid, para, run } from '../test/docs.ts';
import { bibField, bibKey, bibVerbatim } from './emit.ts';
import { texArchive } from './archive.ts';

const SMITH = {
  type: 'source_def',
  attrs: {
    id: 'smith2020',
    kind: 'book',
    title: 'Cells & Tissues 100% {x} _y_ #1 \\input{evil}',
    authors: [
      { family: 'Smith', given: 'Jane', particle: 'van' },
      { literal: 'World Health } Organization' },
    ],
    issued: '2020',
    publisher: 'Press',
    doi: '10.1000/a{b}\\c%d',
    url: 'https://example.org/a_b?x=1&y=2',
  },
};
const LEE = {
  type: 'source_def',
  attrs: {
    id: 'lee 2019!',
    kind: 'article-journal',
    title: 'Second',
    containerTitle: 'Journal',
    authors: [{ family: 'Lee', given: 'Ken' }],
    issued: '2019-05',
    volume: '3',
    issue: '2',
  },
};

const cite = (items: unknown[], mode = 'normal') => ({ type: 'citation', attrs: { items, mode } });
const bibliography = (include?: 'all' | 'cited') => ({
  type: 'bibliography',
  attrs: { id: nid('b'), ...(include ? { include } : {}) },
});

describe('EXP-121 the bibField and bibKey emitters', () => {
  it('writes no brace, no raw special character and no line end into a field value', () => {
    const v = bibField('a {b} } & % $ # _ ^ ~ \\ x\n\n y z');
    expect(v).toBe(
      'a \\textbraceleft{}b\\textbraceright{} \\textbraceright{} \\& \\% \\$ \\# \\_ \\textasciicircum{} \\textasciitilde{} \\textbackslash{} x y~z',
    );
  });

  it('leaves nothing in a field value for biber or TeX to read, whatever the string (fuzz)', () => {
    // The escapes the emitter writes; once they are taken out, no character with a meaning is left.
    const known =
      /\\(?:textbraceleft|textbraceright|textbackslash|textasciicircum|textasciitilde)\{\}|\\[&%$#_-]/g;
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
        const left = bibField(s).replace(known, '');
        expect(left).not.toMatch(/[\\{}$&#_%^~\n\r]/);
      }),
      { numRuns: 2000, seed: 20261126 },
    );
  });

  it('keeps a plain identifier as the key and numbers any other', () => {
    const used = new Set<string>();
    expect(bibKey('smith2020', 1, used)).toBe('smith2020');
    expect(bibKey('has space', 2, used)).toBe('src2');
    used.add('src2');
    expect(bibKey('also bad!', 2, used)).toBe('src3');
    used.add('smith2020');
    expect(bibKey('smith2020', 9, used)).toBe('src9');
  });

  it('percent-encodes what a verbatim field must not carry', () => {
    expect(bibVerbatim('10.1000/a{b}\\c d')).toBe('10.1000/a%7Bb%7D%5Cc%20d');
  });
});

describe('EXP-121 the bundle holds references.bib', () => {
  const body = [
    para('Intro.', {}, [
      cite([{ source: 'smith2020', locator: '5', label: 'page', prefix: 'see', suffix: 'and on' }]),
      cite([{ source: 'smith2020' }, { source: 'lee 2019!' }], 'narrative'),
      cite([{ source: 'lee 2019!' }], 'suppressAuthor'),
    ]),
    bibliography(),
  ];

  it('is listed in the bundle and the manifest, with the options of the route', async () => {
    const b = await run(doc(body, { sources: [SMITH, LEE] }));
    expect(b.ok).toBe(true);
    expect(Object.keys(b.files)).toContain('references.bib');
    expect(b.manifest.files['references.bib']).toMatch(/^[0-9a-f]{64}$/);
    expect(b.manifest.options['bibliography']).toBe('biblatex');
    expect(b.manifest.options['citationStyle']).toBe('authorYear');
    expect(b.files['main.tex']).toContain('\\addbibresource{references.bib}');
  });

  it('writes every field through the emitters, so no user string reaches biber raw', async () => {
    const bib = (await run(doc(body, { sources: [SMITH, LEE] }))).files['references.bib']!;
    expect(bib).toContain('@book{smith2020,');
    expect(bib).toContain('@article{src2,');
    expect(bib).toContain(
      'title = {Cells \\& Tissues 100\\% \\textbraceleft{}x\\textbraceright{} \\_y\\_ \\#1 \\textbackslash{}input\\textbraceleft{}evil\\textbraceright{}},',
    );
    expect(bib).toContain(
      'family={Smith}, given={Jane}, prefix={van} and {World Health \\textbraceright{} Organization}',
    );
    expect(bib).toContain('doi = {10.1000/a%7Bb%7D%5Cc%d},');
    expect(bib).toContain('url = {https://example.org/a_b?x=1&y=2},');
    expect(bib).toContain('date = {2019-05},');
    // Braces in the file are ours only: each value is one balanced pair.
    for (const l of bib.split('\n').filter((x) => x.startsWith('  '))) {
      const depth = [
        ...l.replaceAll('\\textbraceleft{}', '').replaceAll('\\textbraceright{}', ''),
      ].reduce((d, ch) => d + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
      expect(depth, l).toBe(0);
    }
  });

  it('writes each citation as a biblatex command with the keys of its sources', async () => {
    const tex = decodeStrings((await run(doc(body, { sources: [SMITH, LEE] }))).files['main.tex']!);
    expect(tex).toContain('\\parencite[see][p. 5 and on]{smith2020}');
    expect(tex).toContain('\\textcites{smith2020}{src2}');
    expect(tex).toContain('\\parencite*{src2}');
  });

  it('prints the bibliography with biblatex inside the bibliography block', async () => {
    const bibNode = bibliography('all');
    const b = await run(
      doc([para('x', {}, [cite([{ source: 'smith2020' }])]), bibNode], { sources: [SMITH, LEE] }),
    );
    const tex = b.files['main.tex']!;
    expect(tex).toContain('\\printbibliography[heading=none,env=DEbib]');
    expect(tex).toContain('\\nocite{*}');
    expect(tex).not.toContain('\\DEbibentry{');
    // The environment, the nocite and the print are lines of the bibliography block.
    const id = (bibNode.attrs as { id: string }).id;
    const n = b.map.blocks.indexOf(id);
    const mine = b.map.lines.filter((l) => l.block === n);
    const lines = tex.split('\n');
    const at = lines.findIndex((l) => l.includes('\\printbibliography'));
    expect(mine.some((l) => l.from <= at + 1 && at + 1 <= l.to)).toBe(true);
  });

  it('uses the style of the document, or the one the job asks for', async () => {
    const withStyle = await run(
      doc(body, { sources: [SMITH, LEE], settings: { citationStyle: 'numeric' } }),
    );
    expect(withStyle.files['main.tex']).toContain('style=numeric,sorting=none');
    const asked = await run(doc(body, { sources: [SMITH, LEE] }), { citationStyle: 'alphabetic' });
    expect(asked.files['main.tex']).toContain('style=alphabetic,sorting=anyt');
    expect(asked.manifest.options['citationStyle']).toBe('alphabetic');
    const unknown = await run(doc(body, { sources: [SMITH, LEE] }), { citationStyle: 'x}\\evil' });
    expect(unknown.files['main.tex']).toContain('style=authoryear');
    expect(codes(unknown)).toContain('citation_style_unknown');
  });
});

describe('EXP-121 what the biblatex route leaves out', () => {
  it('has no package, no .bib file and no biber run for a document without sources', async () => {
    const b = await run(doc([para('Plain.')]));
    expect(b.files['references.bib']).toBeUndefined();
    expect(b.files['main.tex']).not.toContain('biblatex');
    expect(b.manifest.options['bibliography']).toBeUndefined();
  });

  it('keeps the diagnostic for a citation of a missing source, with its block, and prints the mark', async () => {
    const b = await run(
      doc([para('Missing.', { id: 'pMissing0001' }, [cite([{ source: 'nobody1999' }])])], {
        sources: [SMITH],
      }),
    );
    const d = b.diagnostics.find((x) => x.code === 'citation_source_missing');
    expect(d?.blockId).toBe('pMissing0001');
    expect(decodeStrings(b.files['main.tex']!)).toContain('(?)');
  });

  it('writes the text route and no file when asked for it', async () => {
    const b = await run(
      doc([para('x', {}, [cite([{ source: 'smith2020' }])]), bibliography()], { sources: [SMITH] }),
      {
        bibliography: 'text',
      },
    );
    expect(b.files['references.bib']).toBeUndefined();
    expect(b.files['main.tex']).toContain('\\DEbibentry{');
  });
});

describe('EXP-121 the tex target holds the .bib file and says how to compile it', () => {
  it('has references.bib in the archive and the biber step in the README', async () => {
    const b = await run(
      doc([para('x', {}, [cite([{ source: 'smith2020' }])]), bibliography()], { sources: [SMITH] }),
    );
    const archive = new TextDecoder('latin1').decode(texArchive(b));
    expect(archive).toContain('references.bib');
    expect(archive).toContain('biber main');
    const plain = await run(doc([para('Plain.')]));
    expect(new TextDecoder('latin1').decode(texArchive(plain))).not.toContain('biber main');
  });
});
