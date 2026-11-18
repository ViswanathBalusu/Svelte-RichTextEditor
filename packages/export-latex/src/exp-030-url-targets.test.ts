/**
 * Link targets that carry characters special to TeX (Node.js): EXP-030 criterion 1, as reworded
 * after the owner's decision 25 of 2026-11-15 (`docs/owner-decisions-2026-11-15.md`): the `url`
 * emitter allows only http, https, mailto and in-document targets, percent-encodes every character
 * outside RFC 3986, and the whole target reaches TeX hex-encoded, so no character of it is read as
 * TeX.
 *
 * - Converter side (always runs): for targets with `& # % _ ~ $ ^ { } \ < > " ' space` and a non-ASCII
 *   letter, the argument of `\DEhref` is hexadecimal digits only, and decodes to the target with
 *   exactly the characters outside RFC 3986 percent-encoded (as UTF-8) and every other character,
 *   `&`, `#`, `%`, `_`, `~` and `$` included, unchanged.
 * - PDF side (sandbox, skips when `sandboxReady()` says it cannot run, EXP-070): the URI action in
 *   the compiled PDF is the encoded target, character for character.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

function link(text: string, href: string): J {
  return { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] };
}

/** The target that `\DEhref` carries, decoded from its hexadecimal argument. */
function hrefOf(lines: string): { hex: string; text: string } {
  const m = /\\DEhref\{([^}]*)\}/.exec(lines);
  if (!m) throw new Error('no \\DEhref');
  const hex = m[1]!;
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  return { hex, text: new TextDecoder().decode(bytes) };
}

/** The characters RFC 3986 allows in a URI (the set the emitter keeps). */
const RFC3986 = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
/** The encoding the emitter must give, written here from the rule and not from its code. */
function expectedEncoding(href: string): string {
  let out = '';
  for (const ch of href) {
    if (RFC3986.test(ch)) out += ch;
    else
      out += [...new TextEncoder().encode(ch)]
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('');
  }
  return out;
}

const TARGETS = [
  'https://example.com/a?x=1&y=2#frag',
  'https://example.com/100%25/a_b~c$d',
  'https://example.com/a b/{curly}/back\\slash/^caret',
  'https://example.com/<angle>/"quote"/\'apostrophe\'',
  'http://example.com/café?q=ü',
  'mailto:ada@example.com?subject=a&body=100%25',
];

describe('EXP-030 criterion 1: a link target with TeX-special characters reaches TeX hex-encoded and percent-encoded', () => {
  for (const href of TARGETS) {
    it(`encodes ${JSON.stringify(href)}`, async () => {
      const p = para('', {}, [link('Link', href)]);
      const b = await run(doc([p]));
      expect(b.diagnostics.map((d) => d.code)).not.toContain('link_refused');
      const { hex, text } = hrefOf(blockLines(b, idOf(p)).join('\n'));
      // Nothing but hexadecimal digits reaches TeX, so no special character is read as TeX.
      expect(hex).toMatch(/^[0-9A-F]+$/);
      expect(text).toBe(expectedEncoding(href));
      // The characters that RFC 3986 allows are not percent-encoded again.
      for (const ch of ['&', '#', '_', '~', '$']) if (href.includes(ch)) expect(text).toContain(ch);
    });
  }
});

const ready = (await sandboxReady()).ok;

/** The PDF as text: the raw file, then every inflatable stream (so object streams are read). */
function pdfObjectText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts = [raw];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      parts.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // Not a Flate stream.
    }
  }
  return parts.join('\n');
}

describe.skipIf(!ready)(
  'EXP-030 criterion 1, in the compiled PDF: the URI action is the encoded target',
  () => {
    it('writes the URI action of each target exactly as the emitter encodes it', async () => {
      const targets = [
        'https://example.com/a?x=1&y=2#frag',
        'https://example.com/100%25/a_b~c$d',
        'https://example.com/a b/{curly}/back\\slash/^caret',
      ];
      const body = targets.map((t, i) =>
        para('', {}, [link(`Link ${i}`, t), { type: 'text', text: ' ' + nid('t') }]),
      );
      const c = await convertAndCompile(doc(body), {
        profile: 'preview',
        title: 'exp-030-uri-targets',
        instant: '2026-11-06T10:00:00.000Z',
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-030-uri', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      const objects = pdfObjectText(c.compile.pdf);
      // LuaTeX writes some characters of a literal string as octal escapes (`&` is `\046`).
      const uris = [...objects.matchAll(/\/URI \(((?:[^\\)]|\\.|\\[0-7]{3})*)\)/g)].map((m) =>
        m[1]!.replace(/\\([0-7]{3})/g, (_s, o: string) => String.fromCharCode(parseInt(o, 8))),
      );
      for (const t of targets)
        expect(uris, `the URI actions of the PDF hold ${t}`).toContain(expectedEncoding(t));
    }, 600_000);
  },
);
