/**
 * Spike S10 (SPK-023): the two text-kernel prototypes behind one interface (src/kernel/types.ts),
 * in a layout worker, on the shared corpus.
 *
 * - Project `reference` (ADR 0037's profile): cold start, background pagination of `pages-1000`,
 *   opening and typing in `pages-100`, memory; for the TypeScript kernel, the Rust kernel, and the
 *   Rust kernel with hyphenation on.
 * - Projects `chromium`, `msedge`, `firefox`, `webkit`: the same run, to compare the kernels'
 *   outputs across engines; Node.js computes the same digests in this process.
 *
 * Budget written down before measuring (S10 report §2): the kernel may use a quarter of each
 * typing target per keystroke, 4 ms of the 16 ms median and 12.5 ms of the 50 ms 95th percentile.
 * Result: test-results/s10/<project>-<kernel>.json and test-results/s10/node.json.
 */
import { expect, test } from '@playwright/test';
import { corpusStamp, loadDocument } from '@docedit/corpus';
import { sha256Hex } from '@docedit/model';
import { toFlow, type CdmEnvelopeLike } from '@docedit/layout';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fontManifest } from '../src/fonts.ts';
import { kernelParagraphs } from '../src/kernel/paragraphs.ts';
import { rustKernel } from '../src/kernel/rust-kernel.ts';
import { tsKernel } from '../src/kernel/ts-kernel.ts';
import { linesKey, type KernelLine, type TextKernel } from '../src/kernel/types.ts';
import { loadHarfbuzz } from '../src/shapers/harfbuzz.ts';
import { loadTextKernel } from '../src/shapers/harfrust.ts';
import { summarise } from '../src/stats.ts';
import {
  cpuLoad,
  machineInfo,
  packageDir,
  resultsDir,
  runProfile,
  throttle,
  writeJson,
} from './helpers.ts';

const KEYSTROKES = Number(process.env['DOCEDIT_S10_KEYSTROKES'] ?? 300);
const BUDGET = {
  medianMs: 4,
  p95Ms: 12.5,
  source: 'S10 report §2: a quarter of 00 §9 (16 ms median, 50 ms 95th percentile)',
};

interface KeyRecord {
  paragraph: number;
  longest: boolean;
  chars: number;
  kernelMs: number;
  roundTripMs: number;
  lines: number;
}

interface PageRun {
  userAgent: string;
  kernel: string;
  init: Record<string, number | string>;
  paragraphs: { pages100: number; pages1000: number; longestChars: number };
  long: Record<string, unknown> & { digestFull: string | null; digestBreaks: string | null };
  open: {
    kernelMs: number;
    roundTripMs: number;
    lines: number;
    digestFull: string;
    digestBreaks: string;
  };
  keys: KeyRecord[];
  end: { memoryBytes: number; stats: unknown };
}

async function nodeDigests(kind: 'ts' | 'rust'): Promise<Record<string, unknown>> {
  let kernel: TextKernel;
  const t0 = performance.now();
  if (kind === 'ts') kernel = tsKernel((await loadHarfbuzz()).shaper);
  else
    kernel = rustKernel(
      (
        await loadTextKernel(
          new Uint8Array(readFileSync(join(packageDir, 'wasm/bin/text-kernel.wasm'))),
        )
      ).module,
    );
  for (const f of fontManifest.fonts)
    kernel.loadFace(f.file, new Uint8Array(readFileSync(join(packageDir, 'fonts', f.file))));
  const startMs = performance.now() - t0;
  const out: Record<string, unknown> = { kernel: kernel.name, startMs };
  for (const name of ['pages-100', 'pages-1000']) {
    const ps = kernelParagraphs(
      toFlow((await loadDocument(name, { verify: false })).envelope as unknown as CdmEnvelopeLike),
    );
    kernel.clearCache();
    const t = performance.now();
    const results: KernelLine[][] = ps.map((p) => kernel.breakParagraph(p));
    out[name] = {
      paragraphs: ps.length,
      coldMs: performance.now() - t,
      lines: results.reduce((s, r) => s + r.length, 0),
      digestFull: await sha256Hex(results.map(linesKey).join('\n')),
      digestBreaks: await sha256Hex(
        results.map((r) => r.map((l) => `${l.start}-${l.end}`).join(' ')).join('\n'),
      ),
      memoryBytes: kernel.memoryBytes(),
    };
  }
  return out;
}

function summary(run: PageRun): Record<string, unknown> {
  const keys = run.keys;
  const typical = keys.filter((k) => !k.longest);
  const longest = keys.filter((k) => k.longest);
  const s = (xs: number[]): ReturnType<typeof summarise> => summarise(xs);
  const all = s(keys.map((k) => k.kernelMs));
  return {
    kernelPerKeystroke: all,
    roundTripPerKeystroke: s(keys.map((k) => k.roundTripMs)),
    typicalParagraphs: {
      kernel: s(typical.map((k) => k.kernelMs)),
      roundTrip: s(typical.map((k) => k.roundTripMs)),
      chars: s(typical.map((k) => k.chars)),
    },
    longestParagraph: {
      kernel: s(longest.map((k) => k.kernelMs)),
      roundTrip: s(longest.map((k) => k.roundTripMs)),
      chars: run.paragraphs.longestChars,
    },
    withinBudget: { median: all.median <= BUDGET.medianMs, p95: all.p95 <= BUDGET.p95Ms },
  };
}

const kernels: { kind: 'ts' | 'rust'; hyphenate: boolean; label: string }[] = [
  { kind: 'ts', hyphenate: false, label: 'ts' },
  { kind: 'rust', hyphenate: false, label: 'rust' },
  { kind: 'rust', hyphenate: true, label: 'rust-hyphenate' },
];

for (const k of kernels) {
  test(`text kernel ${k.label}`, async ({ page, browser }, info) => {
    test.setTimeout(900_000);
    const reference = info.project.name === 'reference';
    if (!reference && k.hyphenate)
      test.skip(true, 'hyphenation timing runs on the reference profile only');
    const profile = runProfile();
    await page.goto('/pages/s10.html');
    await page.waitForFunction(
      () => (globalThis as { __s10?: { ready: boolean } }).__s10?.ready === true,
    );
    if (reference) await throttle(page, profile.cpuThrottlingRate);
    const load = cpuLoad();
    const run = (await page.evaluate(
      (input) =>
        (globalThis as unknown as { __s10: { run(i: unknown): Promise<unknown> } }).__s10.run(
          input,
        ),
      { kernel: k.kind, keystrokes: KEYSTROKES, hyphenate: k.hyphenate },
    )) as PageRun;
    const busy = load.stop();
    const file = `s10/${info.project.name}-${k.label}.json`;
    writeJson(file, {
      schema: 'docedit-perf-s10/1',
      project: info.project.name,
      browserVersion: browser.version(),
      profile: reference ? profile : null,
      machine: machineInfo(),
      machineBusy: busy,
      corpus: corpusStamp(),
      budget: BUDGET,
      run: { ...run, keys: undefined },
      keys: run.keys,
      summary: summary(run),
    });
    // Node.js digests once per kernel, for the comparison across environments.
    const nodeFile = join(resultsDir, 's10/node.json');
    const nodeAll = existsSync(nodeFile)
      ? (JSON.parse(readFileSync(nodeFile, 'utf8')) as Record<string, unknown>)
      : {};
    if (!k.hyphenate && !nodeAll[k.kind]) {
      nodeAll[k.kind] = await nodeDigests(k.kind);
      writeJson('s10/node.json', nodeAll);
    }
    if (!k.hyphenate) {
      const node = nodeAll[k.kind] as Record<string, { digestFull: string; digestBreaks: string }>;
      console.log(
        `[s10] ${info.project.name} ${k.label}: pages-100 identical to Node.js ${run.open.digestFull === node['pages-100']!.digestFull}, pages-1000 ${run.long.digestFull === node['pages-1000']!.digestFull}`,
      );
    }
    expect(run.keys.length).toBe(KEYSTROKES);
  });
}
