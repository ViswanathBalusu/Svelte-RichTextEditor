/**
 * The Markdown target (EXP-088, Node.js only). Criteria covered here: 1 (headings, emphasis, strike,
 * lists with their literal labels, tables, links, images with alternative text, footnotes), 2 (the
 * escaping, checked by a property test and by the document's text), 3 (constructs Markdown cannot
 * express are named in the diagnostics), and 4 (only the schemes of I9 are written). The suggestion
 * modes (EXP-081 for the Markdown target) are checked too. Not covered, and not ticked: the job's
 * states and the packaging of the `assets/` folder (the job writes it), and a rendering check with a
 * Markdown renderer, which the workspace does not carry (see the story's Notes).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '@docedit/model';
import { doc, nid, para, type J } from '../test/docs.ts';
import { delMark, insMark, text } from '../test/suggestions.ts';
import { escapeMarkdown, markdownText, markdownWriter } from './markdown-writer.ts';

const ALWAYS = '\\`*_[]<~|';
const PUNCT = /[!-/:-@[-`{-~]/;

/** Reads the escapes back: a backslash before an ASCII punctuation mark stands for that mark. */
function unescapeMd(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1]!)) {
      out += s[i + 1];
      i++;
    } else out += c;
  }
  return out;
}

const styleH1: J = {
  type: 'style_def',
  attrs: { id: 'Heading1', kind: 'paragraph', name: 'Heading 1', outlineLevel: 0 },
};
const styleH3: J = {
  type: 'style_def',
  attrs: { id: 'Heading3', kind: 'paragraph', name: 'Heading 3', outlineLevel: 2 },
};
const numbering = (id: string, levels: J[]): J => ({
  type: 'numbering_def',
  attrs: { id, levels },
});
const decimal = (n: number): J[] =>
  Array.from({ length: n }, (_, i) => ({
    format: 'decimal',
    text: `${Array.from({ length: i + 1 }, (_v, k) => `%${k + 1}`).join('.')}.`,
    start: 1,
  }));
const item = (content: string, level: number, listId: string, numberingId = 'n'): J =>
  para(content, { numbering: { numberingId, level, listId } });
const md = (
  body: J[],
  parts: Parameters<typeof doc>[1] = {},
  options: Parameters<typeof markdownText>[1] = {},
  assets: Record<string, unknown> = {},
) => markdownText(doc(body, parts), options, assets);

describe('EXP-088 criterion 1: the structure of the document in Markdown', () => {
  it('writes headings by outline level, and clamps a level below six with a warning', () => {
    const deep: J = {
      type: 'style_def',
      attrs: { id: 'Deep', kind: 'paragraph', name: 'Deep', outlineLevel: 8 },
    };
    const out = md(
      [
        para('Title', { style: 'Heading1' }),
        para('Sub', { style: 'Heading3' }),
        para('Deep one', { style: 'Deep' }),
      ],
      {
        styles: [styleH1, styleH3, deep],
      },
    );
    expect(out.text).toBe('# Title\n\n### Sub\n\n###### Deep one\n');
    expect(out.diagnostics.map((d) => d.code)).toContain('heading_level_clamped');
    expect(out.ok).toBe(true);
  });

  it('writes emphasis, bold italic and strikethrough, and keeps the spaces outside the markers', () => {
    const out = md([
      para('', {}, [
        text('plain '),
        text('bold', [{ type: 'bold' }]),
        text(' and '),
        text('italic', [{ type: 'italic' }]),
        text(' and '),
        text('both', [{ type: 'bold' }, { type: 'italic' }]),
        text(' and '),
        text(' struck ', [{ type: 'strike' }]),
      ]),
    ]);
    // The spaces next to a struck run stay outside its marker, so the marker still opens a run.
    expect(out.text).toBe('plain **bold** and *italic* and ***both*** and  ~~struck~~ \n');
  });

  it('writes bullet items with their nesting, and numbered items with their literal labels', () => {
    const bullets: J = { format: 'bullet', text: '•', start: 1, bulletChar: '•' };
    const out = md(
      [
        item('Alpha', 0, 'L1', 'b'),
        item('Beta', 1, 'L1', 'b'),
        item('One', 0, 'L2', 'n'),
        item('Sub', 1, 'L2', 'n'),
      ],
      { numberings: [numbering('b', [bullets, bullets]), numbering('n', decimal(2))] },
    );
    expect(out.text).toBe('- Alpha\n\n  - Beta\n\n1\\. One\n\n1\\.1\\. Sub\n');
  });

  it('writes a pipe table, with the first row as the header and the grid width for short rows', () => {
    const cell = (c: string): J => ({
      type: 'table_cell',
      attrs: { id: nid('c') },
      content: [para(c)],
    });
    const row = (cells: string[]): J => ({
      type: 'table_row',
      attrs: { id: nid('r') },
      content: cells.map(cell),
    });
    const out = md([
      { type: 'table', attrs: { id: nid('t') }, content: [row(['a', 'b']), row(['c'])] },
    ]);
    expect(out.text).toBe('| a | b |\n| --- | --- |\n| c |  |\n');
  });

  it('writes a link with a permitted scheme and keeps its text', () => {
    const out = md([
      para('', {}, [
        text('site', [{ type: 'link', attrs: { href: 'https://example.org/a' } }]),
        text(' and '),
        text('mail', [{ type: 'link', attrs: { href: 'mailto:someone@example.org' } }]),
      ]),
    ]);
    expect(out.text).toBe('[site](https://example.org/a) and [mail](mailto:someone@example.org)\n');
  });

  it('writes a picture with its alternative text, and its caption in italics, and lists the picture as an asset', () => {
    const figure: J = {
      type: 'figure',
      attrs: { id: nid('f'), asset: 'img1', alt: 'A cat' },
      content: [
        { type: 'caption', attrs: { id: nid('k') }, content: [{ type: 'text', text: 'Cat' }] },
      ],
    };
    const out = md([figure], {}, {}, { img1: {} });
    expect(out.text).toBe('![A cat](assets/img1)\n\n*Cat*\n');
    expect(out.assets).toEqual([{ path: 'assets/img1', asset: 'img1' }]);
  });

  it('writes a footnote as a reference and a definition after the body', () => {
    const note: J = { type: 'footnote', attrs: { id: nid('fn') }, content: [para('The note.')] };
    const out = md([para('Text', {}, [note]), para('More.')]);
    expect(out.text).toBe('Text[^1]\n\nMore.\n\n[^1]: The note.\n');
  });

  it('writes nothing for an empty document and returns the same text on every run', () => {
    expect(md([]).text).toBe('');
    const body = [para('Same.', {}, []), item('Item', 0, 'L', 'n')];
    const env = doc(structuredClone(body), { numberings: [numbering('n', decimal(1))] });
    const before = JSON.stringify(env);
    const a = markdownText(env);
    const b = markdownText(env);
    expect(b.text).toBe(a.text);
    expect(JSON.stringify(env)).toBe(before);
  });
});

describe('EXP-088 criterion 2: characters are escaped so that they read back as typed', () => {
  it('escapes a backslash and a star anywhere, a hash only at the start of a line, and a full stop only after a digit', () => {
    expect(escapeMarkdown('a*b # c\\d')).toBe('a\\*b # c\\\\d');
    expect(escapeMarkdown('# Title')).toBe('\\# Title');
    expect(escapeMarkdown('1. First')).toBe('1\\. First');
    expect(escapeMarkdown('end.')).toBe('end.');
    expect(escapeMarkdown('&amp; and & alone')).toBe('\\&amp; and & alone');
  });

  it('reads back to the typed text for any printable text (fast-check, seed 20261113)', () => {
    const printable = fc.constantFrom(
      ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)),
    );
    const typed = fc
      .array(printable, { maxLength: 60 })
      .map((cs) => cs.join(''))
      .filter((s) => s === s.trim());
    fc.assert(
      fc.property(typed, (s) => {
        const escaped = escapeMarkdown(s);
        expect(unescapeMd(escaped)).toBe(s);
        // Every character that is syntax wherever it stands is escaped: removing the escape pairs
        // leaves none of them.
        const bare = escaped.replace(/\\./g, '');
        for (const ch of ALWAYS) expect(bare.includes(ch)).toBe(false);
      }),
      { seed: 20261113, numRuns: 200 },
    );
  });

  it('writes a text with significant characters so that the document reads back as typed', () => {
    const typed = 'Use *stars*, [brackets] & <tags> | pipes # hash.';
    const out = md([para(typed)]);
    expect(unescapeMd(out.text.trimEnd())).toBe(typed);
  });
});

describe('EXP-088 criterion 3: constructs Markdown cannot express are named in the diagnostics', () => {
  it('names underline, page breaks, merged cells, equations and paragraph alignment', () => {
    const merged: J = {
      type: 'table',
      attrs: { id: nid('t') },
      content: [
        {
          type: 'table_row',
          attrs: { id: nid('r') },
          content: [
            { type: 'table_cell', attrs: { id: nid('c'), rowspan: 2 }, content: [para('tall')] },
            { type: 'table_cell', attrs: { id: nid('c') }, content: [para('x')] },
          ],
        },
      ],
    };
    const out = md([
      para('', {}, [
        text('under', [{ type: 'underline' }]),
        { type: 'break', attrs: { kind: 'page' } },
        { type: 'equation', attrs: { latex: 'x^2' } },
      ]),
      para('centred', { align: 'center' }),
      merged,
    ]);
    const codes = out.diagnostics.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'underline_plain',
        'page_break_omitted',
        'equation_as_code',
        'alignment_omitted',
        'merged_cells_flattened',
      ]),
    );
    expect(out.text).toContain('`x^2`');
    expect(out.text).toContain('under');
    expect(out.text).not.toContain('\\_');
  });

  it('names the colour a text carries and writes the text plain', () => {
    const out = md([para('', {}, [text('red', [{ type: 'color', attrs: { value: '#FF0000' } }])])]);
    expect(out.text).toBe('red\n');
    expect(out.diagnostics.map((d) => d.code)).toContain('color_plain');
  });

  it('names a column span, writes the spanned columns as empty cells, and warns once per table', () => {
    const cell = (c: string, attrs: J = {}): J => ({
      type: 'table_cell',
      attrs: { id: nid('c'), ...attrs },
      content: [para(c)],
    });
    const row = (cells: J[]): J => ({ type: 'table_row', attrs: { id: nid('r') }, content: cells });
    const wide: J = {
      type: 'table',
      attrs: { id: nid('t') },
      content: [row([cell('Wide', { colspan: 2 })]), row([cell('a'), cell('b')])],
    };
    const out = md([wide], { pageSetups: [] });
    expect(out.text).toBe('| Wide |  |\n| --- | --- |\n| a | b |\n');
    const merged = out.diagnostics.filter((d) => d.code === 'merged_cells_flattened');
    expect(merged).toHaveLength(1);
    expect(merged[0]?.severity).toBe('warning');
    // A table without spans is not named.
    const plain = md(
      [{ type: 'table', attrs: { id: nid('t') }, content: [row([cell('a'), cell('b')])] }],
      { pageSetups: [] },
    );
    expect(plain.diagnostics.map((d) => d.code)).not.toContain('merged_cells_flattened');
  });

  it('names a page setup in the definitions as a warning, and writes the body text unchanged', () => {
    const setup: J = {
      type: 'page_setup',
      attrs: {
        id: 'ps1',
        width: 11906,
        height: 16838,
        orientation: 'landscape',
        columns: { count: 2 },
      },
    };
    const out = md([para('Body.')], { pageSetups: [setup] });
    expect(out.text).toBe('Body.\n');
    expect(out.ok).toBe(true);
    const found = out.diagnostics.filter((d) => d.code === 'page_setup_omitted');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    // Without a page setup in the definitions, nothing is named.
    expect(md([para('Body.')], { pageSetups: [] }).diagnostics.map((d) => d.code)).not.toContain(
      'page_setup_omitted',
    );
  });

  it('reports colours, underline, merged cells and page setups as warnings, not errors', () => {
    const tall: J = {
      type: 'table',
      attrs: { id: nid('t') },
      content: [
        {
          type: 'table_row',
          attrs: { id: nid('r') },
          content: [
            { type: 'table_cell', attrs: { id: nid('c'), rowspan: 2 }, content: [para('tall')] },
          ],
        },
      ],
    };
    const out = md([
      para('', {}, [
        text('red', [{ type: 'color', attrs: { value: '#FF0000' } }]),
        text(' under', [{ type: 'underline' }]),
      ]),
      tall,
    ]);
    const severity = new Map(out.diagnostics.map((d) => [d.code, d.severity]));
    for (const code of [
      'color_plain',
      'underline_plain',
      'merged_cells_flattened',
      'page_setup_omitted',
    ])
      expect(severity.get(code)).toBe('warning');
    expect(out.ok).toBe(true);
  });
});

describe('EXP-088 criterion 4: only the schemes of invariant I9 are written', () => {
  it('drops a javascript link to its text, with a warning, and keeps an in-document target', () => {
    const out = md([
      para('', {}, [
        text('bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
        text(' ok', []),
        text(' here', [{ type: 'link', attrs: { href: '#section_1' } }]),
      ]),
    ]);
    expect(out.text).not.toContain('javascript');
    expect(out.text).toContain('bad ok');
    expect(out.text).toContain('[ here](#section_1)');
    expect(out.diagnostics.map((d) => d.code)).toContain('link_scheme_dropped');
  });

  it('percent-encodes characters that would end a link destination', () => {
    const out = md([
      para('', {}, [text('x', [{ type: 'link', attrs: { href: 'https://example.org/a(b) c' } }])]),
    ]);
    expect(out.text).toBe('[x](https://example.org/a%28b%29%20c)\n');
  });
});

describe('EXP-088 suggestions (EXP-081 and EXP-082 for the Markdown target)', () => {
  const body = (): J[] => [
    para('', {}, [
      text('Keep '),
      text('gone', [delMark(1)]),
      text('new ', [insMark(2)]),
      text('end.'),
    ]),
  ];

  it('writes the accepted text under accept and the rejected text under reject', () => {
    expect(md(body(), {}, { suggestions: 'accept' }).text).toBe('Keep new end.\n');
    expect(md(body(), {}, { suggestions: 'reject' }).text).toBe('Keep goneend.\n');
  });

  it('marks inserted and deleted text under markup', () => {
    expect(md(body(), {}, { suggestions: 'markup' }).text).toBe(
      'Keep <del>gone</del><ins>new </ins>end.\n',
    );
  });

  it('reports pending_suggestions as an error when the option is missing, and writes the text as rejected', () => {
    const out = md(body());
    expect(out.ok).toBe(false);
    expect(out.diagnostics.find((d) => d.code === 'pending_suggestions')?.severity).toBe('error');
    expect(out.text).toBe('Keep goneend.\n');
  });

  it('does not report pending_suggestions for a document without suggestions', () => {
    const out = md([para('Plain.')]);
    expect(out.ok).toBe(true);
    expect(out.diagnostics.map((d) => d.code)).not.toContain('pending_suggestions');
  });
});

describe('EXP-088 the writer interface', () => {
  it('is the Markdown target and returns UTF-8 bytes of its text', async () => {
    const env: CdmEnvelope = doc([para('Café.')]);
    const out = await markdownWriter.write(
      { document: env, seq: null, chainHead: null, fonts: undefined as never, assets: {} },
      {},
    );
    expect(markdownWriter.target).toBe('md');
    expect(out.text).toBe('Café.\n');
    expect(new TextDecoder().decode(out.bytes)).toBe(out.text);
  });
});
