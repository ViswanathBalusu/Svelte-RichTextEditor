/**
 * Links and anchors (Node.js only): EXP-030 criteria 2 and 4, and the scheme part of criterion 1.
 * The tests read main.tex and the diagnostics of the converter's bundle; nothing here compiles, so
 * the link annotations of a PDF are not inspected (criterion 3). Criterion 1 is only partly met:
 * `url` leaves `&`, `#` and `%` unencoded (they are inert inside its hexadecimal payload), which the
 * story's wording asks to be percent-encoded; see the story's Notes. Criterion 5 (the link title
 * through `pdfString`) is tested in `exp-030-link-title.compile.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';

const idOfPara = (p: J): string => (p['attrs'] as J)['id'] as string;

/** A text node carrying a link mark with the given target and title. */
function link(text: string, href: string, title?: string): J {
  return {
    type: 'text',
    text,
    marks: [{ type: 'link', attrs: { href, ...(title !== undefined ? { title } : {}) } }],
  };
}

/** Decodes the hexadecimal payload of a `\DEhref{...}` target to the text it names. */
function decodeHrefTarget(line: string): string {
  const m = /\\DEhref\{([0-9A-F]+)\}/.exec(line);
  if (!m) throw new Error('no \\DEhref in the line');
  return decodeURIComponent((m[1]!.match(/../g) ?? []).map((h) => `%${h}`).join(''));
}

describe('EXP-030 criterion 1 (scheme part): http, https and mailto links reach hyperref through the url emitter', () => {
  it('writes an https link with its space percent-encoded, and a mailto link', async () => {
    const a = para('', {}, [link('Site', 'https://example.com/a b')]);
    const m = para('', {}, [link('Mail', 'mailto:ada@example.com')]);
    const b = await run(doc([a, m]));
    expect(decodeHrefTarget(blockLines(b, idOfPara(a)).join('\n'))).toBe(
      'https://example.com/a%20b',
    );
    expect(decodeHrefTarget(blockLines(b, idOfPara(m)).join('\n'))).toBe('mailto:ada@example.com');
    expect(b.diagnostics.map((d) => d.code)).not.toContain('link_refused');
  });
});

describe('EXP-030 criterion 2: other schemes write no link action and name the block in a diagnostic', () => {
  for (const href of ['run:calc.exe', 'file:///etc/passwd', 'javascript:alert(1)']) {
    it(`prints the text of a ${href.split(':')[0]}: link as plain text, with no link action`, async () => {
      const p = para('', {}, [link('Click here', href)]);
      const b = await run(doc([p]));
      const lines = blockLines(b, idOfPara(p)).join('\n');
      expect(lines).toContain('Click here');
      expect(lines).not.toMatch(/\\DEhref|\\DElink/);
      const d = b.diagnostics.find((x) => x.code === 'link_refused');
      expect(d?.severity).toBe('warning');
      expect(d?.blockId).toBe(idOfPara(p));
    });
  }
});

describe('EXP-030 criterion 4: an anchor writes a named destination, and an in-document link targets it', () => {
  it('writes \\DEanchor with the generated identifier, and \\DElink to the same identifier', async () => {
    const target = para('', {}, [
      { type: 'anchor', attrs: { id: nid('an'), name: 'intro' } },
      { type: 'text', text: 'Intro' },
    ]);
    const source = para('', {}, [link('Go', '#intro')]);
    const b = await run(doc([target, source]));
    expect(blockLines(b, idOfPara(target)).join('\n')).toContain('\\DEanchor{1}');
    expect(blockLines(b, idOfPara(source)).join('\n')).toContain('\\DElink{1}{');
    expect(b.diagnostics.map((d) => d.code)).not.toContain('link_target_missing');
  });
});
