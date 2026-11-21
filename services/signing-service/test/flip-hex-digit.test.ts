// The helper that the seal tests use to change one digit of a signature's hex string. `flipByte`
// turned `a` and `f` into characters that are not hex, so the verifier failed on the CMS (a flaky
// SPK-021 test: the signature is different on each run).
import { describe, expect, it } from 'vitest';
import { flipByte, flipHexDigit } from './support/world.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('flipHexDigit', () => {
  it('turns every hex digit into a different hex digit, keeping its case', () => {
    for (const c of '0123456789abcdefABCDEF') {
      const out = text(flipHexDigit(bytes(`<${c}>`), 1)).slice(1, 2);
      expect(out, c).not.toBe(c);
      expect(out, c).toMatch(/^[0-9a-fA-F]$/);
    }
    expect(text(flipHexDigit(bytes('<a>'), 1))).toBe('<b>');
    expect(text(flipHexDigit(bytes('<F>'), 1))).toBe('<E>');
    expect(text(flipHexDigit(bytes('<9>'), 1))).toBe('<8>');
  });

  it('is its own inverse and changes one byte only', () => {
    const pdf = bytes('<00a1ff>');
    const once = flipHexDigit(pdf, 3);
    expect(once.length).toBe(pdf.length);
    expect(Array.from(once).filter((b, i) => b !== pdf[i])).toHaveLength(1);
    expect(text(flipHexDigit(once, 3))).toBe('<00a1ff>');
  });

  it('refuses a byte that is not a hex digit', () => {
    expect(() => flipHexDigit(bytes('<g>'), 1)).toThrow(/not a hex digit/);
  });

  it('shows why flipByte is not used there: it leaves hex for two digits in sixteen', () => {
    const bad = Array.from('0123456789abcdef').filter(
      (c) => !/^[0-9a-f]$/.test(text(flipByte(bytes(c), 0))),
    );
    expect(bad).toEqual(['a', 'f']);
  });
});
