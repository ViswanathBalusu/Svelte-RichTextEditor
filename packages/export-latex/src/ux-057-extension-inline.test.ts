/**
 * UX-057 criterion 4 for the HTML and Markdown writers: inline custom content is written as its
 * fallback text, with a diagnostic, and the payload is never written. (The PDF writer is tested in
 * extension.fallback.test.ts, EXP-035; the DOCX writer in packages/export-docx/test/ux-057-extension-inline.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { doc, nid } from '../test/docs.ts';
import { htmlText } from './html-writer.ts';
import { markdownText } from './markdown-writer.ts';

const SENTINEL = 'UX057_PAYLOAD_SENTINEL_5be2';

const document = () =>
  doc(
    [
      {
        type: 'paragraph',
        attrs: { id: nid('p') },
        content: [
          { type: 'text', text: 'Ask ' },
          {
            type: 'extension_inline',
            attrs: {
              extension: 'com.example.mention',
              payload: { user: SENTINEL },
              fallbackText: 'Ada <Lovelace> & co',
              ext: {},
            },
          },
          { type: 'text', text: ' today.' },
        ],
      },
    ],
    { requires: ['extensions'] },
  );

describe('UX-057 criterion 4: HTML and Markdown write the inline fallback and never the payload', () => {
  it('writes the fallback text, escaped, in the line of text in HTML', () => {
    const out = htmlText(document());
    expect(out.text).toContain('Ask Ada &lt;Lovelace&gt; &amp; co today.');
    expect(out.text).not.toContain(SENTINEL);
    expect(out.text).not.toContain('com.example.mention');
    expect(out.diagnostics.map((d) => d.code)).toContain('extension_omitted');
  });

  it('writes the fallback text in the line of text in Markdown', () => {
    const out = markdownText(document());
    expect(out.text).toContain('Ask Ada');
    expect(out.text).toContain('Lovelace');
    expect(out.text).toContain(' today.');
    expect(out.text).not.toContain(SENTINEL);
    expect(out.text).not.toContain('com.example.mention');
  });
});
