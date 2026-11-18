/**
 * The layout engine runs the shared line-spacing fixtures of CDM-005 and CDM-043
 * (`packages/model/fixtures/semantics/line-spacing.json`), in Node.js. This is the layout side of
 * the line-height criterion; the LaTeX class side is not run here (see the story's Notes).
 *
 * The fixtures give each run's natural height in twips. Each run gets its own font family whose
 * ascent is that height, so the natural height of the run is the fixture's height in points (one
 * twip is 1/20 pt). A `multiple` height is rounded half up to whole twips (owner decision 78), so the
 * layout's heights equal the fixture's.
 */
import { describe, expect, it } from 'vitest';
import lineFixtures from '../../model/fixtures/semantics/line-spacing.json' with { type: 'json' };
import { breakParagraph, type BreakOpportunities, type LineSpacing } from './lines.ts';
import type { FontKey, TextMeasurer } from './measure.ts';

/** Points per twip. */
const TWIP = 1 / 20;

interface LineCase {
  readonly id: string;
  readonly lineSpacing: number;
  readonly lineRule: 'multiple' | 'exact' | 'atLeast';
  readonly runs: readonly number[];
  readonly expected: number;
}

const cases = (lineFixtures as unknown as { readonly cases: readonly LineCase[] }).cases;
const noBreaks: BreakOpportunities = { opportunities: () => [] };

/** A face whose ascent is the run height in its family name, `h<twips>`, and no other metric. */
const measurer: TextMeasurer = {
  id: 'cdm-043-line-heights',
  advance: (font, text) => text.length * TWIP * font.sizePt,
  lineMetrics: (font) => ({ ascent: Number(font.family.slice(1)) * TWIP, descent: 0, lineGap: 0 }),
};

function fontFor(twips: number): FontKey {
  return { family: `h${twips}`, sizePt: 1, bold: false, italic: false };
}

function spacingOf(c: LineCase): LineSpacing {
  if (c.lineRule === 'multiple') return { rule: 'multiple', factor: c.lineSpacing / 1000 };
  return { rule: c.lineRule, pt: c.lineSpacing * TWIP };
}

describe('line heights, layout side of line-spacing.json (CDM-043)', () => {
  it.each(cases.map((c) => [c.id, c] as const))('case %s has the fixture height', (_id, c) => {
    const runs = c.runs.map((h) => ({ text: 'x', font: fontFor(h) }));
    const fragment = breakParagraph(
      {
        blockId: c.id,
        runs,
        markFont: fontFor(c.runs[0] ?? 0),
        columnWidth: 1_000_000,
        line: spacingOf(c),
      },
      measurer,
      noBreaks,
    );
    expect(fragment.lines).toHaveLength(1);
    const twips = fragment.lines[0]!.height / TWIP;
    expect(twips).toBeCloseTo(c.expected, 6);
  });
});
