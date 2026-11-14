/**
 * The layout engine places the body of a page with a header or footer taller than its space, as the
 * shared fixtures of CDM-005 and CDM-045 say (`packages/model/fixtures/semantics/header-growth.json`),
 * in Node.js. This is the layout side of the body-start criterion; the LaTeX class side is not run
 * here (see the story's Notes).
 *
 * Lengths in the fixture are twips; the layout measures in points, so one twip is 1/20 pt. The test
 * checks where the first body line of the page starts. The footer's effect on the body end is not
 * checked: the layout does not expose the body bottom of a page.
 */
import { describe, expect, it } from 'vitest';
import headerFixtures from '../../model/fixtures/semantics/header-growth.json' with { type: 'json' };
import { type BreakOpportunities, breakParagraph } from './lines.ts';
import { type FontKey, fixedWidthMeasurer } from './measure.ts';
import { type PageItem, type PageSetup, paginate } from './paginate.ts';

/** Points per twip. */
const TWIP = 1 / 20;

interface Frame {
  readonly id: string;
  readonly pageSetup: Readonly<Record<string, number>>;
  readonly headerHeight: number;
  readonly footerHeight: number;
  readonly expected: { readonly top: number; readonly bottom?: number; readonly height?: number };
}

const frames = (headerFixtures as unknown as { readonly frames: readonly Frame[] }).frames;
const noBreaks: BreakOpportunities = { opportunities: () => [] };
const font: FontKey = { family: 'synthetic-serif', sizePt: 1, bold: false, italic: false };
const measurer = fixedWidthMeasurer({ emWidth: 0.5 });

/** The page setup of a fixture frame, with the defaults the fixture gives (A4, 1440, 708). */
function setupOf(p: Readonly<Record<string, number>>): PageSetup {
  const twips = (k: string, d: number): number => (p[k] ?? d) * TWIP;
  return {
    width: twips('width', 11906),
    height: twips('height', 16838),
    margins: {
      top: twips('marginTop', 1440),
      bottom: twips('marginBottom', 1440),
      left: twips('marginLeft', 1440),
      right: twips('marginRight', 1440),
    },
    headerDistance: twips('headerDistance', 708),
    footerDistance: twips('footerDistance', 708),
  };
}

describe('header and footer growth, layout side of header-growth.json (CDM-045)', () => {
  it.each(frames.filter((f) => f.expected.height !== 0).map((f) => [f.id, f] as const))(
    'frame %s starts the body where the fixture says',
    (_id, f) => {
      const setup = setupOf(f.pageSetup);
      const fragment = breakParagraph(
        {
          blockId: f.id,
          runs: [{ text: 'x', font }],
          markFont: font,
          columnWidth: setup.width - setup.margins.left - setup.margins.right,
          line: { rule: 'multiple', factor: 1 },
        },
        measurer,
        noBreaks,
      );
      const item: PageItem = {
        kind: 'paragraph',
        fragment,
        spaceBefore: 0,
        spaceAfter: 0,
        keepNext: false,
        keepLines: false,
        pageBreakBefore: false,
        widowControl: false,
      };
      const headerHeight = f.headerHeight * TWIP;
      const footerHeight = f.footerHeight * TWIP;
      const pagination = paginate([item], {
        ...setup,
        headers: { default: () => ({ height: headerHeight, fragments: [] }) },
        footers: { default: () => ({ height: footerHeight, fragments: [] }) },
      });
      const page = pagination.pages[0]!;
      const body = page.fragments.find((g) => g.kind === 'paragraph');
      expect(body).toBeDefined();
      expect(body!.y / TWIP).toBeCloseTo(f.expected.top, 6);
    },
  );
});
