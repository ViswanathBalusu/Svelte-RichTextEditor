/**
 * EXP-111 criterion 3 (Node.js only): the document language and the language marks, as the
 * converter writes them. The PDF's /Lang is read from the compiled PDF by
 * exp-111-tagged.compile.test.ts (describe `sets /Lang to the document language`); this file checks
 * the source the converter writes for that value and for passages, and does not compile.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run } from '../test/docs.ts';

const TAGGED = { tagging: 'on' as const };

/** The \DocumentMetadata line of main.tex, found anywhere in the file. */
function metadataLine(main: string): string {
  const m = /\\DocumentMetadata\{[^}\n]*\}/.exec(main);
  if (m === null)
    throw new Error(
      `main.tex has no \\DocumentMetadata line; it starts: ${JSON.stringify(main.slice(0, 300))}`,
    );
  return m[0];
}

describe('EXP-111 criterion 3: the document language is the PDF language', () => {
  it('writes the document language of the settings as lang= in \\DocumentMetadata', async () => {
    const b = await run(doc([para('Hallo.')], { settings: { lang: 'de-DE' } }), TAGGED);
    expect(metadataLine(b.files['main.tex']!)).toMatch(/^\\DocumentMetadata\{lang=de-DE,/);
  });

  it('falls back to en-GB when the settings name no language of their own', async () => {
    const b = await run(doc([para('Hello.')]), TAGGED);
    expect(metadataLine(b.files['main.tex']!)).toMatch(/^\\DocumentMetadata\{lang=en-GB,/);
  });
});

describe('EXP-111 criterion 3: a language mark sets the language of its passage only', () => {
  it('wraps the marked run in \\DElang and leaves the rest of the paragraph in the document language', async () => {
    const marked = {
      type: 'text',
      text: 'Bonjour le monde.',
      marks: [{ type: 'lang', attrs: { value: 'fr-FR' } }],
    };
    const b = await run(
      doc([para('Plain text. ', {}, [marked])], { settings: { lang: 'en-GB' } }),
      TAGGED,
    );
    const main = b.files['main.tex']!;
    expect(main).toMatch(/\\DElang\{1\}\{\\DEr\{\d+\}\{Bonjour le monde\.\}\}/);
    expect(main).toMatch(/\\DEdeflang\{1\}\{french\}\{fr\}\{fr-FR\}/);
    expect(main).toContain('\\DEr{0}{Plain text. }');
  });
});
