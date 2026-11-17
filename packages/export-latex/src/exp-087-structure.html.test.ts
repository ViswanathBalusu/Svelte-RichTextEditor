/**
 * EXP-087 criterion 1: the HTML has a structure that matches the document. One document holds a
 * heading, a paragraph with a link, a bullet list and a numbered list with their literal labels, a
 * table with a column span, a picture with alternative text, a footnote, an inline equation and a
 * display equation; the test checks that each is in the output, in order, in the element the spec
 * names. The representation of equations (LaTeX source in `code` and `pre`) is a proposal, recorded
 * in docs/adr/0371-w2-exp-087-html-job.md. Node.js only; nothing renders the page.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { htmlText } from './html-writer.ts';

const numbering = (id: string, levels: J[]): J => ({
  type: 'numbering_def',
  attrs: { id, levels },
});
const item = (content: string, numberingId: string): J =>
  para(content, { numbering: { numberingId, level: 0, listId: numberingId.toUpperCase() } });

function document(): J[] {
  const cell = (c: string, attrs: J = {}): J => ({
    type: 'table_cell',
    attrs: { id: nid('c'), ...attrs },
    content: [para(c)],
  });
  const row = (cells: J[]): J => ({ type: 'table_row', attrs: { id: nid('r') }, content: cells });
  return [
    para('Title', { style: 'Heading1' }),
    para('', {}, [
      { type: 'text', text: 'See ' },
      {
        type: 'text',
        text: 'the site',
        marks: [{ type: 'link', attrs: { href: 'https://example.org/a' } }],
      },
      { type: 'text', text: ' and ' },
      { type: 'equation', attrs: { id: nid('e'), latex: 'x^2' } },
      { type: 'text', text: '.' },
      {
        type: 'footnote',
        attrs: { id: nid('fn') },
        content: [para('The note.')],
      },
    ]),
    item('Bullet', 'b'),
    item('First', 'n'),
    {
      type: 'table',
      attrs: { id: nid('t') },
      content: [row([cell('Wide', { colspan: 2 })]), row([cell('a'), cell('b')])],
    },
    {
      type: 'figure',
      attrs: { id: nid('f'), asset: 'img1', alt: 'A cat' },
      content: [
        { type: 'caption', attrs: { id: nid('k') }, content: [{ type: 'text', text: 'Cat' }] },
      ],
    },
    { type: 'equation_block', attrs: { id: nid('q'), latex: 'a+b=c' } },
  ];
}

describe('EXP-087 criterion 1: the structure of the HTML', () => {
  const env = doc(document(), {
    styles: [
      {
        type: 'style_def',
        attrs: { id: 'Heading1', kind: 'paragraph', name: 'H1', outlineLevel: 0 },
      },
    ],
    numberings: [
      numbering('b', [{ format: 'bullet', text: '•', start: 1, bulletChar: '•' }]),
      numbering('n', [{ format: 'decimal', text: '%1.', start: 1 }]),
    ],
  });
  const r = htmlText(env, {}, { img1: new Uint8Array(1) });
  const html = r.text;

  it('writes each construct in the element that matches it, in document order', () => {
    expect(r.ok).toBe(true);
    const order = [
      '<h1>Title</h1>',
      '<a href="https://example.org/a">the site</a>',
      '<code class="de-math">x^2</code>',
      '<sup><a id="fnref1" href="#fn1">1</a></sup>',
      '<ul class="de-list">',
      '<span class="de-label">•</span> Bullet',
      '<ol class="de-list">',
      '<span class="de-label">1.</span> First',
      'colspan="2"',
      '<td',
      '<figure><img src="assets/img1" alt="A cat">',
      '<figcaption>Cat</figcaption>',
      '<pre class="de-math"><code>a+b=c</code></pre>',
      '<section class="de-footnotes"><ol><li id="fn1">The note.',
    ];
    let at = 0;
    for (const part of order) {
      const i = html.indexOf(part, at);
      expect(i, `"${part}" after offset ${at}`).toBeGreaterThanOrEqual(0);
      at = i;
    }
  });

  it('lists the picture for the packaging of the job', () => {
    expect(r.assets).toEqual([{ path: 'assets/img1', asset: 'img1' }]);
  });

  it('names the equations as source, because they are not rendered', () => {
    expect(r.diagnostics.map((d) => d.code)).toContain('equation_as_source');
  });
});
