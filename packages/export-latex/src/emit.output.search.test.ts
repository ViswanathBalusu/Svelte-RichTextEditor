/**
 * EXP-043 criterion 4 (search of the converter's output, Node.js only): a probe string with TeX
 * control sequences, braces, a percent sign and a `^^` escape is put into every place that carries
 * alternative text, a link target, a link title, a heading (bookmark text) and the document title.
 * The bundle is then searched: the raw probe must appear in no file, and the probe must appear in
 * the emitted form of each place. Nothing here compiles; the check is on the text of the bundle.
 *
 * The link title is written by `pdfString` like every other title (EXP-030 criterion 5, owner
 * decision 209); until then it went through `pdfHexString`.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, run, type J } from '../test/docs.ts';

/** TeX control sequence, braces, a percent sign and a `^^` escape: every special the emitters cover. */
const PROBE = '\\write18{x}%^^41';

/** Upper-case UTF-8 hexadecimal digits of a string, as `pdfString` writes them. */
function utf8Hex(s: string): string {
  return Buffer.from(s, 'utf8').toString('hex').toUpperCase();
}

const HEADING_STYLE: J = {
  type: 'style_def',
  attrs: { id: 'Heading1', kind: 'paragraph', name: 'Heading 1', builtIn: true, outlineLevel: 1 },
};

function probeDocument(): J[] {
  const figure: J = {
    type: 'figure',
    attrs: { id: nid('f'), asset: 'pic1', width: 1440, height: 1440, alt: PROBE },
  };
  const inlineImage: J = {
    type: 'image',
    attrs: { asset: 'pic1', width: 720, height: 720, alt: PROBE },
  };
  const link: J = {
    type: 'text',
    text: 'Link.',
    marks: [{ type: 'link', attrs: { href: `https://example.org/${PROBE}`, title: PROBE } }],
  };
  return [
    figure,
    para('', {}, [inlineImage]),
    para('', {}, [link]),
    para(PROBE, { style: 'Heading1' }),
  ];
}

describe('EXP-043 criterion 4: the output carries each probe only in its emitted form', () => {
  it('never writes the raw probe into a TeX file of the bundle (manifest JSON keeps the title)', async () => {
    const env = doc(probeDocument(), { styles: [HEADING_STYLE] });
    const b = await run(env, { title: PROBE, assets: {} });
    for (const [name, text] of Object.entries(b.files)) {
      if (typeof text !== 'string' || !name.endsWith('.tex')) continue;
      expect(text, name).not.toContain('\\write18');
      expect(text, name).not.toContain('^^41');
    }
  });

  it('writes the alternative text of a figure and of an inline image as pdfString hex', async () => {
    const env = doc(probeDocument(), { styles: [HEADING_STYLE] });
    const b = await run(env, { title: PROBE });
    const main = b.files['main.tex']!;
    expect(main).toContain(utf8Hex(PROBE));
    const count = main.split(utf8Hex(PROBE)).length - 1;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('writes the document title as a key-value value of hyperref in hex', async () => {
    const env = doc([para('Body.')]);
    const b = await run(env, { title: PROBE });
    const all = Object.values(b.files)
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
    expect(all).toContain(`\\hypersetup{pdftitle={\\DEstr{${utf8Hex(PROBE)}}}}`);
  });

  it('writes the heading text, the bookmark text, as pdfString hex', async () => {
    const env = doc(probeDocument(), { styles: [HEADING_STYLE] });
    const b = await run(env, { title: 'T' });
    expect(b.files['main.tex']!).toContain(utf8Hex(PROBE));
  });

  it('writes the link target through url: hex of the encoded target, with the probe percent-encoded', async () => {
    const env = doc(probeDocument(), { styles: [HEADING_STYLE] });
    const b = await run(env, { title: 'T' });
    const main = b.files['main.tex']!;
    const m = /\\DEhref\{([0-9A-F]+)\}/.exec(main);
    expect(m).not.toBeNull();
    const target = Buffer.from(m![1]!, 'hex').toString('utf8');
    expect(target).toContain('%5Cwrite18%7Bx%7D%%5E%5E41');
    expect(target).not.toContain('\\');
    expect(target).not.toContain('^');
  });

  it('writes the link title in the form of pdfString', async () => {
    const env = doc(probeDocument(), { styles: [HEADING_STYLE] });
    const b = await run(env, { title: 'T' });
    expect(b.files['main.tex']!).toContain(`\\DEstr{${utf8Hex(PROBE)}}`);
  });
});
