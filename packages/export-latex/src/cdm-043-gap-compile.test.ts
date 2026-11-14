/**
 * CDM-043 criterion 5, LaTeX side, compiled: the gap between two paragraphs in the class's PDF. For
 * each two-paragraph body pair of `paragraph-spacing.json`, the pair is compiled twice: once with the
 * fixture's values and once with the same paragraphs and no spacing at all. The class's layout report
 * (`main.layout`, `blocks`) gives the page and vertical position of each paragraph. The difference of
 * the two distances between the paragraphs is the gap the class placed, and it must equal the
 * fixture's expected gap within one twip. Taking the difference against the zero-spacing document
 * removes the font metrics of the lines. Node.js only, local: `test/cdm-local-tex.ts` runs `lualatex`
 * on this machine (skipped when it does not start). Evidence:
 * `pnpm vitest run --project node packages/export-latex/src/cdm-043-gap-compile.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { compileLocal, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';

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

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../model/fixtures/semantics/paragraph-spacing.json', import.meta.url),
    ),
    'utf8',
  ),
) as Fixture;

/** Scaled points per twip (the class's convention, as in cdm-045). */
const SP_PER_TWIP = 65781.76 / 20;
const TOL_TWIPS = 1;

const BODY_PAIRS = FIXTURE.pairs.filter(
  (p): p is Pair & { above: Side; below: Side } =>
    p.above !== null && p.below !== null && p.above.styleId !== 'FootnoteText',
);

/** A paragraph of one side with its resolved values, or with no spacing when `plain` is set. */
function paragraph(side: Side, text: string, plain: boolean): J {
  if (plain)
    return para(text, {
      style: side.styleId,
      spaceBefore: 0,
      spaceAfter: 0,
      contextualSpacing: false,
    });
  return para(text, {
    style: side.styleId,
    spaceBefore: side.spaceBefore,
    spaceAfter: side.spaceAfter,
    contextualSpacing: side.contextualSpacing,
  });
}

/** The page (1-based, as the class counts) and y (scaled points) of each block, from the layout report. */
export function positionsOf(layout: string, ids: readonly number[]): { page: number; y: number }[] {
  const report = JSON.parse(layout) as { blocks: Record<string, [number, number, number]> };
  return ids.map((id) => {
    const e = report.blocks[String(id)];
    if (!e) throw new Error(`the layout report has no block ${id}`);
    return { page: e[0], y: e[1] };
  });
}

/** The block ids of the paragraphs in body order, read from main.tex (the first argument of `\DEp`). */
export function blockIdsOf(main: string): number[] {
  return [...main.matchAll(/\\DEp\{(\d+)\}/g)].map((m) => Number(m[1]));
}

const ready = lualatexAvailable();

describe.skipIf(!ready)(
  'CDM-043 criterion 5, LaTeX side compiled: paragraph-spacing.json pairs',
  () => {
    for (const pair of BODY_PAIRS) {
      it(`pair "${pair.id}" places the paragraphs ${pair.expected} twips apart beyond the zero-spacing reference`, async () => {
        const styles = FIXTURE.styles.map((s) => ({ type: 'style_def', attrs: s.attrs }));
        const measure = async (plain: boolean, name: string) => {
          const body = [
            paragraph(pair.above, 'Above.', plain),
            paragraph(pair.below, 'Below.', plain),
          ];
          const bundle = await convertLocal(
            doc(body, { settings: FIXTURE.settings, styles }) as never,
            {
              profile: 'preview',
              title: `cdm-043-${name}`,
              instant: '2026-11-06T10:00:00.000Z',
              timeZone: 'Europe/London',
              suggestions: 'accept',
              layout: 'block',
            } as never,
          );
          const c = compileLocal(bundle, `${pair.id}-${name}`);
          if (!c.ok) throw new Error(`the compile failed (${c.dir}):\n${c.log.slice(-1500)}`);
          const ids = blockIdsOf(bundle.files['main.tex']!);
          return positionsOf(c.layout!, ids);
        };
        const [refA, refB] = await measure(true, 'ref');
        const [a, b] = await measure(false, 'pair');
        // Both paragraphs of the pair and of the reference sit on one page, so the distance is a gap.
        expect(a!.page).toBe(b!.page);
        expect(refA!.page).toBe(refB!.page);
        expect(a!.page).toBe(refA!.page);
        const distance = (x: { y: number }, y: { y: number }) => (y.y - x.y) / SP_PER_TWIP;
        const gap = distance(a!, b!) - distance(refA!, refB!);
        // The message shows the measured gap when the check fails.
        expect(gap).toBeGreaterThanOrEqual(pair.expected - TOL_TWIPS);
        expect(gap).toBeLessThanOrEqual(pair.expected + TOL_TWIPS);
      }, 600_000);
    }
  },
);
