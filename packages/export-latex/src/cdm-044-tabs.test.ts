/**
 * CDM-044 criterion 4, LaTeX side: the class places the segment after a tab where the shared
 * fixture `packages/model/fixtures/semantics/tabs.json` says, so both engines agree on stop
 * positions. Node.js, compiled locally (`test/cdm-local-tex.ts`: the sandbox cannot start here).
 *
 * One document holds one paragraph per case. A case with `x` after its start needs the tab to land
 * at `x`: the paragraph gets an extra left stop at `x` and the fixture's stops that lie beyond `x`
 * (stops before `x` cannot be reached from the start of the segment, so they are left out; they only
 * affect the default stops to their left). The case's tab then goes from `x` as in the fixture. Each
 * segment is one word `Q<n>` plus filler, read back with `pdftotext -bbox` (points, from the top
 * left; a twip is 1/20 bigpoint, which is 1/20 of a PDF point).
 *
 * Checks: a left segment (and a segment after a default or hanging stop) starts at its position; a
 * right segment ends at it; a centre segment is centred on it; a decimal segment's integer part ends
 * at it (the integer part is measured on its own line, `Q<n><integer>`, which has the same glyphs).
 * Tolerance 1.5 points, as EXP-032.
 *
 * Not run: leaders (every case uses `leader: none`, so the words are not split by leader dots). The
 * layout side is `packages/layout/src/cdm-044-tabs.test.ts`.
 * Evidence: `pnpm exec vitest run packages/export-latex/src/cdm-044-tabs.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tabsFixtures from '../../model/fixtures/semantics/tabs.json' with { type: 'json' };
import { doc, para, type J } from '../test/docs.ts';
import { compileLocal, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';

interface Stop {
  readonly position: number;
  readonly align: 'left' | 'center' | 'right' | 'decimal';
  readonly leader: string;
}
interface Case {
  readonly id: string;
  readonly tabs: readonly Stop[];
  readonly indentLeft?: number;
  readonly indentFirstLine?: number;
  readonly x: number;
  readonly segment?: { readonly text?: string; readonly width?: number };
  readonly expected: {
    readonly position: number;
    readonly align?: string;
    readonly start?: number;
    readonly source: string;
  };
}

const CASES = (tabsFixtures as unknown as { cases: Case[] }).cases;
/** The cases this test checks: every case whose stops are left, right, centre or decimal, no leader. */
const CHECKED = CASES;
const isDecimal = (c: Case): boolean =>
  c.expected.align === 'decimal' || c.tabs.some((t) => t.align === 'decimal');
/** The integer part of a decimal segment: its text before the separator (the whole text if none). */
const integerPart = (c: Case): string => (c.segment?.text ?? '').split('.')[0] ?? '';

/** One point is 20 twips here: PDF points are bigpoints, and a twip is 1/20 bigpoint. */
const TWIPS_PER_PT = 20;
const TOL_PT = 1.5;
const LEFT_MARGIN_PT = 1440 / TWIPS_PER_PT;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** The paragraph of one case: stops (the extra stop at `x` and the fixture's stops beyond it). */
function paragraphOf(index: number, c: Case): J {
  const start = (c.indentLeft ?? 0) + (c.indentFirstLine ?? 0);
  const word = isDecimal(c) ? `Q${index}${c.segment?.text ?? ''}` : `Q${index}${'w'.repeat(6)}`;
  const stops: J[] = c.tabs
    .filter((t) => t.position > c.x)
    .map((t) => ({ position: t.position, align: t.align, leader: 'none' }));
  // The prefix: one explicit left stop for each stop in (start, x]: the fixture's stops there, a
  // hanging indent that lies there (its stop is implicit in the model, so it is made explicit), and x.
  const prefix = new Set<number>();
  if (c.x > start) {
    for (const t of c.tabs) if (t.position > start && t.position <= c.x) prefix.add(t.position);
    if (c.indentLeft !== undefined && c.indentLeft > start && c.indentLeft <= c.x)
      prefix.add(c.indentLeft);
    prefix.add(c.x);
  }
  const sorted = [...prefix].sort((a, b) => a - b);
  for (const position of sorted) stops.push({ position, align: 'left', leader: 'none' });
  const content: J[] = sorted.map(() => ({ type: 'tab' }));
  content.push({ type: 'tab' }, { type: 'text', text: word });
  const attrs: J = {
    tabs: stops,
    indentLeft: c.indentLeft ?? 0,
    indentFirstLine: c.indentFirstLine ?? 0,
  };
  return para('', attrs, content);
}

interface Word {
  readonly xMin: number;
  readonly xMax: number;
  readonly text: string;
}

/** The words of page 1, from `pdftotext -bbox`. */
function wordsOf(pdf: Uint8Array): Word[] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-v-cdm-028-053-cdm-044-'));
  const file = join(dir, 'tabs.pdf');
  writeFileSync(file, pdf);
  const bin = process.env['DOCEDIT_PDFTOTEXT'] ?? 'pdftotext';
  const r = spawnSync(bin, ['-f', '1', '-l', '1', '-bbox', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox failed (set DOCEDIT_PDFTOTEXT)');
  const out: Word[] = [];
  for (const m of r.stdout.matchAll(
    /<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/g,
  )) {
    out.push({ xMin: Number(m[1]), xMax: Number(m[2]), text: m[3]! });
  }
  return out;
}

const ready = lualatexAvailable();

describe.skipIf(!ready)('CDM-044 criterion 4, LaTeX side: tabs.json stop positions', () => {
  it('compiles one paragraph per checked case', async () => {
    // A reference line per decimal segment with a separator: its integer part on its own, whose
    // width is the width of the integer part inside the segment (the same glyphs, the same font).
    const refs: J[] = CHECKED.flatMap((c, i) =>
      isDecimal(c) && (c.segment?.text ?? '').includes('.') ? [para(`Q${i}${integerPart(c)}`)] : [],
    );
    const body = [...CHECKED.map((c, i) => paragraphOf(i, c)), ...refs];
    const bundle = await convertLocal(
      doc(body, { settings: { defaultTabStop: 720 } }) as never,
      {
        profile: 'preview',
        title: 'cdm-044-tabs',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
        layout: 'block',
      } as never,
    );
    const c = compileLocal(bundle, 'cdm-044-tabs');
    if (!c.ok || !c.pdf) throw new Error(`the compile failed (${c.dir}):\n${c.log.slice(-1500)}`);
    const words = wordsOf(c.pdf);
    const problems: string[] = [];
    for (const [i, cs] of CHECKED.entries()) {
      const decimal = isDecimal(cs);
      const w = decimal
        ? words.find((x) => x.text === `Q${i}${cs.segment?.text ?? ''}`)
        : words.find((x) => x.text.startsWith(`Q${i}w`));
      if (!w) {
        problems.push(`${cs.id}: the segment is not on the page`);
        continue;
      }
      // Where the segment starts, in twips from the left margin. A left segment starts at its
      // stop (or the default stop). A right or centre segment is placed by its measured width,
      // and never starts before the tab's own position x (the model's rule, as in the fixture
      // `segment-too-wide`): start = max(x, stop - width) or max(x, stop - width / 2).
      const align = decimal ? 'decimal' : (cs.expected.align ?? 'left');
      const widthTw = (w!.xMax - w!.xMin) * TWIPS_PER_PT;
      // A decimal segment ends its integer part at the stop: the integer part is measured on its own.
      let beforeTw = widthTw;
      if (decimal && (cs.segment?.text ?? '').includes('.')) {
        const ref = words.find((x) => x.text === `Q${i}${integerPart(cs)}`);
        if (!ref) {
          problems.push(`${cs.id}: the integer part is not on the page`);
          continue;
        }
        beforeTw = (ref.xMax - ref.xMin) * TWIPS_PER_PT;
      }
      const startTw =
        align === 'right'
          ? Math.max(cs.x, cs.expected.position - widthTw)
          : align === 'center'
            ? Math.max(cs.x, cs.expected.position - widthTw / 2)
            : align === 'decimal'
              ? Math.max(cs.x, cs.expected.position - beforeTw)
              : (cs.expected.start ?? cs.expected.position);
      const expected = LEFT_MARGIN_PT + startTw / TWIPS_PER_PT;
      if (Math.abs(w!.xMin - expected) > TOL_PT) {
        problems.push(
          `${cs.id}: segment starts at ${w!.xMin.toFixed(2)} pt, expected ${expected.toFixed(2)} pt`,
        );
      }
    }
    expect(problems).toEqual([]);
  }, 300_000);
});
