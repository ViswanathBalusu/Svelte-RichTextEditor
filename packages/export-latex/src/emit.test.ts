import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clean,
  color,
  dimen,
  enumLookup,
  kvValue,
  letters,
  lit,
  pdfString,
  text,
  url,
} from './emit.ts';

/** The inverse of `text`, for the oracle "what TeX prints is the input" (09 §4). */
function decodeText(tex: string): string | null {
  let out = '';
  let i = 0;
  const words: Record<string, string> = {
    '\\textbackslash{}': '\\',
    '\\textasciicircum{}': '^',
    '\\textasciitilde{}': '~',
  };
  while (i < tex.length) {
    const rest = tex.slice(i);
    const word = Object.keys(words).find((w) => rest.startsWith(w));
    if (word) {
      out += words[word];
      i += word.length;
    } else if (rest.startsWith('{[}') || rest.startsWith('{]}')) {
      out += rest[1];
      i += 3;
    } else if (rest.startsWith('\\-')) {
      out += '\u00AD';
      i += 2;
    } else if (rest.startsWith('\\ ')) {
      out += ' ';
      i += 2;
    } else if (/^\\[{}$&#_%]/.test(rest)) {
      out += rest[1];
      i += 2;
    } else if (rest[0] === '~') {
      out += '\u00A0';
      i += 1;
    } else if (/^[\\{}$&#_%^~[\]]/.test(rest)) {
      return null; // an unescaped special character: the emitter failed
    } else {
      const cp = rest.codePointAt(0)!;
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
    }
  }
  return out;
}

describe('text emitter', () => {
  it('escapes every character TeX treats specially', () => {
    expect(text('\\ { } $ & # _ % ^ ~')).toBe(
      '\\textbackslash{} \\{ \\} \\$ \\& \\# \\_ \\% \\textasciicircum{} \\textasciitilde{}',
    );
  });

  it('guards brackets, maps no-break space and soft hyphen', () => {
    expect(text('[x]')).toBe('{[}x{]}');
    expect(text('a\u00A0b\u00ADc')).toBe('a~b\\-c');
  });

  it('removes control and bidirectional control characters and normalises to NFC', () => {
    expect(text('a\u0000b\u001Bc\u202Ed\u2066e\uFEFF')).toBe('abcde');
    expect(text('e\u0301')).toBe('\u00E9');
    expect(text('line\nbreak\ttab')).toBe('linebreaktab');
  });

  it('keeps repeated, leading and trailing spaces as explicit spaces', () => {
    expect(text('a  b')).toBe('a \\ b');
    expect(text(' a', { afterSpace: true })).toBe('\\ a');
    expect(text('a ')).toBe('a ');
  });

  it('never lets a special character through (property: decode(text(s)) = clean(s))', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
        const decoded = decodeText(text(s));
        expect(decoded).not.toBeNull();
        expect(decoded).toBe(clean(s));
      }),
      { numRuns: 2000 },
    );
  });

  it('neutralises known attack strings', () => {
    for (const attack of [
      '\\input{/etc/passwd}',
      '\\write18{rm -rf /}',
      '^^5cinput',
      '\\directlua{os.exit()}',
      '}\\end{document}',
    ]) {
      const t = text(attack);
      expect(t).not.toMatch(/\\(input|write|directlua|end)\b/);
      expect(t).not.toContain('^^');
    }
  });
});

describe('pdfString and kvValue emitters', () => {
  it('write hexadecimal digits only, whatever the input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
        expect(pdfString(s)).toMatch(/^\\DEstr\{(?:[0-9A-F]{2})*\}$/);
        expect(kvValue(s)).toMatch(/^\{\\DEstr\{(?:[0-9A-F]{2})*\}\}$/);
      }),
    );
  });

  it('round-trip through hex', () => {
    const s = 'Café, }]{ \\relax % #';
    const hex = /\{([0-9A-F]*)\}/.exec(pdfString(s))![1]!;
    const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(new TextDecoder().decode(bytes)).toBe(s);
  });
});

describe('url emitter', () => {
  it('allows http, https, mailto and in-document targets (invariant I9)', () => {
    expect(url('https://example.org/a?b=1&c=%20#top').kind).toBe('external');
    expect(url('mailto:someone@example.org').kind).toBe('external');
    expect(url('#section_1')).toEqual({ kind: 'internal', name: 'section_1' });
  });

  it('refuses every other scheme', () => {
    for (const href of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'run:calc.exe',
      'data:text/html,x',
      'ftp://x',
    ]) {
      expect(url(href).kind).toBe('refused');
    }
  });

  it('percent-encodes characters outside RFC 3986 and writes hex only', () => {
    const r = url('https://example.org/ä b"{}\\');
    expect(r.kind).toBe('external');
    if (r.kind !== 'external') return;
    expect(r.tex).toMatch(/^(?:[0-9A-F]{2})+$/);
    const decoded = new TextDecoder().decode(
      new Uint8Array(r.tex.match(/../g)!.map((h) => parseInt(h, 16))),
    );
    expect(decoded).toBe('https://example.org/%C3%A4%20b%22%7B%7D%5C');
  });
});

describe('dimen, color, enumLookup, identifiers', () => {
  it('converts twips exactly and clamps', () => {
    expect(dimen(230)).toBe('11.5bp');
    expect(dimen(99999999)).toBe('1584bp');
    expect(dimen(-5, { min: 0, max: 100 })).toBe('0bp');
    expect(dimen(1.5)).toBe('0bp');
  });

  it('accepts six hexadecimal digits only', () => {
    expect(color('#1f5fad')).toBe('1F5FAD');
    for (const bad of ['red', '#12345', '#1234567', '#GGGGGG', '1F5FAD}', null, undefined])
      expect(color(bad)).toBeNull();
  });

  it('never writes the looked-up value', () => {
    const table = { a: lit('AAA'), b: lit('BBB') };
    expect(enumLookup(table, 'a', lit('AAA'))).toEqual({ tex: 'AAA', known: true });
    expect(enumLookup(table, '\\input', lit('AAA'))).toEqual({ tex: 'AAA', known: false });
    expect(enumLookup(table, 'constructor', lit('AAA')).known).toBe(false);
  });

  it('derives macro names from counters only', () => {
    expect(letters(0)).toBe('a');
    expect(letters(25)).toBe('z');
    expect(letters(26)).toBe('ba');
    expect(new Set(Array.from({ length: 1000 }, (_, i) => letters(i))).size).toBe(1000);
  });
});
