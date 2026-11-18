/**
 * CDM-043 criterion 5, LaTeX side, compiled: the container flows of `paragraph-spacing.json`
 * (regions, tables and cells, section breaks, figures and equations, footnotes, stories) and the
 * `consecutive-footnotes` pair. Each flow is compiled twice, with the fixture's spacing and with
 * every paragraph's spacing set to zero, and the class's layout report (`main.layout`) gives the
 * page and height of each block. The difference between the two documents in the distance between
 * two blocks is the spacing the class placed there, and it must equal the sum of the fixture's gaps
 * on the way between them (`MEASURES`, each with the reading of the fixture it uses). Leading gaps
 * are read from the first block's own position. Node.js only, local: `test/cdm-local-tex.ts` runs
 * `lualatex` on this machine (skipped when it does not start). Evidence:
 * `pnpm exec vitest run --project node packages/export-latex/src/cdm-043-flows-compile.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Bundle } from '../src/index.ts';
import { compileLocal, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';

type J = Record<string, unknown>;
interface Flow {
  readonly id: string;
  readonly body: readonly J[];
  readonly styles?: readonly J[];
  readonly stories?: readonly J[];
}
interface Fixture {
  readonly settings: J;
  readonly styles: readonly J[];
  readonly flows: readonly Flow[];
  readonly pairs: readonly { readonly id: string }[];
}
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../model/fixtures/semantics/paragraph-spacing.json', import.meta.url),
    ),
    'utf8',
  ),
) as Fixture;

/** Scaled points per twip (the class's convention, as in cdm-043-gap-compile). */
const SP_PER_TWIP = 65781.76 / 20;
const TOL_TWIPS = 1;

/** One measurement: from the top of `from` to the top of `to`, or `from` alone for a leading gap. */
interface Measure {
  readonly what: string;
  readonly from: string;
  readonly to?: string;
  /** `bodyStart`: the top of the first body block of page 1, which a header pushes down. */
  readonly kind?: 'bodyStart';
  /** Twips the spaced document adds, as the fixture's gaps give it. */
  readonly expected: number;
  /** Set when the class does not place this gap yet: what it does instead. */
  readonly open?: string;
}

const MEASURES: Record<string, readonly Measure[]> = {
  'region-is-transparent': [
    { what: 'leading gap of the body', from: 'p01xxxxxxxxxxxxx', expected: 120 },
    {
      what: 'contextual pair across the region edge',
      from: 'p01xxxxxxxxxxxxx',
      to: 'p02xxxxxxxxxxxxx',
      expected: 0,
    },
    {
      what: 'gap inside the region',
      from: 'p02xxxxxxxxxxxxx',
      to: 'p03xxxxxxxxxxxxx',
      expected: 160,
    },
    {
      what: 'gap across the region end',
      from: 'p03xxxxxxxxxxxxx',
      to: 'p04xxxxxxxxxxxxx',
      expected: 160,
    },
  ],
  'table-and-its-cells': [
    { what: 'leading gap of the body', from: 'p01xxxxxxxxxxxxx', expected: 120 },
    // Body gap above the table (160) and the leading gap of the first cell paragraph (120).
    {
      what: 'paragraph above the table to the first cell paragraph',
      from: 'p01xxxxxxxxxxxxx',
      to: 'p02xxxxxxxxxxxxx',
      expected: 280,
      open: 'the leading gap of a cell adds one more line, 533 twips measured',
    },
    { what: 'gap inside a cell', from: 'p02xxxxxxxxxxxxx', to: 'p03xxxxxxxxxxxxx', expected: 240 },
    // Trailing gap of the cell (160) and the gap below the table (120).
    {
      what: 'last cell paragraph to the paragraph below the table',
      from: 'p03xxxxxxxxxxxxx',
      to: 'p05xxxxxxxxxxxxx',
      expected: 280,
      open: 'the trailing gap of a cell is not placed, 120 twips measured',
    },
    // The second cell starts with a gap of 0 where the first has 120: the two cells sit side by side.
    {
      what: 'leading gaps of two cells side by side',
      from: 'p02xxxxxxxxxxxxx',
      to: 'p04xxxxxxxxxxxxx',
      expected: -120,
      open: 'the leading gap of a cell adds one more line, -373 twips measured',
    },
  ],
  'table-style-in-cells': [
    { what: 'gap above the table is 0', from: 'p01xxxxxxxxxxxxx', expected: 0 },
    {
      what: 'gap inside the cell under the table style',
      from: 'p01xxxxxxxxxxxxx',
      to: 'p02xxxxxxxxxxxxx',
      expected: 0,
    },
    {
      what: 'cell end and the gap below the table',
      from: 'p02xxxxxxxxxxxxx',
      to: 'p03xxxxxxxxxxxxx',
      expected: 0,
    },
  ],
  'consecutive-footnotes': [
    // The pair of that name in `pairs`: both FootnoteText, 60 after against 40 before.
    {
      what: 'gap between the paragraphs of consecutive footnotes',
      from: 'fp01xxxxxxxxxxxx',
      to: 'fp02xxxxxxxxxxxx',
      expected: 60,
      open: 'the converter writes no gap in a footnote, 0 twips measured',
    },
  ],
  'footnote-edges': [
    // On a page that is not full the notes follow the text, so the leading gap of the note (40)
    // shows in its distance from the paragraph that holds the mark.
    {
      what: 'leading gap of a footnote',
      from: 'p01xxxxxxxxxxxxx',
      to: 'fp01xxxxxxxxxxxx',
      expected: 40,
      open: 'the converter writes no gap in a footnote, 0 twips measured',
    },
  ],
  'story-edges': [
    // 120 above the first paragraph, 160 between the two, 160 below the last, and 120 more for the
    // leading gap of the first body paragraph, which the body start includes.
    { what: 'header height with its edge gaps', from: '', kind: 'bodyStart', expected: 560 },
  ],
  'section-break-is-transparent': [
    { what: 'leading gap of the body', from: 'p01xxxxxxxxxxxxx', expected: 120 },
    {
      what: 'gap across a section break',
      from: 'p01xxxxxxxxxxxxx',
      to: 'p02xxxxxxxxxxxxx',
      expected: 400,
    },
  ],
  'figure-and-equation': [
    { what: 'leading gap of the body', from: 'p01xxxxxxxxxxxxx', expected: 120 },
    // 160 above the figure, 0 between figure and equation, 120 below the equation.
    {
      what: 'paragraph above a figure and an equation to the paragraph below',
      from: 'p01xxxxxxxxxxxxx',
      to: 'p02xxxxxxxxxxxxx',
      expected: 280,
    },
  ],
};

/** The page setup of a flow: `story-edges` has a header, with room to grow. */
const PAGES: Record<string, J> = {
  'story-edges': {
    marginTop: 300,
    headerDistance: 100,
    headerDefault: 'storyAxxxxxxxxxx',
  },
};

/** Flows that are not in the fixture: the `consecutive-footnotes` pair of `pairs`. */
const text = (id: string, style: string, extra: J[] = []): J => ({
  type: 'paragraph',
  attrs: { id, style },
  content: [{ type: 'text', text: 'Text.' }, ...extra],
});
const note = (id: string, pid: string): J => ({
  type: 'footnote',
  attrs: { id },
  content: [text(pid, 'FootnoteText')],
});
const EXTRA_FLOWS: readonly Flow[] = [
  {
    id: 'consecutive-footnotes',
    body: [
      text('p01xxxxxxxxxxxxx', 'Body', [
        note('fn01xxxxxxxxxxxx', 'fp01xxxxxxxxxxxx'),
        note('fn02xxxxxxxxxxxx', 'fp02xxxxxxxxxxxx'),
      ]),
    ],
  },
];

const ready = lualatexAvailable();

const OPTIONS = (title: string) =>
  ({
    profile: 'preview',
    title,
    instant: '2026-11-06T10:00:00.000Z',
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
  }) as never;

/** The styles of the fixture, with the spacing of every paragraph style removed when `plain`. */
function stylesOf(extra: readonly J[] | undefined, plain: boolean): J[] {
  const merged = [...FIXTURE.styles];
  for (const s of extra ?? []) {
    const id = (s['attrs'] as J)['id'];
    const i = merged.findIndex((m) => (m['attrs'] as J)['id'] === id);
    if (i >= 0) merged[i] = s;
    else merged.push(s);
  }
  return merged.map((s) => {
    const attrs = s['attrs'] as J;
    if (!plain) return s;
    return {
      ...s,
      attrs: { ...attrs, spaceBefore: 0, spaceAfter: 0, contextualSpacing: false },
    };
  });
}

/** A copy of the nodes with the spacing of every paragraph removed, direct values included. */
function plainNodes(nodes: readonly J[]): J[] {
  return nodes.map((n) => {
    const out: J = { ...n };
    if (n['type'] === 'paragraph')
      out['attrs'] = {
        ...(n['attrs'] as J),
        spaceBefore: 0,
        spaceAfter: 0,
        contextualSpacing: false,
      };
    if (Array.isArray(n['content']))
      out['content'] = n['content'].map((c: J) => (c['type'] ? plainNodes([c])[0]! : c));
    return out;
  });
}

/**
 * A `continuous` section break keeps the gap on one page, where the fixture's default break (to the
 * next page) would put the two paragraphs on pages that a distance cannot compare.
 */
function continuous(nodes: readonly J[]): J[] {
  return nodes.map((n) =>
    n['type'] === 'section_break'
      ? { ...n, attrs: { ...(n['attrs'] as J), start: 'continuous' } }
      : n,
  );
}

function envelope(
  flow: { body: readonly J[]; styles?: readonly J[]; stories?: readonly J[] },
  plain: boolean,
  page: J = {},
): unknown {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { ...FIXTURE.settings } },
            ...stylesOf(flow.styles, plain),
            { type: 'page_setup', attrs: { id: 'ps1', ...page } },
          ],
        },
        ...(plain ? plainNodes(flow.stories ?? []) : (flow.stories ?? [])),
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: continuous(plain ? plainNodes(flow.body) : flow.body),
        },
      ],
    },
  };
}

/** The page (1-based) and y (scaled points) of each block, by node identifier. */
function positions(bundle: Bundle, layout: string): Map<string, { page: number; y: number }> {
  const report = JSON.parse(layout) as { blocks: Record<string, [number, number, number]> };
  const out = new Map<string, { page: number; y: number }>();
  bundle.map.blocks.forEach((id, n) => {
    const e = report.blocks[String(n)];
    if (e) out.set(id, { page: e[0], y: e[1] });
  });
  return out;
}

interface Compiled {
  readonly bundle: Bundle;
  readonly at: Map<string, { page: number; y: number }>;
  readonly layout: string;
}

async function compile(env: unknown, name: string): Promise<Compiled> {
  const bundle = await convertLocal(env as never, OPTIONS(`cdm-043-${name}`));
  const c = compileLocal(bundle, name);
  if (!c.ok) throw new Error(`the compile failed (${c.dir}):\n${c.log.slice(-1500)}`);
  return { bundle, at: positions(bundle, c.layout!), layout: c.layout! };
}

const compiled = new Map<string, Promise<[Compiled, Compiled]>>();
/** Both documents of a flow, compiled once for the tests that read them. */
function both(flow: Flow): Promise<[Compiled, Compiled]> {
  let p = compiled.get(flow.id);
  if (!p) {
    p = (async () => [
      await compile(envelope(flow, false, PAGES[flow.id]), `${flow.id}-spaced`),
      await compile(envelope(flow, true, PAGES[flow.id]), `${flow.id}-plain`),
    ])();
    compiled.set(flow.id, p);
  }
  return p;
}

/** The measure's value in twips and the problems in reading it. */
function measure(flow: Flow, m: Measure, spaced: Compiled, plain: Compiled): number {
  if (m.kind === 'bodyStart') {
    const y = (r: Compiled): number =>
      (JSON.parse(r.layout) as { pages: { start: [number, number, number] }[] }).pages[0]!.start[2];
    return (y(spaced) - y(plain)) / SP_PER_TWIP;
  }
  const read = (r: Compiled, id: string) => {
    const p = r.at.get(id);
    if (!p) throw new Error(`${flow.id}: the layout report has no block ${id}`);
    return p;
  };
  const a1 = read(spaced, m.from);
  const a0 = read(plain, m.from);
  if (m.to === undefined) {
    expect(a1.page, `${m.what}: page`).toBe(a0.page);
    return (a1.y - a0.y) / SP_PER_TWIP;
  }
  const b1 = read(spaced, m.to);
  const b0 = read(plain, m.to);
  expect(b1.page, `${m.what}: page of the pair`).toBe(a1.page);
  expect(b0.page, `${m.what}: page of the reference pair`).toBe(a0.page);
  return (b1.y - a1.y - (b0.y - a0.y)) / SP_PER_TWIP;
}

describe.skipIf(!ready)(
  'CDM-043 criterion 5, LaTeX side compiled: paragraph-spacing.json flows',
  () => {
    for (const flow of [...FIXTURE.flows, ...EXTRA_FLOWS].filter((f) => MEASURES[f.id])) {
      const all = MEASURES[flow.id]!;
      const met = all.filter((m) => !m.open);
      const open = all.filter((m) => m.open);
      if (met.length > 0)
        it(`flow "${flow.id}" places the fixture's gaps`, async () => {
          const [spaced, plain] = await both(flow);
          const wrong = met
            .map((m) => [m, measure(flow, m, spaced, plain)] as const)
            .filter(([m, v]) => Math.abs(v - m.expected) > TOL_TWIPS)
            .map(([m, v]) => `${m.what}: ${Math.round(v)} twips, expected ${m.expected}`);
          expect(wrong).toEqual([]);
        }, 600_000);
      // A gap the class does not place yet: the test is expected to fail, and fails (as a signal to
      // move the measure to the passing test) once the class places the gap.
      for (const m of open)
        it.fails(
          `flow "${flow.id}", open: ${m.what} (${m.open})`,
          async () => {
            const [spaced, plain] = await both(flow);
            expect(Math.abs(measure(flow, m, spaced, plain) - m.expected)).toBeLessThanOrEqual(
              TOL_TWIPS,
            );
          },
          600_000,
        );
    }
  },
);
