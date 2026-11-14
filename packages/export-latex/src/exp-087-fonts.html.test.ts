/**
 * EXP-087 criterion 3 (Node.js only, U4 group 1 round 4 fixer): the HTML writer writes the font
 * family, font size and highlight of the resolved run (03 §6), not only the marks. The default
 * paragraph style's family and size are written on `body`; a run carries a `style` only where it
 * differs. Each case names the cascade layer the value comes from.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { text } from '../test/suggestions.ts';
import { htmlText } from './html-writer.ts';

const normal = (attrs: J): J => ({
  type: 'style_def',
  attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true, ...attrs },
});
const paraStyle = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, basedOn: 'Normal', ...attrs },
});
const charStyle = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'character', name: id, ...attrs },
});
const charMark = (style: string): J => ({ type: 'charStyle', attrs: { style } });
const valued = (type: string, value: unknown): J => ({ type, attrs: { value } });
const codes = (r: ReturnType<typeof htmlText>): string[] => r.diagnostics.map((d) => d.code);

describe('EXP-087 criterion 3: font family, font size and highlight follow the cascade of 03 §6', () => {
  it('writes the family and size of the default paragraph style on body, and no style on its runs', () => {
    const r = htmlText(
      doc([para('plain')], { styles: [normal({ fontFamily: 'Noto Serif', fontSize: 240 })] }),
    );
    expect(r.text).toContain("body{font-family:'Noto Serif';font-size:12pt}");
    expect(r.text).toContain('<p>plain</p>');
    expect(r.ok).toBe(true);
  });

  it('writes the base size of 11 points on body when no style sets one', () => {
    const r = htmlText(doc([para('plain')]));
    expect(r.text).toContain('body{font-size:11pt}');
    expect(r.text).toContain('<p>plain</p>');
  });

  it('writes a font size from a paragraph style on its runs', () => {
    const styles = [normal({ fontFamily: 'Noto Serif' }), paraStyle('Big', { fontSize: 320 })];
    const r = htmlText(doc([para('Title', { style: 'Big' })], { styles }));
    expect(r.text).toContain('<p><span style="font-size:16pt">Title</span></p>');
    expect(r.text).not.toContain("<span style=\"font-family:'Noto Serif'");
  });

  it('writes a font family from a character style, and the paragraph style size under it', () => {
    const styles = [
      normal({ fontFamily: 'Noto Serif' }),
      paraStyle('Big', { fontSize: 280 }),
      charStyle('Sans', { fontFamily: 'Noto Sans' }),
    ];
    const r = htmlText(
      doc([para('', { style: 'Big' }, [text('word', [charMark('Sans')])])], { styles }),
    );
    expect(r.text).toContain(
      `<span style="font-family:&#39;Noto Sans&#39;;font-size:14pt">word</span>`,
    );
    expect(codes(r)).not.toContain('charStyle_plain');
  });

  it('lets a direct size mark override the style, with no diagnostic for the mark', () => {
    const styles = [paraStyle('Big', { fontSize: 320 })];
    const r = htmlText(
      doc([para('', { style: 'Big' }, [text('small', [valued('fontSize', 180)])])], { styles }),
    );
    expect(r.text).toContain('<span style="font-size:9pt">small</span>');
    expect(codes(r)).not.toContain('fontSize_plain');
  });

  it('a direct size mark equal to the default writes no style', () => {
    const r = htmlText(doc([para('', {}, [text('same', [valued('fontSize', 220)])])]));
    expect(r.text).toContain('<p>same</p>');
  });

  it('writes a highlight from a character style and from a direct mark as a background colour', () => {
    const styles = [charStyle('Marked', { highlight: 'yellow' })];
    const r = htmlText(
      doc(
        [
          para('', {}, [
            text('styled', [charMark('Marked')]),
            text(' direct', [valued('highlight', 'darkBlue')]),
          ]),
        ],
        { styles },
      ),
    );
    expect(r.text).toContain('<span style="background-color:#FFFF00">styled</span>');
    expect(r.text).toContain('<span style="background-color:#000080"> direct</span>');
    expect(codes(r)).not.toContain('highlight_plain');
  });

  it('writes family, size, colour and highlight of one run in one style attribute', () => {
    const styles = [
      paraStyle('Loud', {
        fontFamily: 'Noto Sans',
        fontSize: 300,
        color: '#AA0000',
        highlight: 'lightGray',
        bold: true,
      }),
    ];
    const r = htmlText(doc([para('Alert', { style: 'Loud' })], { styles }));
    expect(r.text).toContain(
      '<strong><span style="font-family:&#39;Noto Sans&#39;;font-size:15pt;color:#AA0000;background-color:#C0C0C0">Alert</span></strong>',
    );
  });

  it('writes a paragraph style alignment as the paragraph class, and a direct one over it', () => {
    const styles = [paraStyle('Centred', { align: 'center' })];
    const r = htmlText(
      doc(
        [
          para('From style', { style: 'Centred' }),
          para('Direct', { style: 'Centred', align: 'end' }),
        ],
        { styles },
      ),
    );
    expect(r.text).toContain('<p class="de-align-center">From style</p>');
    expect(r.text).toContain('<p class="de-align-end">Direct</p>');
  });

  it('names spacing that comes from a paragraph style, which HTML output does not write', () => {
    const plain = htmlText(doc([para('plain')]));
    expect(codes(plain)).not.toContain('paragraph_layout_omitted');
    const r = htmlText(
      doc([para('spaced', { style: 'Spaced' })], {
        styles: [paraStyle('Spaced', { spaceAfter: 160 })],
      }),
    );
    expect(codes(r)).toContain('paragraph_layout_omitted');
  });

  it('names a family or highlight it cannot write safely and writes the text without it', () => {
    const styles = [paraStyle('Odd', { fontFamily: "Bad'};x:url(y)", highlight: 'purple' })];
    const r = htmlText(doc([para('text', { style: 'Odd' })], { styles }));
    expect(codes(r)).toEqual(
      expect.arrayContaining(['font_family_not_written', 'highlight_not_written']),
    );
    expect(r.text).toContain('<p>text</p>');
    expect(r.text).not.toContain('url(');
  });
});
