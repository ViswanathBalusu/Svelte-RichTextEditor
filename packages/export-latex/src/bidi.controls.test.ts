/**
 * EXP-037 criterion 4 (Node.js only): the text emitter removes the bidirectional embedding,
 * override and isolate characters, so that display relies only on the implicit algorithm. The
 * emitter and the converter's `main.tex` are checked; nothing compiles here, so the display
 * itself is not checked (that needs a LuaLaTeX run, see the story's Notes).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { doc, para, run } from '../test/docs.ts';
import { clean, text } from './emit.ts';

/** U+202A to U+202E (LRE, RLE, PDF, LRO, RLO) and U+2066 to U+2069 (LRI, RLI, FSI, PDI). */
const OVERRIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const isOverride = (cp: number): boolean => OVERRIDE_RANGES.some(([a, b]) => cp >= a && cp <= b);

const OVERRIDES = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩'];
/** Implicit marks and right-to-left letters are not overrides and are kept. */
const KEPT = ['‎', '‏', 'م', 'ש', 'a', 'b', ' '];

const sample = fc
  .array(fc.constantFrom(...OVERRIDES, ...KEPT), { maxLength: 60 })
  .map((a) => a.join(''));

/** The code points of a string that are overrides or isolates. */
function overridesIn(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isOverride(cp)) out.push(cp);
  }
  return out;
}

describe('EXP-037 criterion 4: the text emitter removes overrides and isolates', () => {
  it('emits no embedding, override or isolate character for any input (property)', () => {
    fc.assert(
      fc.property(sample, (s) => {
        expect(overridesIn(String(text(s)))).toEqual([]);
      }),
      { numRuns: 1000 },
    );
  });

  it('drops only the controls: the cleaned string keeps every other character', () => {
    fc.assert(
      fc.property(sample, (s) => {
        const stripped = [...s].filter((ch) => !isOverride(ch.codePointAt(0)!)).join('');
        expect(clean(s)).toBe(stripped.normalize('NFC'));
      }),
      { numRuns: 500 },
    );
  });

  it('writes no override into main.tex for a document with Arabic and Hebrew text and overrides', async () => {
    const withControls = `‮مرحبا⁧שלום⁩ end‬`;
    const plain = `مرحبا שלום end`;
    const bundle = await run(doc([para(withControls), para(plain)]));
    const main = bundle.files['main.tex']!;
    expect(overridesIn(main)).toEqual([]);
    expect(main).toContain('مرحبا');
    expect(main).toContain('שלום');
  });

  it('keeps the letters when overrides are inserted before each word (property)', async () => {
    const base = 'مرحبا שלום end';
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...OVERRIDES), { minLength: 1, maxLength: 6 }),
        async (controls) => {
          const decorated = base
            .split(' ')
            .map((p, i) => `${controls[i % controls.length]}${p}`)
            .join(' ');
          const bundle = await run(doc([para(decorated)]));
          const main = bundle.files['main.tex']!;
          expect(overridesIn(main)).toEqual([]);
          // The runs are split where a control was removed, so the words are checked one by one.
          for (const word of base.split(' ')) expect(main).toContain(word);
        },
      ),
      { numRuns: 20 },
    );
  });
});
