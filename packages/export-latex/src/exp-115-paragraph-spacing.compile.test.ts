/**
 * EXP-115 criterion 1, paragraph spacing: the `flows` of the model's shared fixture
 * `paragraph-spacing.json` run against the LaTeX writer, with the gap measured in the compiled PDF.
 * (The `pairs` of the same file run in `cdm-043-gap-compile.test.ts`.)
 *
 * A flow is a document with regions, tables, section breaks, figures and stories, and `expected`
 * lists every gap of every container in flow order. Each flow is compiled twice, once as the
 * fixture has it and once with every paragraph's spacing set to zero by direct properties. For a
 * gap whose two sides are paragraphs on the same page, the difference of the distance between them
 * in the two PDFs (from the class's layout report, `main.layout`) is the gap the class placed, and
 * it must equal the fixture's `gap` within one twip. For a gap that starts at the top of a
 * container (`above` null) and ends at a paragraph of the body, the same difference of the
 * paragraph's own position is compared.
 *
 * Not measured here, and said so: a gap with a table, a figure or an equation on either side (the
 * layout report does not place those blocks the same way), a trailing gap (nothing follows it), a
 * gap across a page boundary, and the containers `footnote` and `story` (a story is printed only
 * when a page setup uses it, which these documents do not do; footnote text is set at the foot of
 * the page). The test lists the gaps that it did not measure.
 *
 * Node.js only; needs `lualatex` and the local font copy (`test/cdm-local-tex.ts`); skips without
 * them. Evidence:
 * `pnpm exec vitest run --project node packages/export-latex/src/exp-115-paragraph-spacing.compile.test.ts`
 * with `DOCEDIT_LUALATEX` set when it is not on the PATH.
 */
import { describe, expect, it } from 'vitest';
import { compileLocalAsync, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';
import {
  type DefsFile,
  type DocCase,
  type J,
  documentOf,
  findById,
  loadSemantics,
} from '../test/exp-115-fixtures.ts';

interface Gap {
  readonly above: string | null;
  readonly below: string | null;
  readonly gap: number;
}
interface Flow extends DocCase {
  readonly expected: readonly { readonly container: string; readonly gaps: readonly Gap[] }[];
}
interface File extends DefsFile {
  readonly flows: Flow[];
}

const FILE = loadSemantics<File>('paragraph-spacing');
/** How many gaps of each flow are measured in the PDF (the rest are listed in the header). */
const MEASURED: Readonly<Record<string, number>> = {
  'region-is-transparent': 4,
  'table-and-its-cells': 2,
  'table-style-in-cells': 1,
  'section-break-is-transparent': 1,
  'figure-and-equation': 1,
  'footnote-edges': 0,
  'story-edges': 0,
};
const SP_PER_TWIP = 65781.76 / 20;
const TOL_TWIPS = 1;
const ready = lualatexAvailable();

/** The case with every paragraph's spacing set to zero by direct properties. */
function plainOf(c: Flow): Flow {
  const copy = structuredClone(c) as Flow;
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as J;
    if (node['type'] === 'paragraph') {
      const attrs = ((node['attrs'] as J | undefined) ?? {}) as J;
      attrs['spaceBefore'] = 0;
      attrs['spaceAfter'] = 0;
      attrs['contextualSpacing'] = false;
      node['attrs'] = attrs;
    }
    const content = node['content'];
    if (Array.isArray(content)) content.forEach(visit);
  };
  for (const b of copy.body ?? []) visit(b);
  return copy;
}

async function positions(
  c: Flow,
  name: string,
): Promise<(id: string) => { page: number; y: number } | null> {
  const bundle = await convertLocal(documentOf(FILE, c), {
    profile: 'preview',
    title: `exp-115-${name}`,
    instant: '2026-11-06T10:00:00.000Z',
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
    assets: {},
  } as never);
  const compiled = await compileLocalAsync(bundle, name);
  if (!compiled.ok)
    throw new Error(`the compile failed (${compiled.dir}):\n${compiled.log.slice(-1500)}`);
  const report = JSON.parse(compiled.layout!) as {
    blocks: Record<string, [number, number, number]>;
  };
  return (id) => {
    const n = bundle.map.blocks.indexOf(id);
    const e = n < 0 ? undefined : report.blocks[String(n)];
    return e ? { page: e[0], y: e[1] } : null;
  };
}

describe.skipIf(!ready)('EXP-115 criterion 1: paragraph spacing flows measured in the PDF', () => {
  for (const flow of FILE.flows) {
    // A flow with nothing measurable here (footnote and story containers) is skipped, not passed.
    const run = MEASURED[flow.id] === 0 ? it.skip : it.concurrent;
    run(
      `[paragraph-spacing x LaTeX] flow ${flow.id}${MEASURED[flow.id] === 0 ? ' (not run: no body or cell gap)' : ''}`,
      async () => {
        const body = (flow.body ?? []) as J[];
        const isParagraph = (id: string | null): boolean =>
          id !== null && findById(body, id)?.['type'] === 'paragraph';
        const [spaced, plain] = await Promise.all([
          positions(flow, `${flow.id}-spaced`),
          positions(plainOf(flow), `${flow.id}-plain`),
        ]);
        const measured: string[] = [];
        const notMeasured: string[] = [];
        for (const container of flow.expected) {
          for (const g of container.gaps) {
            const label = `${container.container}: ${g.above ?? 'top'} -> ${g.below ?? 'end'}`;
            const inBody = container.container === 'body';
            const cell = findById(body, container.container)?.['type'] === 'table_cell';
            // The leading gap is measured in the body only: in a cell, the paragraph's place also
            // moves with the blocks above the table.
            if (g.above === null && !inBody) {
              notMeasured.push(`${label} (leading gap outside the body)`);
              continue;
            }
            if (!inBody && !cell) {
              notMeasured.push(`${label} (a footnote or story container)`);
              continue;
            }
            if (!isParagraph(g.below) || (g.above !== null && !isParagraph(g.above))) {
              notMeasured.push(label);
              continue;
            }
            const b = spaced(g.below!);
            const pb = plain(g.below!);
            const a = g.above === null ? null : spaced(g.above);
            const pa = g.above === null ? null : plain(g.above);
            if (!b || !pb || (g.above !== null && (!a || !pa))) {
              notMeasured.push(`${label} (no position)`);
              continue;
            }
            if (g.above !== null && (a!.page !== b.page || pa!.page !== pb.page)) {
              notMeasured.push(`${label} (across a page)`);
              continue;
            }
            const placed =
              g.above === null
                ? (b.y - pb.y) / SP_PER_TWIP
                : (b.y - a!.y - (pb.y - pa!.y)) / SP_PER_TWIP;
            expect(
              Math.abs(placed - g.gap),
              `${label}: the class placed ${placed.toFixed(1)} twips, the fixture says ${g.gap}`,
            ).toBeLessThanOrEqual(TOL_TWIPS);
            measured.push(label);
          }
        }
        expect(
          measured.length,
          `${flow.id}: gaps measured (not measured: ${notMeasured.join('; ')})`,
        ).toBe(MEASURED[flow.id]);
      },
      600_000,
    );
  }
});
