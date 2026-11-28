/**
 * EXP-115 criterion 3 and the guard behind criterion 4, DOCX side: every shared fixture file of
 * `packages/model/fixtures/semantics` has a registered DOCX runner or says why it has none, each
 * runner's test titles name the fixture and the writer, and a new fixture file fails this test
 * until a runner is registered for it. The LaTeX side is `packages/export-latex/src/exp-115-registry.test.ts`.
 *
 * A failing runner reports as `packages/export-docx/test/<file> > <title>`: the path names the
 * writer (`export-docx`) and the title names the fixture, as `[<fixture> x DOCX] <case>` in the
 * runners of EXP-115 and as `<fixture>.json` in the earlier ones (CDM-041, CDM-042). This test
 * checks that each registered runner exists and carries that naming in its source. It runs no
 * writer and no Word, so it runs in the plain Node.js suite in CI.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEMANTICS_DIR } from './exp-115-word.ts';

interface Runner {
  /** Runner source files in this directory. */
  readonly files: readonly string[];
  /** What each file must contain to name the fixture in a test title. */
  readonly naming: 'x DOCX]' | 'json';
  /** Where the runner does not cover the whole fixture, or has no runner, and why. */
  readonly note?: string;
}

const NO_CI = 'Needs Microsoft Word on Windows: the runner is skipped in CI.';

const REGISTRY: Readonly<Record<string, Runner>> = {
  cascade: {
    files: ['cdm-041-word-cascade.test.ts', '../src/cdm-041-cascade-fixtures.test.ts'],
    naming: 'json',
    note: `Word's own resolved values for each case (CDM-041 criterion 7). ${NO_CI}`,
  },
  'date-fields': { files: ['exp-115-date-fields.docx.test.ts'], naming: 'x DOCX]' },
  'header-growth': {
    files: ['exp-115-header-growth.word.test.ts'],
    naming: 'x DOCX]',
    note: `Frames: the top of the body and the lines that fit, read from Word's PDF; the one-twip case is below Word's text grid. Slots: the header and footer printed on five pages. Word starts the body on page 1 where the fixture (decision 77) says page 2 (listed in the runner). ${NO_CI}`,
  },
  'line-spacing': {
    files: ['exp-115-line-spacing.word.test.ts'],
    naming: 'x DOCX]',
    note: `Line heights read from Word's PDF against the rule with Word's own natural heights, and the fixture's numbers where the rule does not depend on a natural height; the inline picture differs (listed in the runner). ${NO_CI}`,
  },
  'numbering-footnotes': {
    files: ['exp-115-numbering.word.test.ts'],
    naming: 'x DOCX]',
    note: NO_CI,
  },
  'numbering-lists': {
    files: ['exp-115-numbering.word.test.ts'],
    naming: 'x DOCX]',
    note: `cdm-042-native-numbering.test.ts counts the labels with a model of Word and runs in CI (its own titles name the file); the runner here lays the cases out in Word. ${NO_CI}`,
  },
  'numbering-projections': {
    files: [],
    naming: 'json',
    note: 'A projection with hidden regions is the export as the requester (EXP-123); the writer takes the labels of the projected document, which the numbering-lists runner covers.',
  },
  'numbering-references': {
    files: ['exp-115-numbering.word.test.ts'],
    naming: 'x DOCX]',
    note: NO_CI,
  },
  'numbering-sequences': {
    files: ['exp-115-numbering.word.test.ts'],
    naming: 'x DOCX]',
    note: NO_CI,
  },
  'paragraph-spacing': {
    files: ['exp-115-paragraph-spacing.word.test.ts'],
    naming: 'x DOCX]',
    note: `The pairs and the flows' body and cell gaps, read from Word's PDF; the footnote and story containers and trailing gaps are not measured, and one pair differs (both listed in the runner). ${NO_CI}`,
  },
  tabs: {
    files: ['exp-115-tabs.word.test.ts'],
    naming: 'x DOCX]',
    note: `Segment positions read from Word's PDF for all 17 cases, no leader dots measured; one case differs (listed in the runner). ${NO_CI}`,
  },
  whitespace: {
    files: [],
    naming: 'json',
    note: 'Not in the EXP-115 list; kept spaces are the `xml:space` rule of the writer (EXP-090).',
  },
};

const DIR = fileURLToPath(new URL('.', import.meta.url));

describe('EXP-115: every shared fixture file has a registered DOCX runner', () => {
  it('registers exactly the fixture files of packages/model/fixtures/semantics', () => {
    const files = readdirSync(SEMANTICS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
    expect(
      Object.keys(REGISTRY).sort(),
      'add a runner for the new fixture file, or say why none',
    ).toEqual(files);
  });

  for (const [name, runner] of Object.entries(REGISTRY)) {
    it(`[${name} x DOCX] the runners exist and name the fixture and the writer`, () => {
      expect(
        runner.files.length > 0 || runner.note !== undefined,
        'a fixture without a runner says why',
      ).toBe(true);
      for (const file of runner.files) {
        const source = readFileSync(new URL(file, `file://${DIR.replace(/\\/g, '/')}`), 'utf8');
        if (runner.naming === 'x DOCX]')
          expect(source, `${file} names the fixture and the writer in its titles`).toContain(
            'x DOCX]',
          );
        else expect(source, `${file} names the fixture file`).toContain(`${name}.json`);
      }
    });
  }
});
