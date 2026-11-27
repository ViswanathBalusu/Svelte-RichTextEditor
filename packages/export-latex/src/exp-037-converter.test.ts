/**
 * EXP-037 (converter side, Node.js, no compile): what the converter writes for right-to-left
 * paragraphs and for runs of a script that needs shaping. The compiled result is in
 * `exp-037-rtl.compile.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { codes, doc, para, run } from '../test/docs.ts';
import { hasComplexScript, needsShaping, scriptOf, scriptRuns } from './fonts/scripts.ts';

const HE = 'שלום';
const AR = 'مرحبا';
const HI = 'क्षत्रिय';

describe('EXP-037 criterion 1: the converter marks right-to-left paragraphs', () => {
  it('writes \\DEdir{1} for a paragraph of dir rtl, asks for the bidirectional algorithm and loads babel', async () => {
    const b = await run(doc([para(HE, { dir: 'rtl' }), para('Plain')]));
    const main = String(b.files['main.tex']);
    expect(main).toContain('\\DEbidi');
    expect(main.indexOf('\\DEbidi')).toBeLessThan(main.indexOf('\\DEbabel'));
    expect(main).toMatch(/\\DEdir\{1\}/u);
    expect(codes(b)).not.toContain('rtl_unsupported');
  });

  it('writes it in the style macro when settings.dir is rtl, and \\DEdir{0} for a paragraph that sets it back', async () => {
    const b = await run(
      doc([para(HE), para('Plain', { dir: 'ltr' })], { settings: { dir: 'rtl' } }),
    );
    const all = String(b.files['main.tex']) + String(b.files['styles.tex']);
    expect(all).toMatch(/\\DEdir\{1\}/u);
    expect(all).toMatch(/\\DEdir\{0\}/u);
    expect(String(b.files['main.tex'])).toContain('\\DEbidi');
  });

  it('writes nothing of it for a left-to-right document', async () => {
    const b = await run(doc([para('Plain text'), para(HE)]));
    const all = String(b.files['main.tex']) + String(b.files['styles.tex']);
    expect(all).not.toContain('\\DEbidi');
    expect(all).not.toContain('\\DEdir');
  });
});

describe('EXP-037 criterion 2: scripts that need shaping', () => {
  it('knows which characters need a shaping engine', () => {
    expect(needsShaping(AR)).toBe(true);
    expect(needsShaping(HI)).toBe(true);
    expect(needsShaping('ส')).toBe(true);
    expect(needsShaping(HE)).toBe(false);
    expect(needsShaping('Latin 文字 한국어')).toBe(false);
    expect(hasComplexScript({ a: [{ b: `x ${AR}` }] })).toBe(true);
    expect(hasComplexScript({ a: [{ b: 'x' }], c: 3 })).toBe(false);
    expect(scriptOf(0x0915)).toBe('Devanagari');
    expect(scriptOf(0x0627)).toBe('Arabic');
    expect(scriptOf(0x41)).toBeNull();
  });

  it('splits a string into runs of one script, with joiners kept inside', () => {
    const value = `ab${HI}cd${AR}${HI}‍${HI}`;
    const runs = scriptRuns(value);
    expect(runs.map((r) => [value.slice(r.start, r.end), r.script])).toEqual([
      [HI, 'Devanagari'],
      [AR, 'Arabic'],
      [`${HI}‍${HI}`, 'Devanagari'],
    ]);
    expect(scriptRuns('plain')).toEqual([]);
  });

  it('has no \\DEscr in a document without such a script', async () => {
    const b = await run(doc([para(`Plain ${HE}`)]));
    expect(String(b.files['main.tex'])).not.toContain('\\DEscr');
  });
});
