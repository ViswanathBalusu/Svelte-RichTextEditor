/**
 * Spike S5 (SPK-018): computed against painted line widths, per browser, for canvas `measureText`
 * and for the two WebAssembly shapers, on corpus lines in the manifest's font files.
 *
 * Run in every browser project:
 *   pnpm exec playwright test -c packages/perf/playwright.config.ts s5 --project=chromium --project=msedge --project=firefox --project=webkit
 *
 * The lines come from `pages-20` (every special case, including ligature and kerning words) and
 * the first lines of `pages-100`, cut by a fixed rule (src/lines.ts). Lines with a character
 * missing from its face are left out and counted. Node.js shapes the same lines with the same
 * code, so the digests show whether the shapers' results are identical in every environment.
 * Result: test-results/s5/<project>.json, and test-results/s5/summary.json over the projects
 * run so far.
 */
import { expect, test } from '@playwright/test';
import { corpusStamp, loadDocument } from '@docedit/corpus';
import { toFlow, type CdmEnvelopeLike } from '@docedit/layout';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fontManifest } from '../src/fonts.ts';
import { lineText, sampleLines, type SampleLine } from '../src/lines.ts';
import { coveredLines, differences, shapeLines, type ShapedLines } from '../src/s5.ts';
import { loadHarfbuzz } from '../src/shapers/harfbuzz.ts';
import { harfrustShaper, loadTextKernel } from '../src/shapers/harfrust.ts';
import { histogram, summarise } from '../src/stats.ts';
import { cpuLoad, machineInfo, packageDir, resultsDir, writeJson } from './helpers.ts';

interface NodeSide {
  lines: SampleLine[];
  dropped: number;
  droppedSample: string[];
  hb: { latin: ShapedLines; cjk: ShapedLines; version: string };
  hr: { latin: ShapedLines; cjk: ShapedLines; version: string };
}

let prepared: Promise<NodeSide> | null = null;

async function prepare(): Promise<NodeSide> {
  const all: SampleLine[] = [];
  for (const [doc, limit] of [
    ['pages-20', Infinity],
    ['pages-100', 1500],
  ] as const) {
    const d = await loadDocument(doc);
    all.push(...sampleLines(toFlow(d.envelope as unknown as CdmEnvelopeLike), doc).slice(0, limit));
  }
  const hb = await loadHarfbuzz();
  const rk = await loadTextKernel(
    new Uint8Array(readFileSync(join(packageDir, 'wasm/bin/harfrust-shaper.wasm'))),
  );
  const hr = harfrustShaper(rk.module);
  for (const f of fontManifest.fonts) {
    const bytes = new Uint8Array(readFileSync(join(packageDir, 'fonts', f.file)));
    hb.shaper.loadFont(f.file, bytes);
    hr.loadFont(f.file, bytes);
  }
  const { kept, dropped } = coveredLines(hb.shaper, all);
  const latin = kept.filter((l) => l.role === 'latin');
  const cjk = kept.filter((l) => l.role !== 'latin');
  return {
    lines: kept,
    dropped: dropped.length,
    droppedSample: dropped.slice(0, 5).map(lineText),
    hb: {
      latin: await shapeLines(hb.shaper, latin),
      cjk: await shapeLines(hb.shaper, cjk),
      version: hb.version,
    },
    hr: { latin: await shapeLines(hr, latin), cjk: await shapeLines(hr, cjk), version: hr.name },
  };
}

interface PageWidths {
  default: number[];
  [k: string]: number[];
}

interface ShaperSide {
  version: string;
  latin: ShapedLines;
  cjk: ShapedLines;
  memory: Record<string, number>;
  wasmBytes: number;
  [k: string]: unknown;
}

interface PageResult {
  userAgent: string;
  lineIds: string[];
  shaperOrder: string[];
  fontsMs: number;
  canvas: { widths: PageWidths; support: Record<string, boolean>; ms: number };
  painted: { widths: PageWidths; ms: number };
  harfbuzz: ShaperSide;
  harfrust: ShaperSide;
  compile: Record<string, { compileMs: number[]; instantiateMs: number[] }>;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

test('computed and painted line widths', async ({ page, browserName, browser }, info) => {
  test.setTimeout(900_000);
  prepared ??= prepare();
  const node = await prepared;
  const load = cpuLoad();
  await page.goto('/pages/s5.html');
  await page.waitForFunction(
    () => (globalThis as { __s5?: { ready: boolean } }).__s5?.ready === true,
  );
  const faces = fontManifest.fonts;
  const result = (await page.evaluate(
    (input) =>
      (globalThis as unknown as { __s5: { run(i: unknown): Promise<unknown> } }).__s5.run(input),
    { lines: node.lines, faces, compileRuns: 5 },
  )) as PageResult;
  const busy = load.stop();

  // Shaper widths are in latin-then-CJK order; map them back to the page's line order.
  const index = new Map(result.shaperOrder.map((id, i) => [id, i]));
  const reorder = (
    s: { latin: ShapedLines; cjk: ShapedLines },
    key: 'default' | 'noKernLiga',
  ): number[] => {
    const joined = [...s.latin.widths[key], ...s.cjk.widths[key]];
    return result.lineIds.map((id) => joined[index.get(id)!]!);
  };
  const hb = {
    default: reorder(result.harfbuzz, 'default'),
    plain: reorder(result.harfbuzz, 'noKernLiga'),
  };
  const hr = {
    default: reorder(result.harfrust, 'default'),
    plain: reorder(result.harfrust, 'noKernLiga'),
  };
  const painted = result.painted.widths;
  const canvas = result.canvas.widths;
  const roles = result.lineIds.map((id) => node.lines.find((l) => l.id === id)!.role);
  const pick = (values: number[], role: string | null): number[] =>
    values.filter((_, i) => role === null || roles[i] === role);
  const compare = (a: number[], b: number[]): Record<string, ReturnType<typeof differences>> => ({
    all: differences(a, b),
    latin: differences(pick(a, 'latin'), pick(b, 'latin')),
    cjk: differences(pick(a, 'cjk'), pick(b, 'cjk')),
  });
  // Lines whose width the shaper's ligatures or kerning change, and how the painter follows them.
  const shaped = hb.default.map((w, i) => Math.abs(w - hb.plain[i]!) > 0.01);
  const onlyShaped = (v: number[]): number[] => v.filter((_, i) => shaped[i]);

  const comparisons = {
    'canvas − painted (defaults)': compare(canvas.default, painted.default),
    'canvas − painted (kerning and ligatures off)': compare(canvas.default, painted['none']!),
    ...(canvas['noKerning']
      ? {
          'canvas fontKerning none − painted (off)': compare(canvas['noKerning'], painted['none']!),
        }
      : {}),
    ...(canvas['optimizeSpeed']
      ? {
          'canvas optimizeSpeed − painted (off)': compare(
            canvas['optimizeSpeed'],
            painted['none']!,
          ),
        }
      : {}),
    'harfbuzzjs − painted (defaults)': compare(hb.default, painted.default),
    'harfbuzzjs − painted (explicit kerning and ligatures)': compare(
      hb.default,
      painted['explicit']!,
    ),
    'harfbuzzjs, kerning and ligatures off − painted (off)': compare(hb.plain, painted['none']!),
    'harfbuzzjs − painted (text-spacing-trim: space-all)': compare(
      hb.default,
      painted['spaceAll']!,
    ),
    'canvas − painted (text-spacing-trim: space-all)': compare(
      canvas.default,
      painted['spaceAll']!,
    ),
    'HarfRust − painted (defaults)': compare(hr.default, painted.default),
    'HarfRust − harfbuzzjs': compare(hr.default, hb.default),
    'canvas − harfbuzzjs': compare(canvas.default, hb.default),
  };
  const ligatureKerning = {
    lines: shaped.filter(Boolean).length,
    'harfbuzzjs − painted (defaults)': differences(
      onlyShaped(hb.default),
      onlyShaped(painted.default),
    ),
    'harfbuzzjs − painted (explicit)': differences(
      onlyShaped(hb.default),
      onlyShaped(painted['explicit']!),
    ),
    'shaper effect (default − off)': summarise(
      onlyShaped(hb.default).map((w, i) => w - onlyShaped(hb.plain)[i]!),
    ),
    'painter effect (default − off)': summarise(
      onlyShaped(painted.default).map((w, i) => w - onlyShaped(painted['none']!)[i]!),
    ),
  };
  const digests = {
    node: {
      harfbuzz: [node.hb.latin.digest, node.hb.cjk.digest],
      harfrust: [node.hr.latin.digest, node.hr.cjk.digest],
    },
    page: {
      harfbuzz: [result.harfbuzz.latin.digest, result.harfbuzz.cjk.digest],
      harfrust: [result.harfrust.latin.digest, result.harfrust.cjk.digest],
    },
  };
  const identical = {
    harfbuzzNodeAndPage: digests.node.harfbuzz.join() === digests.page.harfbuzz.join(),
    harfrustNodeAndPage: digests.node.harfrust.join() === digests.page.harfrust.join(),
  };
  const worst = (
    a: number[],
    b: number[],
    n: number,
  ): { id: string; text: string; diff: number }[] =>
    a
      .map((v, i) => ({ id: result.lineIds[i]!, diff: round3(v - b[i]!) }))
      .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
      .slice(0, n)
      .map((w) => ({ ...w, text: lineText(node.lines.find((l) => l.id === w.id)!).slice(0, 120) }));

  const out = {
    schema: 'docedit-perf-s5/1',
    project: info.project.name,
    browserName,
    browserVersion: browser.version(),
    userAgent: result.userAgent,
    machine: machineInfo(),
    machineBusy: busy,
    corpus: corpusStamp(),
    fonts: faces.map((f) => ({ file: f.file, version: f.version, sha256: f.sha256 })),
    lines: {
      measured: node.lines.length,
      latin: roles.filter((r) => r === 'latin').length,
      cjk: roles.filter((r) => r === 'cjk').length,
      droppedForCoverage: node.dropped,
      droppedSample: node.droppedSample,
    },
    canvasSupport: result.canvas.support,
    comparisons,
    ligatureKerning,
    histograms: {
      'canvas − painted (0.05 px bins)': histogram(
        canvas.default.map((v, i) => v - painted.default[i]!),
        0.05,
      ),
      'harfbuzzjs − painted (0.05 px bins)': histogram(
        hb.default.map((v, i) => v - painted.default[i]!),
        0.05,
      ),
    },
    worst: {
      'canvas − painted': worst(canvas.default, painted.default, 8),
      'harfbuzzjs − painted': worst(hb.default, painted.default, 8),
    },
    digests,
    identical,
    timings: {
      fontsMs: result.fontsMs,
      canvasMs: result.canvas.ms,
      paintedMs: result.painted.ms,
      harfbuzzShapeMs: result.harfbuzz.latin.ms + result.harfbuzz.cjk.ms,
      harfrustShapeMs: result.harfrust.latin.ms + result.harfrust.cjk.ms,
    },
    wasm: {
      harfbuzz: {
        version: result.harfbuzz.version,
        bytes: result.harfbuzz.wasmBytes,
        importMs: result.harfbuzz['importMs'],
        instantiateMs: result.harfbuzz['instantiateMs'],
        memory: result.harfbuzz.memory,
      },
      harfrust: {
        version: result.harfrust.version,
        bytes: result.harfrust.wasmBytes,
        fetchMs: result.harfrust['fetchMs'],
        compileMs: result.harfrust['compileMs'],
        instantiateMs: result.harfrust['instantiateMs'],
        memory: result.harfrust.memory,
      },
      compileRuns: Object.fromEntries(
        Object.entries(result.compile).map(([k, v]) => [
          k,
          {
            compileMs: v.compileMs.map(round3),
            instantiateMs: v.instantiateMs.map(round3),
            firstCompileMs: round3(v.compileMs[0]!),
            medianCompileMs: round3(summarise(v.compileMs).median),
          },
        ]),
      ),
    },
    notdef: {
      harfbuzz: result.harfbuzz.latin.notdef + result.harfbuzz.cjk.notdef,
      harfrust: result.harfrust.latin.notdef + result.harfrust.cjk.notdef,
    },
  };
  writeJson(`s5/${info.project.name}.json`, out);
  // Every line's widths, for analysis (not in the summary).
  writeJson(
    `s5/lines/${info.project.name}.json`,
    result.lineIds.map((id, i) => {
      const line = node.lines.find((l) => l.id === id)!;
      return {
        id,
        role: line.role,
        faces: [...new Set(line.segments.map((s) => `${s.face}@${round3(s.sizePx)}`))],
        text: lineText(line),
        canvas: Object.fromEntries(Object.entries(canvas).map(([k, v]) => [k, round3(v[i]!)])),
        painted: Object.fromEntries(Object.entries(painted).map(([k, v]) => [k, round3(v[i]!)])),
        harfbuzz: round3(hb.default[i]!),
        harfbuzzOff: round3(hb.plain[i]!),
        harfrust: round3(hr.default[i]!),
      };
    }),
  );

  // A summary over every project that has run so far.
  const dir = join(resultsDir, 's5');
  const summary: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'summary.json')) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as typeof out;
    summary[r.project] = {
      browser: `${r.browserName} ${r.browserVersion}`,
      lines: r.lines.measured,
      canvasVsPainted: r.comparisons['canvas − painted (defaults)'].all,
      harfbuzzVsPainted: r.comparisons['harfbuzzjs − painted (defaults)'].all,
      harfrustVsHarfbuzz: r.comparisons['HarfRust − harfbuzzjs'].all,
      identical: r.identical,
      digests: r.digests.page,
    };
  }
  if (existsSync(dir)) writeJson('s5/summary.json', summary);

  expect(node.lines.length).toBeGreaterThan(1000);
  expect(result.lineIds.length).toBe(node.lines.length);
});
