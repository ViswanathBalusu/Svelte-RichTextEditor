import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clean, generatedId, kvValue, pdfHexString, pdfString, url } from './emit.ts';

/** Decodes the hexadecimal digits of `\DEstr{...}` back to the UTF-8 text the class prints (EXP-043). */
function decodeDEstr(tex: string): string {
  const hex = /^\\DEstr\{((?:[0-9A-F]{2})*)\}$/.exec(tex)![1]!;
  // decodeURIComponent throws on malformed UTF-8, so a broken payload fails the test.
  return decodeURIComponent((hex.match(/../g) ?? []).map((h) => `%${h}`).join(''));
}

/** Decodes the UTF-16BE hexadecimal form of a PDF text string with its byte order mark. */
function decodePdfHex(tex: string): string {
  const hex = /^<FEFF((?:[0-9A-F]{4})*)>$/.exec(tex)![1]!;
  let out = '';
  for (const unit of hex.match(/.{4}/g) ?? []) out += String.fromCharCode(parseInt(unit, 16));
  return out;
}

describe('pdfString round trip (EXP-043 criterion 1)', () => {
  it('decodes back to the cleaned input for any string, so no TeX command survives', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
        expect(decodeDEstr(pdfString(s))).toBe(clean(s));
      }),
      { numRuns: 1000 },
    );
  });

  it('keeps every TeX-special sequence inert inside the hex payload', () => {
    for (const attack of ['\\input{/etc/passwd}', '\\write18{x}', '}\\end{document}', '^^5c']) {
      const t = pdfString(attack);
      expect(t).not.toMatch(/\\(input|write|end)\b/);
      expect(decodeDEstr(t)).toBe(attack);
    }
  });
});

describe('pdfHexString (UTF-16BE dictionary strings)', () => {
  it('writes a byte order mark and UTF-16BE code units that decode to the cleaned input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 120 }), (s) => {
        const t = pdfHexString(s);
        expect(t.startsWith('<FEFF')).toBe(true);
        expect(decodePdfHex(t)).toBe(clean(s));
      }),
      { numRuns: 500 },
    );
  });
});

describe('kvValue (EXP-043 criterion 2)', () => {
  it('neutralises commas, equals signs, brackets and braces in the value', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
        const t = kvValue(s);
        expect(t.startsWith('{') && t.endsWith('}')).toBe(true);
        // Once the emitter's own wrapper, command name and hex digits are removed, nothing is left:
        // no `,`, `=`, `]` or any other character a value could use to change the option list.
        expect(t.replace(/\\DEstr|[{}0-9A-F]/g, '')).toBe('');
        expect(decodeDEstr(t.slice(1, -1))).toBe(clean(s));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('url emitter (EXP-043 criterion 1 and 3, scheme part)', () => {
  it('writes only hexadecimal digits for every allowed link target', () => {
    fc.assert(
      fc.property(fc.webUrl(), (href) => {
        const r = url(href);
        expect(r.kind).toBe('external');
        if (r.kind === 'external') expect(r.tex).toMatch(/^(?:[0-9A-F]{2})+$/);
      }),
      { numRuns: 300 },
    );
  });
});

describe('generatedId (EXP-042 criterion 4, emitter part)', () => {
  it('is injective over counters and rejects anything that is not a counter', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 5000; n++) seen.add(generatedId(n));
    expect(seen.size).toBe(5000);
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => generatedId(bad)).toThrow(RangeError);
    }
  });
});
