/**
 * EXP-111 (Node.js only): the converter writes the \DocumentMetadata line that switches tagging
 * and declares the PDF standard, for each `tagging` and `pdfStandard` option. This checks the
 * source the converter emits, not the PDF. Whether the PDF is tagged, passes veraPDF and reads in
 * the right order needs a LuaLaTeX compile and veraPDF (criteria 1 to 3, 5 and 6), which this
 * package does not run; see the story's Notes. Nothing here compiles.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run } from '../test/docs.ts';
import type { PdfStandard, Tagging } from './bundle.ts';

const TAGGINGS: readonly Tagging[] = ['on', 'draft', 'off', 'none'];
const STANDARDS: readonly PdfStandard[] = ['ua-2+a-4f', 'ua-2', 'a-4f', 'none'];

/** The \DocumentMetadata line of main.tex, or null when the converter writes none. */
function metadataLine(main: string): string | null {
  return main.split('\n').find((l) => l.startsWith('\\DocumentMetadata')) ?? null;
}

describe('EXP-111 criterion 1 (source): tagging on declares the chosen standard', () => {
  it('writes pdfstandard={ua-2,a-4f} and tagging=on for the default standard', async () => {
    const bundle = await run(doc([para('Text.')]), { tagging: 'on' });
    expect(metadataLine(bundle.files['main.tex']!)).toBe(
      '\\DocumentMetadata{lang=en-GB, pdfversion=2.0, pdfstandard={ua-2,a-4f}, tagging=on, testphase={table}}',
    );
    expect(bundle.diagnostics.some((d) => d.code === 'standard_needs_tagging')).toBe(false);
  });

  it.each([
    ['ua-2', 'pdfstandard=ua-2, '],
    ['a-4f', 'pdfstandard=a-4f, '],
  ] as const)('writes the %s standard as its own key', async (standard, key) => {
    const bundle = await run(doc([para('Text.')]), { tagging: 'on', pdfStandard: standard });
    expect(metadataLine(bundle.files['main.tex']!)).toContain(key);
    expect(metadataLine(bundle.files['main.tex']!)).toContain('tagging=on, testphase={table}}');
  });

  it('writes no standard key when pdfStandard is none, and still switches tagging on', async () => {
    const bundle = await run(doc([para('Text.')]), { tagging: 'on', pdfStandard: 'none' });
    expect(metadataLine(bundle.files['main.tex']!)).toBe(
      '\\DocumentMetadata{lang=en-GB, pdfversion=2.0, tagging=on, testphase={table}}',
    );
  });
});

describe('EXP-111 criterion 4 (source): tagging off and draft map to their own keys', () => {
  it('writes tagging=off for off, and tagging=draft for draft', async () => {
    const off = await run(doc([para('Text.')]), { tagging: 'off', pdfStandard: 'none' });
    const draft = await run(doc([para('Text.')]), { tagging: 'draft', pdfStandard: 'none' });
    expect(metadataLine(off.files['main.tex']!)).toContain('tagging=off, testphase={table}}');
    expect(metadataLine(draft.files['main.tex']!)).toContain('tagging=draft, testphase={table}}');
  });

  it('writes no \\DocumentMetadata line at all for none', async () => {
    const bundle = await run(doc([para('Text.')]), { tagging: 'none' });
    expect(metadataLine(bundle.files['main.tex']!)).toBeNull();
  });

  it('warns that PDF/UA-2 needs full tagging, and declares only PDF/A-4f, when tagging is not on', async () => {
    for (const tagging of ['off', 'draft'] as const) {
      const bundle = await run(doc([para('Text.')]), { tagging, pdfStandard: 'ua-2+a-4f' });
      expect(metadataLine(bundle.files['main.tex']!)).toContain('pdfstandard=a-4f, ');
      expect(metadataLine(bundle.files['main.tex']!)).not.toContain('ua-2');
      expect(bundle.diagnostics.map((d) => d.code)).toContain('standard_needs_tagging');
    }
  });
});

describe('EXP-111 (source): every combination of the options is written as its own line', () => {
  it('writes exactly one \\DocumentMetadata line for each tagging mode that is not none, and none otherwise', async () => {
    for (const tagging of TAGGINGS) {
      for (const pdfStandard of STANDARDS) {
        const bundle = await run(doc([para('Text.')]), { tagging, pdfStandard });
        const main = bundle.files['main.tex']!;
        const count = main.split('\n').filter((l) => l.startsWith('\\DocumentMetadata')).length;
        expect(count, `${tagging} / ${pdfStandard}`).toBe(tagging === 'none' ? 0 : 1);
        if (tagging !== 'none')
          expect(metadataLine(main)).toContain(`tagging=${tagging}, testphase={table}}`);
      }
    }
  });
});
