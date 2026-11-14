// RFC 8785 test vectors (FND-005). This file runs in Node.js and in Chromium, Firefox and WebKit
// (vitest.config.ts, project "browser"), so every output is checked byte for byte on each engine.
import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalizeText, CanonicalizationError } from './jcs.ts';

function fromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe('RFC 8785', () => {
  it('canonicalises the example of section 3.2.3', () => {
    const input =
      '{\n  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n  "literals": [null, true, false]\n}';
    expect(canonicalizeText(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts members by UTF-16 code units (section 3.2.3)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    const order = Object.values(JSON.parse(canonicalize(input)) as Record<string, string>);
    // JSON.parse would reorder integer-like keys, so check the text instead.
    const text = canonicalize(input);
    const positions = [
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ].map((v) => text.indexOf(v));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(order).toHaveLength(7);
    expect(text.startsWith('{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö"')).toBe(true);
  });

  // Appendix B: IEEE 754 binary64 values and their serialisation.
  const numbers: Array<[string, string]> = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  it.each(numbers)('serialises binary64 %s as %s', (hex, expected) => {
    expect(canonicalize(fromHex(hex))).toBe(expected);
  });

  it('refuses NaN and infinities', () => {
    expect(() => canonicalize(fromHex('7fffffffffffffff'))).toThrow(CanonicalizationError);
    expect(() => canonicalize(fromHex('7ff0000000000000'))).toThrow(CanonicalizationError);
  });

  it('refuses lone surrogates, undefined values and non-plain objects', () => {
    expect(() => canonicalize('\ud800')).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Date(0))).toThrow(CanonicalizationError);
    expect(() => canonicalize([1, undefined])).toThrow(CanonicalizationError);
  });

  it('writes nested structures without whitespace', () => {
    expect(canonicalize({ b: [1, { d: false, c: 'x' }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":"x","d":false}]}',
    );
  });
});
