/**
 * EXP-032 criterion 3 (lane w2; Node.js only, sandbox): a right-aligned or decimal tab inside
 * justified text. The warning half (`tab_approximate`) is also in `exp-032-tabs.warning.test.ts`;
 * this file measures the result in the PDF, compiled in the export worker's sandbox (Podman) and
 * read with `pdftotext -bbox`.
 *
 * Why the result is approximate: the class places a tab from the natural widths of the material
 * before it on the line (`resolve_tabs` in `class/docedit.lua`), and a justified line is then set
 * to the full measure, so the spaces before the tab stretch and move the tabbed text to the right.
 * A line that is not stretched (the last line of a paragraph) is exact.
 *
 * Each case is set twice with the same words and the same stop (216 pt from the margin): once
 * start-aligned, where the stop is exact (criterion 1), and once justified.
 *
 * - "last": the tab is on the last line of a paragraph of several lines. Justified and
 *   start-aligned agree, to within `TOL`.
 * - "running": a decimal tab on the first line of a paragraph of several lines, with four words
 *   before it and text after it, so the line is one TeX stretches or shrinks. The number stays on
 *   its line, in order and without overlap, and it is off its exact place by what the spaces
 *   before the tab gained or lost in justification: the test checks that the number moved as far
 *   as the word before the tab did, and reports the distance.
 *
 * A right tab has no such case. Its text runs to the next tab, a forced break or the end of the
 * paragraph, so a right tab that aligns anything is on a line that ends with a forced break or
 * with the paragraph, and those lines are not stretched ("last" covers them).
 *
 * The conversion reports `tab_approximate` once (the code is reported once a job), naming the first
 * justified paragraph.
 *
 * The test skips when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, firstError, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

/** Tolerance in points, as in `exp-032-tabs.compile.test.ts`. */
const TOL = 1.5;
/** The stop of every case: 4320 twips, in points. */
const STOP = 216;

interface Word {
  xMin: number;
  xMax: number;
  yMin: number;
  text: string;
}

function words(pdf: Uint8Array): Word[] {
  const dir = join(tmpdir(), 'docedit-exp-032-justified');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'justified.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-f', '1', '-l', '1', '-bbox', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/g;
  return [...r.stdout.matchAll(re)].map((m) => ({
    xMin: Number(m[1]),
    yMin: Number(m[2]),
    xMax: Number(m[3]),
    text: m[4] ?? '',
  }));
}

const FILL = Array.from({ length: 40 }, (_v, i) => `word${i}`).join(' ');
/** Words of unequal length, so that the first line does not end on the measure by chance. */
const VARIED = Array.from(
  { length: 4 },
  () =>
    'alpha be gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma',
).join(' ');

interface Case {
  tag: string;
  align: 'start' | 'justify';
  tabAlign: 'right' | 'decimal';
  shape: 'last' | 'running';
  word: string;
}

/** The paragraph of a case. Its words carry the case's tag, so each is found in the PDF. */
function block(k: Case): J {
  const attrs = { align: k.align, tabs: [{ position: 4320, align: k.tabAlign, leader: 'none' }] };
  const lead = { type: 'text', text: `${k.tag}A ${k.tag}B ${k.tag}C ${k.tag}D` };
  if (k.shape === 'last')
    return para('', attrs, [
      { type: 'text', text: FILL },
      { type: 'break' },
      lead,
      { type: 'tab' },
      { type: 'text', text: k.word },
    ]);
  return para('', attrs, [lead, { type: 'tab' }, { type: 'text', text: `${k.word} ${VARIED}` }]);
}

describe.skipIf(!ready)(
  'EXP-032 criterion 3: a right or decimal tab in justified text is set approximately, with a warning',
  () => {
    it('is exact on a last line, moves with the stretched spaces on a running line, and warns', async () => {
      const cases: Case[] = [];
      let digit = 1;
      const add = (shape: Case['shape'], tabAlign: Case['tabAlign']): void => {
        for (const align of ['start', 'justify'] as const) {
          const tag = `${shape[0]}${tabAlign[0]}${align[0]}`.toUpperCase();
          // Decimal words share their digits' widths: only the first digit differs.
          const word = tabAlign === 'right' ? `${tag}WORD` : `${digit++}234.56`;
          cases.push({ tag, align, tabAlign, shape, word });
        }
      };
      add('last', 'right');
      add('last', 'decimal');
      add('running', 'decimal');
      const blocks = cases.map(block);
      const c = await convertAndCompile(doc(blocks, { settings: { defaultTabStop: 720 } }), {
        profile: 'preview',
        title: 'exp-032-justified',
        instant: '2026-11-06T10:00:00.000Z',
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed: ${firstError(c.compile.log)}`);

      const warned = c.bundle.diagnostics.filter((d) => d.code === 'tab_approximate');
      expect(warned.map((d) => d.severity)).toEqual(['warning']);
      const firstJustified = blocks[cases.findIndex((k) => k.align === 'justify')]!;
      expect(warned[0]!.blockId).toBe((firstJustified['attrs'] as J)['id']);

      const ws = words(c.compile.pdf);
      const find = (text: string): Word => {
        const w = ws.find((x) => x.text === text);
        if (!w) throw new Error(`the word ${text} is not in the PDF`);
        return w;
      };
      const margin = Math.min(...ws.map((w) => w.xMin));
      /** Per case: the right edge of the word before the tab and of the tabbed word, from the margin. */
      const before: Record<string, number> = {};
      const edge: Record<string, number> = {};
      for (const k of cases) {
        const lead = ['A', 'B', 'C', 'D'].map((x) => find(`${k.tag}${x}`));
        const t = find(k.word);
        if (k.shape === 'running') expect(Math.abs(lead[0]!.xMin - margin)).toBeLessThan(TOL);
        // One line, in order, without overlap.
        const line = [...lead, t];
        for (let i = 1; i < line.length; i++) {
          expect(Math.abs(line[i]!.yMin - line[0]!.yMin)).toBeLessThan(1);
          expect(line[i]!.xMin).toBeGreaterThan(line[i - 1]!.xMax);
        }
        before[k.tag] = lead[3]!.xMax - margin;
        edge[k.tag] = t.xMax - margin;
      }
      // A start-aligned right tab is exact.
      expect(Math.abs(edge['LRS']! - STOP)).toBeLessThan(TOL);
      // A last line is not stretched: justified equals start-aligned.
      expect(Math.abs(edge['LRJ']! - edge['LRS']!)).toBeLessThan(TOL);
      expect(Math.abs(edge['LDJ']! - edge['LDS']!)).toBeLessThan(TOL);
      // A running line: the number is off by what the spaces before the tab gained or lost. The
      // lead words differ by one letter between the two paragraphs, so their natural widths are
      // taken out first.
      const natural = (tag: string): number => {
        const lead = ['A', 'B', 'C', 'D'].map((x) => find(`${tag}${x}`));
        return lead.reduce((sum, w) => sum + (w.xMax - w.xMin), 0);
      };
      const gaps = before['RDJ']! - natural('RDJ') - (before['RDS']! - natural('RDS'));
      const moved = edge['RDJ']! - edge['RDS']!;
      console.info(
        `EXP-032 criterion 3: running line, decimal tab, justified minus start-aligned: ${moved.toFixed(2)} pt; the three spaces before the tab changed by ${gaps.toFixed(2)} pt`,
      );
      // The justified line is a stretched one, or the case would show nothing.
      expect(gaps).toBeGreaterThan(TOL);
      expect(Math.abs(moved - gaps)).toBeLessThan(TOL);
    }, 300_000);
  },
);
