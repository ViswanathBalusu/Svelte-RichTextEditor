/**
 * UX-058 criterion 3 for the HTML and Markdown writers: a custom block whose extension is not
 * available is written as its fallback text, with a diagnostic, and the payload is never written.
 * (The PDF writer is tested in extension.fallback.test.ts, EXP-035; the DOCX writer in
 * packages/export-docx/test/ux-058-extension-fallback.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para } from '../test/docs.ts';
import { htmlText } from './html-writer.ts';
import { markdownText } from './markdown-writer.ts';

const SENTINEL = 'UX058_PAYLOAD_SENTINEL_91c4';

const document = () =>
  doc(
    [
      para('Before.'),
      {
        type: 'extension_block',
        attrs: {
          id: nid('x'),
          extension: 'com.example.gone',
          payload: { text: SENTINEL, nested: { value: SENTINEL } },
          fallbackAsset: null,
          fallbackText: 'A chart of three values',
          ext: {},
        },
      },
      para('After.'),
    ],
    { requires: ['extensions'] },
  );

describe('UX-058 criterion 3: HTML and Markdown write the fallback and never the payload', () => {
  it('writes the fallback text as a paragraph in HTML', () => {
    const out = htmlText(document());
    expect(out.text).toContain('<p>A chart of three values</p>');
    expect(out.text).not.toContain(SENTINEL);
    expect(out.text).not.toContain('com.example.gone');
    expect(out.diagnostics.map((d) => d.code)).toContain('extension_omitted');
  });

  it('writes the fallback text in Markdown', () => {
    const out = markdownText(document());
    expect(out.text).toContain('A chart of three values');
    expect(out.text).not.toContain(SENTINEL);
    expect(out.text).not.toContain('com.example.gone');
  });
});
