/**
 * CDM-043 criterion 5 on the LaTeX side, for the two-paragraph cases of the shared fixture
 * `packages/model/fixtures/semantics/paragraph-spacing.json` (`pairs`). Each pair is converted as a
 * body of two paragraphs with the fixture's styles and resolved values; the gap between them is the
 * one `\DEgap` in main.tex, and it must equal the fixture's expected gap (twips, written by `dimen`).
 * Pairs with a container edge, a table or a footnote are not run here. Nothing compiles: the gaps in
 * the PDF are not measured. Node.js only.
 * Evidence: `pnpm exec vitest run packages/export-latex/src/cdm-043-fixtures.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, para, run, type J } from '../test/docs.ts';
import { dimen } from './emit.ts';

interface Side {
  readonly styleId: string;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly contextualSpacing: boolean;
}
interface Pair {
  readonly id: string;
  readonly above: Side | null;
  readonly below: Side | null;
  readonly expected: number;
}
interface Fixture {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly styles: readonly { readonly attrs: Readonly<Record<string, unknown>> }[];
  readonly pairs: readonly Pair[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../model/fixtures/semantics/paragraph-spacing.json', import.meta.url),
    ),
    'utf8',
  ),
) as Fixture;

const MAIN = 'main.tex';
const RANGE = { min: 0, max: 31680 };

/** The arguments of every `\DEgap{...}` in main.tex, in order. */
const gapsOf = (main: string): string[] =>
  [...main.matchAll(/\\DEgap\{([^}]*)\}/g)].map((m) => m[1]!);

/** A paragraph for one side of a pair: its style plus the resolved values as direct attributes. */
function paragraph(side: Side, text: string): J {
  return para(text, {
    style: side.styleId,
    spaceBefore: side.spaceBefore,
    spaceAfter: side.spaceAfter,
    contextualSpacing: side.contextualSpacing,
  });
}

const BODY_PAIRS = FIXTURE.pairs.filter(
  (p): p is Pair & { above: Side; below: Side } =>
    p.above !== null && p.below !== null && p.above.styleId !== 'FootnoteText',
);

describe('CDM-043 criterion 5, LaTeX side: paragraph-spacing.json pairs', () => {
  it('runs the six two-paragraph body pairs of the fixture', () => {
    expect(BODY_PAIRS.map((p) => p.id)).toEqual([
      'larger-of-the-two',
      'larger-of-the-two-after-wins',
      'contextual-same-style',
      'contextual-different-styles',
      'contextual-only-above',
      'contextual-only-below',
    ]);
  });

  for (const pair of BODY_PAIRS) {
    it(`pair "${pair.id}" writes the expected gap (${pair.expected} twips)`, async () => {
      const styles = FIXTURE.styles.map((s) => ({ type: 'style_def', attrs: s.attrs }));
      const body = [paragraph(pair.above, 'Above.'), paragraph(pair.below, 'Below.')];
      const bundle = await run(doc(body, { settings: FIXTURE.settings, styles }));
      const gaps = gapsOf(bundle.files[MAIN]!);
      if (pair.expected === 0) expect(gaps).toEqual([]);
      else expect(gaps).toEqual([String(dimen(pair.expected, RANGE))]);
    });
  }
});
