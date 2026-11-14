/**
 * The layout engine runs the shared tab-stop fixtures of CDM-005 and CDM-044
 * (`packages/model/fixtures/semantics/tabs.json`), in Node.js. This is the layout side of the
 * criterion; the LaTeX class side is not run here (see the story's Notes).
 *
 * The fixtures are in twips. The layout measures in points, so one twip is 1/20 pt, and a character
 * of the test text is one twip wide (`fixedWidthMeasurer` with `emWidth` 1/20 at 1 pt). A fixture
 * `x` becomes a prefix of that many characters, so the tab falls at the fixture's position.
 */
import { describe, expect, it } from 'vitest';
import tabsFixtures from '../../model/fixtures/semantics/tabs.json' with { type: 'json' };
import { type BreakOpportunities, breakParagraph } from './lines.ts';
import { type FontKey, fixedWidthMeasurer } from './measure.ts';

interface Segment {
  readonly text?: string;
  readonly width?: number;
  readonly beforeDecimal?: number;
}

interface TabCase {
  readonly id: string;
  readonly tabs: readonly {
    readonly position: number;
    readonly align: 'left' | 'center' | 'right' | 'decimal';
    readonly leader: string;
  }[];
  readonly indentLeft?: number;
  readonly indentFirstLine?: number;
  readonly x: number;
  readonly segment?: Segment;
  readonly expected: {
    readonly position: number;
    readonly start?: number;
    readonly source: string;
  };
}

interface TabFile {
  readonly defaultTabStop: number;
  readonly cases: readonly TabCase[];
}

/** Points per twip. */
const TWIP = 1 / 20;
const file = tabsFixtures as unknown as TabFile;
const noBreaks: BreakOpportunities = { opportunities: () => [] };
const measurer = fixedWidthMeasurer({ emWidth: TWIP });
const font: FontKey = { family: 'synthetic-serif', sizePt: 1, bold: false, italic: false };

/** The segment's text: `w` characters, one twip each, with a full stop after `beforeDecimal`. */
function segmentText(seg: Segment | undefined): { text: string; width: number } {
  const width = seg?.width ?? 1;
  if (seg?.text?.includes('.') && seg.beforeDecimal !== undefined) {
    return {
      text: `${'w'.repeat(seg.beforeDecimal)}.${'w'.repeat(width - seg.beforeDecimal - 1)}`,
      width,
    };
  }
  return { text: 'w'.repeat(width), width };
}

describe('tab stops, layout side of tabs.json (CDM-044)', () => {
  it.each(file.cases.map((c) => [c.id, c] as const))(
    'case %s ends where the fixture says',
    (_id, c) => {
      const indentLeft = c.indentLeft ?? 0;
      const indentFirst = c.indentFirstLine ?? 0;
      const startTwips = indentLeft + indentFirst;
      const prefix = c.x - startTwips;
      expect(prefix).toBeGreaterThanOrEqual(0);
      const seg = segmentText(c.segment);
      const fragment = breakParagraph(
        {
          blockId: c.id,
          runs: [{ text: `${'w'.repeat(prefix)}\t${seg.text}`, font }],
          markFont: font,
          columnWidth: 1_000_000 * TWIP,
          indentLeft: indentLeft * TWIP,
          indentFirstLine: indentFirst * TWIP,
          line: { rule: 'multiple', factor: 1 },
          tabStops: c.tabs.map((t) => ({ position: t.position * TWIP, align: t.align })),
          defaultTabStop: file.defaultTabStop * TWIP,
        },
        measurer,
        noBreaks,
      );
      expect(fragment.lines).toHaveLength(1);
      const line = fragment.lines[0]!;
      const endTwips = (line.x + line.width) / TWIP;
      const expectedStart = c.expected.start ?? c.expected.position;
      expect(endTwips).toBeCloseTo(expectedStart + seg.width, 6);
    },
  );
});
