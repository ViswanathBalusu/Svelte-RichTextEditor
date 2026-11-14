/**
 * EXP-015 criterion 5 (Node.js only): given tagging `draft`, the document asks for draft tagging
 * and the class does not override it. This checks the source the converter writes, not a compile:
 * the preview job's choice of `draft` is made by its caller, and whether LuaLaTeX then takes the
 * draft path to save time is not run here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, para, run } from '../test/docs.ts';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');

/** The \DocumentMetadata line of main.tex, or null when the converter writes none. */
function metadataLine(main: string): string | null {
  return main.split('\n').find((l) => l.startsWith('\\DocumentMetadata')) ?? null;
}

describe('EXP-015 criterion 5: given tagging draft, the class is asked for draft tagging', () => {
  it('writes tagging=draft in the \\DocumentMetadata line for a draft job', async () => {
    const bundle = await run(doc([para('Preview text.')]), {
      tagging: 'draft',
      pdfStandard: 'none',
    });
    expect(metadataLine(bundle.files['main.tex']!)).toBe(
      '\\DocumentMetadata{lang=en-GB, pdfversion=2.0, tagging=draft, testphase={table}}',
    );
  });

  it('does not switch tagging on or off for a draft job', async () => {
    const bundle = await run(doc([para('Preview text.')]), {
      tagging: 'draft',
      pdfStandard: 'none',
    });
    const line = metadataLine(bundle.files['main.tex']!) ?? '';
    expect(line).not.toContain('tagging=on');
    expect(line).not.toContain('tagging=off');
  });

  it('leaves the choice of draft to the document: the class sets no tagging key of its own', () => {
    expect(CLASS).not.toMatch(/tagging\s*=/);
  });
});
