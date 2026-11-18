/**
 * CDM-043 criterion 5, LaTeX side, compiled: the line heights of `line-spacing.json`. The class
 * cannot be given the fixture's natural run heights (they come from the font files), so each case
 * is built with runs whose font sizes follow the fixture's heights (a size of `height / 1.362`
 * twips, 1.362 being the line height of the manifest's body font) on three lines. Every case is
 * compiled twice, with its `lineSpacing` and `lineRule`, and with `multiple` 1000. The reference
 * pitch between two baselines of the second document is the natural height T of the tallest run
 * as the class measured it. Then:
 * - the pitch of the case equals the model's `lineHeight(spacing, [T])` within one twip, which is
 *   the rule the fixture fixes applied to what the class measured (`multiple` of the tallest run,
 *   rounded half up; `exact`; `atLeast`);
 * - T equals the fixture's tallest run within one twip (the sizes were chosen to give that, and the
 *   test checks it), so the pitch also equals the fixture's own `expected` within one twip.
 * An inline picture is a run of its own height in the fixture; here it is a run of a large size, and
 * the `empty-line` case is a line of text, not an empty one.
 * Node.js only, local: `test/cdm-local-tex.ts` runs `lualatex` on this machine (skipped when it
 * does not start). Evidence:
 * `pnpm exec vitest run --project node packages/export-latex/src/cdm-043-lines-compile.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lineHeight } from '@docedit/model';
import { doc, nid, type J } from '../test/docs.ts';
import { compileLocal, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';

interface Case {
  readonly id: string;
  readonly lineSpacing: number;
  readonly lineRule: 'multiple' | 'exact' | 'atLeast';
  readonly runs: readonly number[];
  readonly expected: number;
}
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../model/fixtures/semantics/line-spacing.json', import.meta.url)),
    'utf8',
  ),
) as { cases: readonly Case[] };

/** Scaled points per twip (the class's convention). */
const SP_PER_TWIP = 65781.76 / 20;
/** The line height of the body font as a multiple of its size (the manifest's Noto Serif). */
const LINE_HEIGHT_RATIO = 1.362;

const ready = lualatexAvailable();

/** A paragraph of three lines of the case's runs, on a page of its own. */
function paragraph(c: Case, spacing: { rule: string; value: number }): J {
  const line = (): J[] =>
    c.runs.flatMap((h, i) => [
      ...(i > 0 ? [{ type: 'text', text: ' ' }] : []),
      {
        type: 'text',
        text: 'Hxg',
        marks: [{ type: 'fontSize', attrs: { value: Math.round(h / LINE_HEIGHT_RATIO) } }],
      },
    ]);
  const br = (): J => ({ type: 'break', attrs: { kind: 'line' } });
  return {
    type: 'paragraph',
    attrs: {
      id: nid('p'),
      pageBreakBefore: true,
      lineRule: spacing.rule,
      lineSpacing: spacing.value,
      spaceBefore: 0,
      spaceAfter: 0,
    },
    content: [...line(), br(), ...line(), br(), ...line()],
  };
}

/** The baseline pitch between the second and third line of each paragraph, in twips. */
async function pitches(
  cases: readonly Case[],
  spacingOf: (c: Case) => { rule: string; value: number },
  name: string,
): Promise<number[]> {
  const body = cases.map((c) => paragraph(c, spacingOf(c)));
  const bundle = await convertLocal(
    doc(body) as never,
    {
      profile: 'preview',
      title: `cdm-043-${name}`,
      instant: '2026-11-06T10:00:00.000Z',
      timeZone: 'Europe/London',
      suggestions: 'accept',
      layout: 'line',
    } as never,
  );
  const c = compileLocal(bundle, name);
  if (!c.ok) throw new Error(`the compile failed (${c.dir}):\n${c.log.slice(-1500)}`);
  const report = JSON.parse(c.layout!) as { lines: [number, number, number, number][] };
  const blockOf = [...bundle.files['main.tex']!.matchAll(/\\DEp\{(\d+)\}/g)].map((m) =>
    Number(m[1]),
  );
  return blockOf.map((b) => {
    const own = report.lines.filter((l) => l[0] === b);
    if (own.length < 3) throw new Error(`block ${b} has ${own.length} lines in the report`);
    expect(own[2]![2], 'the lines are on one page').toBe(own[1]![2]);
    return (own[2]![3] - own[1]![3]) / SP_PER_TWIP;
  });
}

describe.skipIf(!ready)('CDM-043 criterion 5, LaTeX side compiled: line-spacing.json', () => {
  it('sets each line to the model height of the tallest run the class measured', async () => {
    const cases = FIXTURE.cases;
    const natural = await pitches(cases, () => ({ rule: 'multiple', value: 1000 }), 'lines-ref');
    const placed = await pitches(
      cases,
      (c) => ({ rule: c.lineRule, value: c.lineSpacing }),
      'lines-spaced',
    );
    const wrong: string[] = [];
    cases.forEach((c, i) => {
      const t = Math.round(natural[i]!);
      const model = lineHeight({ lineSpacing: c.lineSpacing, lineRule: c.lineRule }, [t]);
      if (Math.abs(placed[i]! - model) > 1)
        wrong.push(`${c.id}: pitch ${placed[i]} twips, the model gives ${model} for a run of ${t}`);
      const tallest = Math.max(...c.runs);
      // The font sizes were chosen so that the class measures the fixture's heights (checked here).
      if (Math.abs(t - tallest) > 1)
        wrong.push(`${c.id}: the class measured a run of ${t} twips, the fixture has ${tallest}`);
      if (Math.abs(placed[i]! - c.expected) > 1)
        wrong.push(`${c.id}: pitch ${placed[i]} twips, the fixture says ${c.expected}`);
    });
    expect(wrong).toEqual([]);
  }, 900_000);
});
