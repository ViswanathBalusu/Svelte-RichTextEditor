/**
 * FE-094: the corpus painted in each browser. The corpus document `pages-20` is laid out with the
 * kernel as the measurer (`packages/perf/test/fe-094-corpus-golden.test.ts` stores the layout tree and
 * the lines, with their runs and the width the measurer computed for each line, in
 * `packages/painter/golden/`). Here the stored tree is painted, run by run, in the faces the kernel
 * measured, and the width of each painted line is read back from the page.
 *
 * 1. Criterion 1: every painted line is as wide as its computed width, within half a CSS pixel (the
 *    target of 02 §9.3). The test fails otherwise.
 * 2. Criterion 2: the painted widths of each browser are stored (`fe-094-pages-20.painted.<browser>.json`).
 *    A width that moves by more than STORED_DRIFT_PX from the stored one, or a line that appears or
 *    goes, fails the test until the file is written again in a reviewed change (delete the file and
 *    run the test: it writes the new one and fails once, so that the change is seen).
 * 3. Criterion 5: the distribution of the differences (painted minus computed) is reported for the
 *    browser: logged, and written to `test-results/evidence/fe-094-widths.<browser>.json`.
 *
 * Lines of text the harness's faces have no glyphs for (CJK, Hangul) and lines with a tab are in the
 * report as skipped, not compared. Runs in Chromium, Firefox and WebKit; skipped in Node.js.
 */
import type * as VitestBrowser from 'vitest/browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import notoSansBold from '../../perf/fonts/files/NotoSans-Bold.ttf?url';
import notoSansItalic from '../../perf/fonts/files/NotoSans-Italic.ttf?url';
import notoSansRegular from '../../perf/fonts/files/NotoSans-Regular.ttf?url';
import notoMonoBold from '../../perf/fonts/files/NotoSansMono-Bold.ttf?url';
import notoMonoRegular from '../../perf/fonts/files/NotoSansMono-Regular.ttf?url';
import notoSerifBold from '../../perf/fonts/files/NotoSerif-Bold.ttf?url';
import notoSerifBoldItalic from '../../perf/fonts/files/NotoSerif-BoldItalic.ttf?url';
import notoSerifItalic from '../../perf/fonts/files/NotoSerif-Italic.ttf?url';
import notoSerifRegular from '../../perf/fonts/files/NotoSerif-Regular.ttf?url';
import type { LayoutTree } from '../../layout/src/tree.ts';
import linesJson from '../golden/fe-094-pages-20.lines.json?raw';
import treeJson from '../golden/fe-094-pages-20.tree.json?raw';
import { paintTree, type PaintRun, type PaintSource } from './painter.ts';

type BrowserCommands = typeof VitestBrowser.commands;
type BrowserServer = typeof VitestBrowser.server;

const hasDom = typeof document !== 'undefined';

/** Half a CSS pixel: the target of 02 §9.3. */
const HALF_PIXEL = 0.5;
/** How far a stored painted width may move before the stored result must be written again. A choice of this test. */
const STORED_DRIFT_PX = 0.1;
const PX_PER_PT = 96 / 72;

const FONT_URLS: Record<string, string> = {
  'files/NotoSans-Bold.ttf': notoSansBold,
  'files/NotoSans-Italic.ttf': notoSansItalic,
  'files/NotoSans-Regular.ttf': notoSansRegular,
  'files/NotoSansMono-Bold.ttf': notoMonoBold,
  'files/NotoSansMono-Regular.ttf': notoMonoRegular,
  'files/NotoSerif-Bold.ttf': notoSerifBold,
  'files/NotoSerif-BoldItalic.ttf': notoSerifBoldItalic,
  'files/NotoSerif-Italic.ttf': notoSerifItalic,
  'files/NotoSerif-Regular.ttf': notoSerifRegular,
};

interface GoldenRun {
  text: string;
  alias: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
}
interface GoldenLine {
  key: string;
  block: string;
  from: number;
  to: number;
  widthPt: number;
  comparable: boolean;
  runs: GoldenRun[];
}
interface Golden {
  document: string;
  measurer: string;
  faces: { alias: string; file: string; weight: number; style: 'normal' | 'italic' }[];
  lines: GoldenLine[];
}

const rounded = (v: number): number => Math.round(v * 100) / 100;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

describe.skipIf(!hasDom)('the corpus painted in the browser (FE-094)', () => {
  const golden = hasDom ? (JSON.parse(linesJson) as Golden) : null;
  const byKey = new Map<string, GoldenLine>();
  const added: FontFace[] = [];
  let root: HTMLElement;
  /** The painted width of each compared line, in CSS pixels, by line key. */
  const painted = new Map<string, number>();
  const diffs = new Map<string, number>();
  let skipped = 0;
  let commands: BrowserCommands;
  let server: BrowserServer;
  let pages = 0;

  beforeAll(async () => {
    ({ commands, server } = await import('vitest/browser'));
    for (const line of golden!.lines) byKey.set(line.key, line);
    for (const face of golden!.faces) {
      const ff = new FontFace(face.alias, `url(${FONT_URLS[face.file]!})`, {
        weight: String(face.weight),
        style: face.style,
      });
      await ff.load();
      document.fonts.add(ff);
      added.push(ff);
    }
    await document.fonts.ready;
    // The stored file is `serialiseTree`: the pages, rounded to a thousandth.
    const tree = {
      engine: 'stored',
      measurer: golden!.measurer,
      pages: JSON.parse(treeJson),
    } as LayoutTree;
    pages = tree.pages.length;
    const runsOf = (blockId: string, from: number, to: number): PaintRun[] | null => {
      const line = byKey.get(`${blockId}:${from}:${to}`);
      if (!line) return null;
      return line.runs.map((r) => ({
        text: r.text,
        fontFamily: `"${r.alias}", serif`,
        fontSizePt: r.sizePt,
        bold: r.bold,
        italic: r.italic,
        underline: false,
        strike: false,
        color: null,
        vertAlign: null,
      }));
    };
    const source: PaintSource = {
      lineText: (b, f, t) =>
        byKey
          .get(`${b}:${f}:${t}`)
          ?.runs.map((r) => r.text)
          .join('') ?? '',
      fontFamily: 'serif',
      fontSizePt: 11,
      runs: runsOf,
    };
    root = document.createElement('div');
    document.body.append(root);
    paintTree(root, tree, source);
    for (const el of root.querySelectorAll<HTMLElement>('.de-line')) {
      const key = `${el.dataset['block']}:${el.dataset['from']}:${el.dataset['to']}`;
      const line = byKey.get(key);
      if (!line || !line.comparable) {
        skipped++;
        continue;
      }
      let width = 0;
      for (const run of el.querySelectorAll<HTMLElement>('.de-run'))
        width += run.getBoundingClientRect().width;
      painted.set(key, rounded(width));
      diffs.set(key, rounded(width - line.widthPt * PX_PER_PT));
    }
  });

  afterAll(() => {
    for (const ff of added) document.fonts.delete(ff);
    root?.remove();
  });

  it('paints every page of the stored tree, with the faces loaded', () => {
    expect(pages).toBeGreaterThan(1);
    expect(root.querySelectorAll('.de-page').length).toBe(pages);
    expect(painted.size).toBeGreaterThan(100);
    for (const face of golden!.faces)
      expect(document.fonts.check(`16px "${face.alias}"`), face.file).toBe(true);
  });

  it('paints every compared line as wide as its computed width, within half a pixel (criterion 1)', () => {
    const over = [...diffs].filter(([, d]) => Math.abs(d) > HALF_PIXEL);
    expect(
      over.map(([k, d]) => `${k}: ${d} px`).slice(0, 10),
      `${over.length} of ${diffs.size} lines differ by more than ${HALF_PIXEL} px`,
    ).toEqual([]);
  });

  it('reports the distribution of the width differences of this browser (criterion 5)', async () => {
    const values = [...diffs.values()];
    const abs = values.map(Math.abs).sort((a, b) => a - b);
    const report = {
      browser: server.browser,
      document: golden!.document,
      measurer: golden!.measurer,
      unit: 'CSS px, painted minus computed',
      pages,
      compared: values.length,
      skipped,
      min: Math.min(...values),
      max: Math.max(...values),
      meanAbsolute: rounded(abs.reduce((s, v) => s + v, 0) / Math.max(1, abs.length)),
      absoluteP50: quantile(abs, 0.5),
      absoluteP95: quantile(abs, 0.95),
      absoluteMax: abs[abs.length - 1] ?? 0,
      over: values.filter((v) => Math.abs(v) > HALF_PIXEL).length,
      target: HALF_PIXEL,
    };
    console.info(`FE-094 width differences (${server.browser}): ${JSON.stringify(report)}`);
    await commands.writeFile(
      `test-results/evidence/fe-094-widths.${server.browser}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    expect(report.compared).toBeGreaterThan(100);
  });

  it('paints the widths this browser stored, or fails until the stored file is written again (criterion 2)', async () => {
    const file = `packages/painter/golden/fe-094-pages-20.painted.${server.browser}.json`;
    let stored: string | null;
    try {
      stored = await commands.readFile(file);
    } catch {
      stored = null;
    }
    const now: Record<string, number> = {};
    for (const [k, v] of painted) now[k] = v;
    if (stored === null) {
      await commands.writeFile(
        file,
        `${JSON.stringify({ browser: server.browser, widthsPx: now })}\n`,
      );
      expect.fail(
        `no stored widths for ${server.browser}: ${file} was written, review it and commit it`,
      );
    }
    const before = (JSON.parse(stored) as { widthsPx: Record<string, number> }).widthsPx;
    const gone = Object.keys(before).filter((k) => !(k in now));
    const fresh = Object.keys(now).filter((k) => !(k in before));
    const moved = Object.keys(now)
      .filter((k) => k in before && Math.abs(now[k]! - before[k]!) > STORED_DRIFT_PX)
      .map((k) => `${k}: ${before[k]} -> ${now[k]}`);
    expect({ gone, fresh, moved: moved.slice(0, 10) }).toEqual({ gone: [], fresh: [], moved: [] });
  });
});
