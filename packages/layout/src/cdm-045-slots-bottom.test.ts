/**
 * CDM-045 criterion 3, layout side, for the two parts of
 * `packages/model/fixtures/semantics/header-growth.json` that `cdm-045-header-growth.test.ts` does
 * not run (Node.js):
 *
 * - the body end of each frame (`bottom`): the page is filled with lines of half a point, and the
 *   last line the engine keeps on the first page must end at the fixture's bottom, to within one
 *   line (10 twips);
 * - the `slots` cases: which header and footer story a page shows, by whether it is the first page
 *   of its section and whether its number is even.
 *
 * The frame with no room for the body is not run: where its body goes is an open question (ADR 0353).
 */
import { describe, expect, it } from 'vitest';
import headerFixtures from '../../model/fixtures/semantics/header-growth.json' with { type: 'json' };
import { type BreakOpportunities, breakParagraph } from './lines.ts';
import { type FontKey, fixedWidthMeasurer } from './measure.ts';
import { type PageItem, type PageSetup, type StoryVariants, paginate } from './paginate.ts';

/** Points per twip. */
const TWIP = 1 / 20;
/** The height of one filling line, in points: 10 twips. */
const LINE = 0.5;

interface Frame {
  readonly id: string;
  readonly pageSetup: Readonly<Record<string, number>>;
  readonly headerHeight: number;
  readonly footerHeight: number;
  readonly expected: { readonly top: number; readonly bottom?: number; readonly height?: number };
}

interface SlotCase {
  readonly id: string;
  readonly description: string;
  readonly pageSetup: Readonly<Record<string, string | boolean>>;
  readonly pages: readonly {
    readonly firstOfSection: boolean;
    readonly even: boolean;
    readonly header: string | null;
    readonly footer: string | null;
  }[];
}

const fixture = headerFixtures as unknown as {
  readonly frames: readonly Frame[];
  readonly slots: readonly SlotCase[];
};
const noBreaks: BreakOpportunities = { opportunities: () => [] };
const font: FontKey = { family: 'synthetic-serif', sizePt: 1, bold: false, italic: false };
const measurer = fixedWidthMeasurer({ emWidth: 0.5 });

/** The page setup of a fixture frame, with the defaults the fixture gives (A4, 1440, 708). */
function setupOf(p: Readonly<Record<string, unknown>>): PageSetup {
  const twips = (k: string, d: number): number => (typeof p[k] === 'number' ? p[k] : d) * TWIP;
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

/** A one-line paragraph of height `LINE`, named `blockId`. */
function line(blockId: string, setup: PageSetup, pageBreakBefore = false): PageItem {
  return {
    kind: 'paragraph',
    fragment: breakParagraph(
      {
        blockId,
        runs: [{ text: 'x', font }],
        markFont: font,
        columnWidth: setup.width - setup.margins.left - setup.margins.right,
        line: { rule: 'exact', pt: LINE },
      },
      measurer,
      noBreaks,
    ),
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
    keepLines: false,
    pageBreakBefore,
    widowControl: false,
  };
}

describe('the body end of header-growth.json frames, layout side (CDM-045)', () => {
  // Frames that give a bottom and leave room for the body.
  const withBottom = fixture.frames.filter(
    (f): f is Frame & { expected: { top: number; bottom: number } } =>
      typeof f.expected.bottom === 'number' && f.expected.height !== 0,
  );

  it('runs the frames that state a body end', () => {
    expect(withBottom.length).toBeGreaterThan(0);
  });

  it.each(withBottom.map((f) => [f.id, f] as const))(
    'frame %s ends the body where the fixture says',
    (_id, f) => {
      const setup = setupOf(f.pageSetup);
      // More lines than the tallest body holds, so the first page is full.
      const count = Math.ceil((setup.height / LINE) * 1.1);
      const items = Array.from({ length: count }, (_x, i) => line(`l${i}`, setup));
      const pagination = paginate(items, {
        ...setup,
        headers: { default: () => ({ height: f.headerHeight * TWIP, fragments: [] }) },
        footers: { default: () => ({ height: f.footerHeight * TWIP, fragments: [] }) },
      });
      const lines = pagination.pages[0]!.fragments.filter((g) => g.kind === 'paragraph');
      expect(pagination.pages.length).toBeGreaterThan(1);
      const first = lines[0]!;
      const last = lines[lines.length - 1]!;
      expect(first.y / TWIP).toBeCloseTo(f.expected.top, 6);
      const end = (last.y + LINE) / TWIP;
      // The last line ends at or above the bottom, and one more line would not fit.
      expect(end).toBeLessThanOrEqual(f.expected.bottom + 1e-6);
      expect(end + LINE / TWIP).toBeGreaterThan(f.expected.bottom + 1e-6);
      // The lines kept fill the fixture's body height, to within one line.
      if (typeof f.expected.height === 'number')
        expect(lines.length).toBe(Math.floor((f.expected.height + 1e-6) / (LINE / TWIP)));
    },
  );
});

describe('which story a page shows, layout side of header-growth.json slots (CDM-045)', () => {
  /** A story that lays out one fragment named after the story, so a page says which one it shows. */
  const story = (id: unknown, setup: PageSetup) =>
    typeof id === 'string'
      ? () => {
          const item = line(id, setup);
          if (item.kind !== 'paragraph') throw new Error('not a paragraph');
          return { height: LINE, fragments: [{ ...item.fragment, y: 0 }] };
        }
      : undefined;

  const variants = (
    p: SlotCase['pageSetup'],
    kind: 'header' | 'footer',
    setup: PageSetup,
  ): StoryVariants => {
    const out: { default?: unknown; first?: unknown; even?: unknown } = {};
    for (const [slot, name] of [
      ['default', 'Default'],
      ['first', 'First'],
      ['even', 'Even'],
    ] as const) {
      const f = story(p[`${kind}${name}`], setup);
      if (f) out[slot] = f;
    }
    return out as StoryVariants;
  };

  /** The story a page shows, from the fragment its header or footer holds. */
  const shown = (fragments: readonly { readonly blockId?: string }[]): string | null =>
    fragments[0]?.blockId ?? null;

  for (const c of fixture.slots)
    it(`${c.id}: ${c.description}`, () => {
      const base = setupOf({});
      const setup: PageSetup = {
        ...base,
        headers: variants(c.pageSetup, 'header', base),
        footers: variants(c.pageSetup, 'footer', base),
        differentFirstPage: c.pageSetup['differentFirstPage'] === true,
        differentOddEven: c.pageSetup['differentOddEven'] === true,
      };
      // Three pages: the first of the section, then two more, so both parities occur after it.
      const items = [line('a', base), line('b', base, true), line('c', base, true)];
      for (const page of c.pages) {
        // A first page is even when numbering starts at 2; later pages take the parity wanted.
        const start = page.firstOfSection ? (page.even ? 2 : 1) : 1;
        const index = page.firstOfSection ? 0 : page.even ? 1 : 2;
        const made = paginate(items, { ...setup, pageNumberStart: start }).pages[index]!;
        expect(shown(made.header), 'header').toBe(page.header);
        expect(shown(made.footer), 'footer').toBe(page.footer);
      }
    });
});
