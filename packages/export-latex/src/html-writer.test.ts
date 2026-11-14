/**
 * The HTML target (EXP-087, Node.js only). Criteria covered here: 1 (headings, paragraphs, lists
 * with their literal labels, tables with spans, pictures with alternative text, links, footnotes),
 * 2 (text and attribute values are escaped; no script or event handler is written; only the schemes
 * of I9 are linked; checked by a property test), 4 (constructs HTML cannot express are named), 5 (the
 * visible text equals the document's text, read back from the output), and the suggestion modes of
 * EXP-081 and EXP-082. Not covered here, and so not ticked: the cascade of 03 §6 (criterion 3), the
 * job's packaging of the `assets/` folder (criterion 6), and the job's states. Nothing here renders
 * the page in a browser (see the story's Notes).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '@docedit/model';
import { doc, nid, para, type J } from '../test/docs.ts';
import { delMark, insMark, text } from '../test/suggestions.ts';
import { escapeHtml, htmlText, htmlWriter } from './html-writer.ts';

const styleH1: J = {
  type: 'style_def',
  attrs: { id: 'Heading1', kind: 'paragraph', name: 'Heading 1', outlineLevel: 0 },
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
const out = (
  body: J[],
  parts: Parameters<typeof doc>[1] = {},
  options: Parameters<typeof htmlText>[1] = {},
  assets: Record<string, unknown> = {},
) => htmlText(doc(body, parts), options, assets);

const DECODE: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** The text a reader sees: the body without the head, tags as spaces, entities decoded, spaces folded. */
function visibleText(html: string): string {
  const body = html.slice(html.indexOf('<body>'));
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => DECODE[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

describe('EXP-087 criterion 1: the structure of the document in HTML', () => {
  it('writes a complete document with its language, title and a main element', () => {
    const r = htmlText(doc([para('Hi.')]), { title: 'Report' });
    expect(r.text.startsWith('<!doctype html>\n<html lang="en-GB">')).toBe(true);
    expect(r.text).toContain('<title>Report</title>');
    expect(r.text).toContain('<main>\n<p>Hi.</p>\n</main>');
    expect(r.ok).toBe(true);
  });

  it('writes headings by outline level and paragraphs with their alignment class', () => {
    const r = out([para('Title', { style: 'Heading1' }), para('Centred.', { align: 'center' })], {
      styles: [styleH1],
    });
    expect(r.text).toContain('<h1>Title</h1>');
    expect(r.text).toContain('<p class="de-align-center">Centred.</p>');
  });

  it('writes bullet items in nested lists, and numbered items with their literal labels in an ol', () => {
    const bullets: J = { format: 'bullet', text: '•', start: 1, bulletChar: '•' };
    const r = out(
      [
        item('Alpha', 0, 'B', 'b'),
        item('Beta', 1, 'B', 'b'),
        item('Gamma', 0, 'B', 'b'),
        item('One', 0, 'N', 'n'),
        item('Sub', 1, 'N', 'n'),
      ],
      { numberings: [numbering('b', [bullets, bullets]), numbering('n', decimal(2))] },
    );
    // Blocks are joined with newlines; the markup between list elements is compared without them.
    const flat = r.text.replace(/\n/g, '');
    expect(flat).toContain(
      '<ul class="de-list"><li><span class="de-label">•</span> Alpha<ul class="de-list"><li><span class="de-label">•</span> Beta</li></ul></li><li><span class="de-label">•</span> Gamma</li></ul>',
    );
    expect(flat).toContain(
      '<ol class="de-list"><li><span class="de-label">1.</span> One<ol class="de-list"><li><span class="de-label">1.1.</span> Sub</li></ol></li></ol>',
    );
  });

  it('writes a table with its header row, and its column and row spans as attributes', () => {
    const cell = (c: string, attrs: J = {}): J => ({
      type: 'table_cell',
      attrs: { id: nid('c'), ...attrs },
      content: [para(c)],
    });
    const row = (cells: J[]): J => ({ type: 'table_row', attrs: { id: nid('r') }, content: cells });
    const r = out([
      {
        type: 'table',
        attrs: { id: nid('t') },
        content: [
          row([cell('Wide', { colspan: 2 })]),
          row([cell('a'), cell('b')]),
          row([cell('tall', { rowspan: 2 }), cell('c')]),
        ],
      },
    ]);
    expect(r.text).toContain('<thead><tr><th colspan="2"><p>Wide</p></th></tr></thead>');
    expect(r.text).toContain('<tr><td><p>a</p></td><td><p>b</p></td></tr>');
    expect(r.text).toContain('<td rowspan="2"><p>tall</p></td>');
  });

  it('writes a picture with its alternative text and caption, a link and footnotes', () => {
    const figure: J = {
      type: 'figure',
      attrs: { id: nid('f'), asset: 'img1', alt: 'A cat' },
      content: [
        { type: 'caption', attrs: { id: nid('k') }, content: [{ type: 'text', text: 'Cat' }] },
      ],
    };
    const note: J = { type: 'footnote', attrs: { id: nid('fn') }, content: [para('The note.')] };
    const r = out(
      [
        figure,
        para('', {}, [
          text('site', [{ type: 'link', attrs: { href: 'https://example.org/a' } }]),
          note,
        ]),
      ],
      {},
      {},
      { img1: {} },
    );
    expect(r.text).toContain(
      '<figure><img src="assets/img1" alt="A cat"><figcaption>Cat</figcaption></figure>',
    );
    expect(r.text).toContain(
      '<a href="https://example.org/a">site</a><sup><a id="fnref1" href="#fn1">1</a></sup>',
    );
    expect(r.text).toContain(
      '<section class="de-footnotes"><ol><li id="fn1">The note. <a href="#fnref1">&#8617;</a></li></ol></section>',
    );
    expect(r.assets).toEqual([{ path: 'assets/img1', asset: 'img1' }]);
  });
});

describe('EXP-087 criterion 2: escaping, no script, and the schemes of I9', () => {
  it('escapes markup in text and in attribute values', () => {
    const r = out([para('<script>alert(1)</script> & "quoted"')]);
    expect(r.text).toContain(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;</p>',
    );
    expect(r.text).not.toContain('<script>alert');
  });

  it('writes no script element and no event handler attribute, whatever the text', () => {
    const r = out([para('onclick=x <img src=x onerror=alert(1)>')]);
    expect(r.text).not.toMatch(/<script/i);
    expect(r.text).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
  });

  it('escapes any printable text in a paragraph exactly (fast-check, seed 20261113)', () => {
    const printable = fc.constantFrom(
      ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)),
    );
    const typed = fc
      .array(printable, { maxLength: 60 })
      .map((cs) => cs.join(''))
      .filter((s) => s.trim() !== '' && s === s.trim());
    fc.assert(
      fc.property(typed, (s) => {
        const r = htmlText(doc([para(s)]));
        expect(r.text).toContain(`<p>${escapeHtml(s)}</p>`);
        expect(r.text).not.toMatch(/<script/i);
      }),
      { seed: 20261113, numRuns: 200 },
    );
  });

  it('drops a javascript link to its text and names it, and writes an https link and an anchor target', () => {
    const r = out([
      para('', {}, [
        text('bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
        text(' ok ', []),
        text('good', [{ type: 'link', attrs: { href: 'https://example.org/x' } }]),
      ]),
    ]);
    expect(r.text).not.toContain('javascript');
    expect(r.text).toContain('bad ok <a href="https://example.org/x">good</a>');
    expect(r.diagnostics.map((d) => d.code)).toContain('link_scheme_dropped');
  });
});

describe('EXP-087 criterion 4: constructs HTML cannot express are named in the diagnostics', () => {
  it('names tab stops, form fields, page setups, headers and footers, and page breaks', () => {
    const r = htmlText(
      doc(
        [
          para('', {}, [
            { type: 'tab' },
            { type: 'break', attrs: { kind: 'page' } },
            { type: 'form_field', attrs: { id: nid('ff'), key: 'k' } },
          ]),
        ],
        {},
      ),
      {},
    );
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'tab_stop_plain',
        'page_break_omitted',
        'form_field_omitted',
        'page_setup_omitted',
      ]),
    );
    const withStory = htmlText({
      ...doc([para('x')]),
      doc: {
        type: 'doc',
        content: [{ type: 'story', attrs: { id: 's1' } }, ...(doc([para('x')]).doc.content ?? [])],
      },
    } as unknown as CdmEnvelope);
    expect(withStory.diagnostics.map((d) => d.code)).toContain('headers_footers_omitted');
  });
});

describe('EXP-087 criterion 5: the visible text equals the document text', () => {
  it('reads back the same words from the output as the document holds', () => {
    const body: J[] = [
      para('First paragraph with bold.', {}, []),
      para('', {}, [text('Second '), text('bold', [{ type: 'bold' }]), text(' & "more" <text>.')]),
      para('Third with a link.', {}, []),
    ];
    const r = htmlText(doc(body));
    expect(visibleText(r.text)).toBe(
      'First paragraph with bold. Second bold & "more" <text>. Third with a link.',
    );
  });
});

describe('EXP-081 and EXP-082 for the HTML target', () => {
  const body = (): J[] => [
    para('', {}, [
      text('Keep '),
      text('gone', [delMark(1)]),
      text('new ', [insMark(2)]),
      text('end.'),
    ]),
  ];

  it('writes the accepted text under accept, the rejected text under reject, and marks both under markup', () => {
    expect(out(body(), {}, { suggestions: 'accept' }).text).toContain('<p>Keep new end.</p>');
    expect(out(body(), {}, { suggestions: 'reject' }).text).toContain('<p>Keep goneend.</p>');
    expect(out(body(), {}, { suggestions: 'markup' }).text).toContain(
      '<p>Keep <del>gone</del><ins>new </ins>end.</p>',
    );
  });

  it('reports pending_suggestions as an error when the option is missing', () => {
    const r = out(body());
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'pending_suggestions')?.severity).toBe('error');
  });
});

describe('EXP-087 the writer interface', () => {
  it('is the HTML target, reads its title, and gives the same text and bytes on every run', async () => {
    const env = doc([para('Same.')]);
    const before = JSON.stringify(env);
    const input = {
      document: env,
      seq: null,
      chainHead: null,
      fonts: undefined as never,
      assets: {},
      title: 'T',
    };
    const a = await htmlWriter.write(input, {});
    const b = await htmlWriter.write(input, {});
    expect(htmlWriter.target).toBe('html');
    expect(a.text).toContain('<title>T</title>');
    expect(b.text).toBe(a.text);
    expect(new TextDecoder().decode(a.bytes)).toBe(a.text);
    expect(JSON.stringify(env)).toBe(before);
  });
});
