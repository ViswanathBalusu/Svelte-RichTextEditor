/**
 * SEC-006 criterion 5, LaTeX side: a link written into the LaTeX export has its scheme checked by
 * the same allow-list as `link.href` (CDM-002, `LINK_HREF_PATTERN`; invariant I9; 10 §3.1).
 *
 * The corpus is the one of `tests/security/test/link-safety.test.ts`. The DOCX side is not covered
 * here: see SEC-006 Notes.
 *
 * Where the writer and the CDM grammar differ, the test records it. The writer percent-encodes the
 * body of an `https` or `http` target that holds a space or a quote, so it writes a link the grammar
 * would refuse. The scheme decision is the same in both.
 */
import fc from 'fast-check';
import { LINK_HREF_PATTERN } from '@docedit/model/definition';
import { describe, expect, it } from 'vitest';
import { url } from './emit.ts';

const linkHref = new RegExp(LINK_HREF_PATTERN);

/** Forbidden schemes and their obfuscated forms: the writer refuses each one. */
const FORBIDDEN_SCHEMES = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'JAVASCRIPT:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  ' javascript:alert(1)',
  'javascript%3Aalert(1)',
  '%6Aavascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'DATA:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://example.com/0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
];

/** Targets of the allow-list: the writer and the grammar both accept them. */
const ACCEPTED = ['https://example.com/a?b=c', 'http://example.com', 'mailto:ada@example.com'];

/** Hostile targets with an allowed scheme but a body the grammar refuses. */
const HOSTILE_BODIES = [
  'https://example.com/ javascript:alert(1)',
  'https://example.com/"onmouseover="alert(1)',
];

/** The UTF-8 text a writer's hex output stands for. */
function decodeHex(tex: string): string {
  const bytes = new Uint8Array(tex.match(/../g)!.map((h) => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
}

describe('SEC-006 criterion 5 (LaTeX): link schemes are checked by the link.href allow-list', () => {
  it.each(FORBIDDEN_SCHEMES)('refuses %j, as the grammar does', (href) => {
    expect(url(href).kind).toBe('refused');
    expect(linkHref.test(href)).toBe(false);
  });

  it.each(ACCEPTED)('accepts %s, as the grammar does', (href) => {
    expect(url(href).kind).toBe('external');
    expect(linkHref.test(href)).toBe(true);
  });

  it('accepts an in-document target with the same rule as the grammar', () => {
    expect(url('#section-1')).toEqual({ kind: 'internal', name: 'section-1' });
    expect(linkHref.test('#section-1')).toBe(true);
  });

  it.each(HOSTILE_BODIES)(
    'writes %j only percent-encoded, so no raw space or quote reaches the typesetter',
    (href) => {
      expect(linkHref.test(href)).toBe(false);
      const r = url(href);
      expect(r.kind).toBe('external');
      if (r.kind !== 'external') return;
      const written = decodeHex(r.tex);
      expect(written).not.toMatch(/[\s"<>{}|\\^`]/);
      expect(written.startsWith('https://example.com/')).toBe(true);
    },
  );

  it('property: a javascript scheme with random case, a control character and a leading space is refused', () => {
    const cases = fc.array(fc.boolean(), { minLength: 10, maxLength: 10 });
    const control = fc.constantFrom('\t', '\n', '\r', '\u0000', ' ');
    fc.assert(
      fc.property(
        cases,
        control,
        fc.integer({ min: 0, max: 9 }),
        fc.boolean(),
        (bits, ctl, at, lead) => {
          const word = 'javascript'
            .split('')
            .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch))
            .join('');
          const href = (lead ? ' ' : '') + word.slice(0, at) + ctl + word.slice(at) + ':alert(1)';
          expect(url(href).kind).toBe('refused');
          expect(linkHref.test(href)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
