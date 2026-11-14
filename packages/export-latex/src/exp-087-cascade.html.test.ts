/**
 * EXP-087 criterion 3 (Node.js only, lane U-EXP-081-096): the HTML writer resolves run formatting
 * through the model's cascade (03 §6): the paragraph style, the character style, then direct marks.
 * Each case compares the written tags with the resolved run, not with the marks alone.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { text } from '../test/suggestions.ts';
import { htmlText } from './html-writer.ts';

const paraStyle = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, ...attrs },
});
const charStyle = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'character', name: id, ...attrs },
});
const charMark = (style: string): J => ({ type: 'charStyle', attrs: { style } });
const boldOff: J = { type: 'bold', attrs: { value: false } };

describe('EXP-087 criterion 3: run formatting follows the cascade of 03 §6', () => {
  it('writes bold from the paragraph style when the run has no mark of its own', () => {
    const r = htmlText(
      doc([para('', { style: 'Heavy' }, [text('word')])], {
        styles: [paraStyle('Heavy', { bold: true })],
      }),
    );
    expect(r.text).toContain('<p><strong>word</strong></p>');
  });

  it('lets a direct mark with value false override the style for that run', () => {
    const r = htmlText(
      doc([para('', { style: 'Heavy' }, [text('word', [boldOff])])], {
        styles: [paraStyle('Heavy', { bold: true })],
      }),
    );
    expect(r.text).toContain('<p>word</p>');
    expect(r.text).not.toContain('<strong>');
  });

  it('writes italic from a character style, and bold from the paragraph style under it', () => {
    const styles = [paraStyle('Heavy', { bold: true }), charStyle('Emph', { italic: true })];
    const r = htmlText(
      doc([para('', { style: 'Heavy' }, [text('word', [charMark('Emph')])])], { styles }),
    );
    expect(r.text).toContain('<strong><em>word</em></strong>');
  });

  it('writes a colour set in the paragraph style, and names small capitals from a style', () => {
    const styles = [paraStyle('Red', { color: '#AA0000', smallCaps: true })];
    const r = htmlText(doc([para('Note', { style: 'Red' })], { styles }));
    expect(r.text).toContain('<span style="color:#AA0000">Note</span>');
    expect(r.diagnostics.some((d) => d.code === 'caps_plain')).toBe(true);
  });

  it('keeps a direct formatting-free run plain when no style applies', () => {
    const r = htmlText(doc([para('plain')]));
    expect(r.text).toContain('<p>plain</p>');
    expect(r.ok).toBe(true);
  });
});
