/**
 * EXP-115 criterion 3 and the guard behind criterion 4: every shared fixture file of
 * `packages/model/fixtures/semantics` has a registered LaTeX runner, each runner's test titles
 * name the fixture and the writer, and a new fixture file fails this test until a runner is
 * registered for it.
 *
 * A failing runner reports as `packages/export-latex/src/<file> > <title>`: the path names the
 * writer (`export-latex`) and the title names the fixture, as `[<fixture> x LaTeX] <case>` in the
 * runners of EXP-115 and as `<fixture>.json` in the earlier ones (CDM-041 to CDM-045). This test
 * checks that each registered runner exists and carries that naming in its source. It does not
 * compile anything and runs in the plain Node.js suite.
 *
 * The DOCX writer is not registered: it counts list labels itself in Word (ADR 0032, CDM-005
 * Notes) and its runner is EXP-090 criterion 6.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { semanticsFiles } from '../test/exp-115-fixtures.ts';

interface Runner {
  /** Runner source files in this directory. */
  readonly files: readonly string[];
  /** What each file must contain to name the fixture in a test title. */
  readonly naming: 'x LaTeX]' | 'json';
  /** Where the runner does not cover the whole fixture, or has no runner, and why. */
  readonly note?: string;
}

const REGISTRY: Readonly<Record<string, Runner>> = {
  cascade: {
    files: ['cdm-041-converter-fixtures.test.ts', 'cdm-041-cascade-fixtures.test.ts'],
    naming: 'json',
    note: 'Converter output and resolver, not a PDF (CDM-041).',
  },
  'date-fields': { files: ['exp-115-date-fields.compile.test.ts'], naming: 'x LaTeX]' },
  'header-growth': {
    files: ['cdm-045-header-growth.test.ts'],
    naming: 'json',
    note: 'Body start of the frames with room; not the body end, the slots, or the frame with no room (CDM-045 Notes).',
  },
  'line-spacing': { files: ['exp-115-line-spacing.compile.test.ts'], naming: 'x LaTeX]' },
  'numbering-footnotes': { files: ['exp-115-numbering.compile.test.ts'], naming: 'x LaTeX]' },
  'numbering-lists': { files: ['exp-115-numbering.compile.test.ts'], naming: 'x LaTeX]' },
  'numbering-projections': {
    files: [],
    naming: 'json',
    note: 'A projection with hidden regions is the export as the requester (EXP-123); the LaTeX writer takes the labels of the projected document, which the numbering-lists runner covers.',
  },
  'numbering-references': { files: ['exp-115-numbering.compile.test.ts'], naming: 'x LaTeX]' },
  'numbering-sequences': { files: ['exp-115-numbering.compile.test.ts'], naming: 'x LaTeX]' },
  'paragraph-spacing': {
    files: ['cdm-043-gap-compile.test.ts', 'exp-115-paragraph-spacing.compile.test.ts'],
    naming: 'json',
  },
  tabs: { files: ['cdm-044-tabs.test.ts'], naming: 'json' },
  whitespace: {
    files: [],
    naming: 'json',
    note: 'Not in the EXP-115 list (numbering, spacing, line spacing, header growth, tabs, field dates); kept spaces are the `spaceRuns` rule of the converter (EXP-011).',
  },
};

const DIR = fileURLToPath(new URL('.', import.meta.url));

describe('EXP-115: every shared fixture file has a registered LaTeX runner', () => {
  it('registers exactly the fixture files of packages/model/fixtures/semantics', () => {
    expect(
      Object.keys(REGISTRY).sort(),
      'add a runner for the new fixture file, or say why none',
    ).toEqual(semanticsFiles());
  });

  for (const [name, runner] of Object.entries(REGISTRY)) {
    it(`[${name} x LaTeX] the runners exist and name the fixture and the writer`, () => {
      expect(
        runner.files.length > 0 || runner.note !== undefined,
        'a fixture without a runner says why',
      ).toBe(true);
      for (const file of runner.files) {
        const source = readFileSync(`${DIR}${file}`, 'utf8');
        if (runner.naming === 'json')
          expect(source, `${file} names ${name}.json in a title`).toContain(`${name}.json`);
        else expect(source, `${file} names the writer in its test titles`).toContain('x LaTeX]');
        // The fixture is loaded by name in the runner.
        expect(source).toMatch(new RegExp(`${name}(\\.json|')`));
      }
    });
  }
});
