/**
 * CDM-045 criterion 3, LaTeX side: the class places the body start of the shared header-growth
 * fixture (`packages/model/fixtures/semantics/header-growth.json`) where the fixture says. Each
 * header frame is a document whose header story is one paragraph with an exact line height of the
 * frame's `headerHeight` (twips), so the header's height is what the frame gives. The first body
 * node of page 1 reports its vertical position in `main.layout` (`pages[0].start.y`, scaled points
 * from the top edge). The test compares the position with a reference document of the same page
 * setup and no header: the difference must be the fixture's `top` minus the page's top margin.
 * Comparing differences removes the constant offset of the baseline, so it needs no font metrics.
 *
 * Node.js only, and local: the sandbox cannot start here, so `test/cdm-local-tex.ts` runs
 * `lualatex` on this machine (skipped when `DOCEDIT_LUALATEX` or `lualatex` does not start).
 * Every frame with a `top` is run, footers included (a footer story of its own exact height). The
 * body's end (`bottom`, `height`) is not run: the layout report has no end of the body. A frame with
 * no room for the body (`nothing-left-for-the-body`) is read on the first page that has a body
 * start (see `noRoom`). The layout side is `packages/layout/src/cdm-045-header-growth.test.ts`.
 * Evidence: `pnpm exec vitest run packages/export-latex/src/cdm-045-header-growth.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import headerGrowth from '../../model/fixtures/semantics/header-growth.json' with { type: 'json' };
import { doc, para, type J } from '../test/docs.ts';
import { compileLocal, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';

interface Frame {
  readonly id: string;
  readonly pageSetup: Readonly<Record<string, number | boolean>>;
  readonly headerHeight: number;
  readonly footerHeight: number;
  readonly expected: {
    readonly top?: number;
    readonly height?: number;
    readonly headerPushes?: boolean;
  };
}

/**
 * Scaled points per twip. A twip is 1/20 bigpoint, 1/1440 inch (the model's convention, and the
 * class's: class/docedit.lua, `SP_PER_TWIP = 65781.76 / 20`), not 1/20 TeX point.
 */
const SP_PER_TWIP = 65781.76 / 20;
/** Tolerance in twips: TeX works in scaled points, so one twip of rounding is allowed. */
const TOL_TWIPS = 1;

const A4: Record<string, number> = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 708,
  footerDistance: 708,
};

/** The frames that give where the body starts (`top`); footers only move the body's end. */
const FRAMES = (headerGrowth as unknown as { frames: Frame[] }).frames.filter(
  (f) => f.expected.top !== undefined,
);

/**
 * Whether the frame leaves the body no room (`height` 0). ADR 0032 §6 gives the frame's `top` and
 * leaves the rest to pagination: no line fits, so TeX ships page 1 with an empty body and sets the
 * first line on page 2, at the same frame top. For these frames the test reads the body start on
 * the first page that has one and checks that it is a later page; the frame top is checked as for
 * the others. The layout side does not run these frames (`expected.height !== 0`).
 */
const noRoom = (f: Frame): boolean => f.expected.height === 0;

/**
 * A document with the page setup, an optional header and footer story of one exact-height line
 * each, and a body. The stories are the frame's measured heights, so the class measures the same.
 */
function document(
  setup: Record<string, number | boolean>,
  headerTwips: number,
  footerTwips = 0,
): unknown {
  const attrs = { id: 'ps1', ...A4, ...setup };
  const stories: J[] = [];
  const slots: Record<string, string> = {};
  if (headerTwips > 0) {
    stories.push({
      type: 'story',
      attrs: { id: 'h1' },
      content: [para('Header.', { lineRule: 'exact', lineSpacing: headerTwips })],
    });
    slots['headerDefault'] = 'h1';
  }
  if (footerTwips > 0) {
    stories.push({
      type: 'story',
      attrs: { id: 'f1' },
      content: [para('Footer.', { lineRule: 'exact', lineSpacing: footerTwips })],
    });
    slots['footerDefault'] = 'f1';
  }
  return doc([para('Body start.')], {
    pageSetups: [{ type: 'page_setup', attrs: { ...attrs, ...slots } }],
    stories,
  });
}

/**
 * The scaled-point y of the first body node, and the index of its page, from the class's layout
 * report: on page 1, or with `anyPage` on the first page that has a body start.
 */
function bodyStart(layout: string | null, anyPage = false): { page: number; y: number } {
  if (!layout) throw new Error('the class wrote no layout report');
  // `start` is [block, offset, y] (docedit.finish in class/docedit.lua).
  const report = JSON.parse(layout) as { pages: { start?: [number, number, number] }[] };
  const pages = anyPage ? report.pages : report.pages.slice(0, 1);
  const page = pages.findIndex((p) => p.start !== undefined);
  const y = pages[page]?.start?.[2];
  if (y === undefined)
    throw new Error(`the layout report has no body start: ${layout.slice(0, 300)}`);
  return { page, y };
}

/** The convert options of the compile tests (as in the export worker's tests, EXP-018). */
const OPTIONS = (title: string) => ({
  profile: 'preview',
  title,
  instant: '2026-11-06T10:00:00.000Z',
  timeZone: 'Europe/London',
  suggestions: 'accept',
  layout: 'block',
});

const ready = lualatexAvailable();

describe.skipIf(!ready)('CDM-045 criterion 3, LaTeX side: header-growth.json body starts', () => {
  const refs = new Map<string, number>();

  /** The body start with no header, for one page setup (the reference of the frame's offset). */
  async function referenceFor(setup: Record<string, number | boolean>): Promise<number> {
    const key = JSON.stringify(setup);
    const known = refs.get(key);
    if (known !== undefined) return known;
    const bundle = await convertLocal(document(setup, 0) as never, OPTIONS('cdm-045-ref') as never);
    const c = compileLocal(bundle, 'ref');
    if (!c.ok) throw new Error(`the reference compile failed (${c.dir}):\n${c.log.slice(-1500)}`);
    const { y } = bodyStart(c.layout);
    refs.set(key, y);
    return y;
  }

  for (const frame of FRAMES) {
    it(`frame "${frame.id}" places the body start where the fixture says`, async () => {
      const setup = { ...frame.pageSetup };
      const marginTop = Number(setup['marginTop'] ?? A4['marginTop']);
      const reference = await referenceFor(setup as Record<string, number>);
      const bundle = await convertLocal(
        document(setup, frame.headerHeight, frame.footerHeight) as never,
        OPTIONS(`cdm-045-${frame.id}`) as never,
      );
      const c = compileLocal(bundle, frame.id);
      if (!c.ok) throw new Error(`the compile failed (${c.dir}):\n${c.log.slice(-1500)}`);
      const start = bodyStart(c.layout, noRoom(frame));
      // With room for the body it starts on page 1; with none, pagination moves it to a later page.
      if (noRoom(frame)) expect(start.page).toBeGreaterThan(0);
      else expect(start.page).toBe(0);
      const measured = (start.y - reference) / SP_PER_TWIP;
      const expected = frame.expected.top! - marginTop;
      expect(Math.abs(measured - expected)).toBeLessThanOrEqual(TOL_TWIPS);
    }, 300_000);
  }
});
