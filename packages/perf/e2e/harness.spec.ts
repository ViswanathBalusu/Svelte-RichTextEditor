/**
 * The client performance harness (FND-007) on the reference profile (ADR 0037): the web view of
 * `<doc-editor>` from `@docedit/element` on the shared corpus.
 *
 * - Time to interactive for `pages-20` (13 §9: under 2 seconds), over cold loads.
 * - Keystroke-to-paint latency for `pages-100` with the Event Timing API (00 §9: 16 ms at the
 *   median, 50 ms at the 95th percentile), with scripted typing in the middle of the document.
 * - Memory for `pages-100` after loading and typing (13 §9: under 300 MB).
 * - "Usable to 300 pages" (13 §9) for `pages-300`, by the metric of ADR 0037.
 *
 * Every run writes test-results/runs/<run>.json (src/results.ts), stamped with the machine, the
 * browser, the profile, the corpus version and the commit (DOCEDIT_COMMIT), for the scheduled
 * comparison with a baseline (scripts/compare-baseline.ts).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { corpusStamp } from '@docedit/corpus';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RUN_SCHEMA, type Metric, type RunResult } from '../src/results.ts';
import { censoredQuantile, summarise } from '../src/stats.ts';
import {
  browserInfo,
  cpuLoad,
  machineInfo,
  runId,
  runProfile,
  throttle,
  writeJson,
} from './helpers.ts';

const profile = runProfile();
const id = runId();
const startedAt = new Date().toISOString();
const metrics: Metric[] = [];
const notes: Record<string, unknown> = {};
let browserVersion = 'unknown';

const TTI_LOADS = Number(process.env['DOCEDIT_TTI_LOADS'] ?? 5);
const KEYSTROKES = Number(process.env['DOCEDIT_KEYSTROKES'] ?? 150);
const KEY_GAP_MS = 80;
const QUIET_MS = 5_000;
const TEXT = 'the quick brown fox jumps over the lazy dog while the editor keeps up ';
// DOCEDIT_BACKEND=inline lets the in-page backend answer inside the keystroke, and hold never answers,
// so that no backend work runs on the page at all (src/browser/editor-page.ts).
const BACKEND_MODE = process.env['DOCEDIT_BACKEND'] ?? 'deferred';

interface PerfEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  interactionId?: number;
  processingStart?: number;
  processingEnd?: number;
}

interface PerfState {
  longTasks: PerfEntry[];
  events: PerfEntry[];
  paints: PerfEntry[];
  frames: number[];
  keydowns: number[];
  submitMs: number[];
  readyAt?: number;
  fetchedAt?: number;
  backendMs?: number;
  elementAt?: number;
  documentBytes?: number;
  error?: string;
}

const perfState = (page: Page): Promise<PerfState> =>
  page.evaluate(() => {
    const p = (globalThis as unknown as { __perf: PerfState }).__perf;
    return JSON.parse(JSON.stringify(p)) as PerfState;
  });

/** Opens a corpus document with the profile's throttling and waits for a quiet main thread. */
async function open(
  browser: Browser,
  doc: string,
): Promise<{ page: Page; close: () => Promise<void>; load: Record<string, number | null> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Same-origin first, so that the throttled renderer is the one the document loads in.
  await page.goto('/health');
  await throttle(page, profile.cpuThrottlingRate);
  await page.goto(`/pages/editor.html?doc=${doc}&backend=${BACKEND_MODE}`);
  await page.waitForFunction(
    () => {
      const p = (globalThis as unknown as { __perf: PerfState }).__perf;
      return p.readyAt !== undefined || p.error !== undefined;
    },
    undefined,
    { timeout: 600_000, polling: 100 },
  );
  // Wait for the first window of QUIET_MS without a long task after the editor is ready.
  const deadline = Date.now() + 300_000;
  for (;;) {
    const s = await perfState(page);
    if (s.error) throw new Error(s.error);
    const nowMs = await page.evaluate(() => performance.now());
    const lastEnd = Math.max(s.readyAt ?? 0, ...s.longTasks.map((t) => t.startTime + t.duration));
    if (nowMs - lastEnd >= QUIET_MS) break;
    if (Date.now() > deadline) throw new Error('the main thread never became quiet');
    await page.waitForTimeout(250);
  }
  const s = await perfState(page);
  const fcp = s.paints.find((p) => p.name === 'first-contentful-paint')?.startTime ?? null;
  const from = Math.max(s.readyAt ?? 0, fcp ?? 0);
  // Lighthouse's definition, on a local page without network checks: the end of the last long
  // task before the first quiet window, and never before the editor is ready or first paints.
  const tasksEnds = s.longTasks.map((t) => t.startTime + t.duration).filter((e) => e >= 0);
  const lastTask = tasksEnds.length ? Math.max(...tasksEnds) : 0;
  const tti = Math.max(from, lastTask);
  // The in-memory backend runs in the page (test scaffolding: a host's backend is remote), so its
  // document creation is subtracted from the times the targets are judged on.
  const scaffold = s.backendMs ?? 0;
  return {
    page,
    close: () => context.close(),
    load: {
      fetchedMs: s.fetchedAt ?? null,
      backendMs: s.backendMs ?? null,
      elementMs: s.elementAt ?? null,
      readyMs: s.readyAt ?? null,
      fcpMs: fcp,
      ttiNavigationMs: tti,
      ttiMs: tti - scaffold,
      readyExclBackendMs: s.readyAt === undefined ? null : s.readyAt - scaffold,
      longTasks: s.longTasks.length,
      longestTaskMs: s.longTasks.length ? Math.max(...s.longTasks.map((t) => t.duration)) : 0,
      documentBytes: s.documentBytes ?? null,
    },
  };
}

/** Types into a paragraph in the middle of the document; returns the latency samples. */
async function typeInto(
  page: Page,
  keystrokes: number,
): Promise<{
  total: number;
  reported: number[];
  frames: number[];
  interactionCount: number | null;
  submitMs: number[];
}> {
  // A body paragraph outside any region, so that no permission rule refuses the typing.
  const outside = page.locator('doc-editor .de-editing-surface .de-body > p');
  const paragraphs =
    (await outside.count()) > 0 ? outside : page.locator('doc-editor .de-editing-surface p');
  const count = await paragraphs.count();
  const target = paragraphs.nth(Math.floor(count / 2));
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(1_000);
  const before = await perfState(page);
  const eventsBefore = before.events.length;
  const framesBefore = before.frames.length;
  const submitsBefore = before.submitMs.length;
  const submits = (): Promise<number> =>
    page.evaluate(() => (globalThis as unknown as { __perf: PerfState }).__perf.submitMs.length);
  for (let i = 0; i < keystrokes; i++) {
    const ch = TEXT[i % TEXT.length]!;
    const n = BACKEND_MODE === 'deferred' ? await submits() : 0;
    await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    // The in-page backend does the room's work on this main thread after the frame; wait for it,
    // so that every keystroke starts on an idle main thread, as with a remote backend.
    if (BACKEND_MODE === 'deferred')
      await page
        .waitForFunction(
          (k) => (globalThis as unknown as { __perf: PerfState }).__perf.submitMs.length > k,
          n,
          { timeout: 10_000, polling: 10 },
        )
        .catch(() => undefined);
    await page.waitForTimeout(KEY_GAP_MS);
  }
  await page.waitForTimeout(1_000);
  const after = await perfState(page);
  const entries = after.events.slice(eventsBefore).filter((e) => (e.interactionId ?? 0) > 0);
  const byInteraction = new Map<number, number>();
  for (const e of entries)
    byInteraction.set(
      e.interactionId!,
      Math.max(byInteraction.get(e.interactionId!) ?? 0, e.duration),
    );
  const interactionCount = await page.evaluate(
    () => (performance as unknown as { interactionCount?: number }).interactionCount ?? null,
  );
  return {
    total: keystrokes,
    reported: [...byInteraction.values()],
    frames: after.frames.slice(framesBefore),
    interactionCount,
    submitMs: after.submitMs.slice(submitsBefore),
  };
}

interface MemoryReading {
  rendererPrivateMB: number | null;
  rendererWorkingSetMB: number | null;
  rendererPid: number | null;
  uaSpecificMB: number | null;
  jsHeapUsedMB: number | null;
  domNodes: number | null;
}

function processMemory(pid: number): { privateBytes: number; workingSet: number } | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$p = Get-Process -Id ${pid}; "$($p.PrivateMemorySize64) $($p.WorkingSet64)"`,
        ],
        { encoding: 'utf8' },
      ).trim();
      const [a, b] = out.split(/\s+/).map(Number);
      return { privateBytes: a!, workingSet: b! };
    }
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const priv =
      ['Private_Clean', 'Private_Dirty'].reduce(
        (s, k) => s + Number(new RegExp(`${k}:\\s+(\\d+)`).exec(rollup)?.[1] ?? 0),
        0,
      ) * 1024;
    return { privateBytes: priv, workingSet: rss };
  } catch {
    return null;
  }
}

async function measureMemory(browser: Browser, page: Page): Promise<MemoryReading> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(1_000);
  await cdp.send('Performance.enable');
  const { metrics: m } = (await cdp.send('Performance.getMetrics')) as {
    metrics: { name: string; value: number }[];
  };
  const metric = (n: string): number | null => m.find((x) => x.name === n)?.value ?? null;
  const ua = await page.evaluate(async () => {
    const p = performance as unknown as {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    };
    if (!crossOriginIsolated || !p.measureUserAgentSpecificMemory) return null;
    try {
      return (await p.measureUserAgentSpecificMemory()).bytes;
    } catch {
      return null;
    }
  });
  // The page's renderer: the renderer process with the most private memory (one page is open).
  const bcdp = await browser.newBrowserCDPSession();
  const info = (await bcdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: { type: string; id: number }[];
  };
  let best: { pid: number; privateBytes: number; workingSet: number } | null = null;
  for (const p of info.processInfo.filter((x) => x.type === 'renderer')) {
    const mem = processMemory(p.id);
    if (mem && (!best || mem.privateBytes > best.privateBytes)) best = { pid: p.id, ...mem };
  }
  await bcdp.detach();
  const mb = (b: number | null): number | null =>
    b === null ? null : Math.round((b / 1048576) * 10) / 10;
  return {
    rendererPrivateMB: mb(best?.privateBytes ?? null),
    rendererWorkingSetMB: mb(best?.workingSet ?? null),
    rendererPid: best?.pid ?? null,
    uaSpecificMB: mb(ua),
    jsHeapUsedMB: mb(metric('JSHeapUsedSize')),
    domNodes: metric('Nodes'),
  };
}

function typingMetrics(
  doc: string,
  prefix: string,
  t: Awaited<ReturnType<typeof typeInto>>,
): Metric[] {
  const method =
    'Event Timing API (PerformanceObserver type "event", durationThreshold 16): per keystroke the longest entry of its interaction (keydown, keypress, keyup), durations rounded to 8 ms by the browser; keystrokes below 16 ms are not reported, so a quantile among them is given as "below 16 ms"; nearest-rank quantiles over all keystrokes sent';
  const p50 = censoredQuantile(t.reported, t.total, 0.5, 16);
  const p95 = censoredQuantile(t.reported, t.total, 0.95, 16);
  const frames = summarise(t.frames);
  const base = { document: doc, unit: 'ms' as const, better: 'lower' as const, samples: t.total };
  return [
    {
      ...base,
      id: `${prefix}.p50`,
      value: p50.below ? null : p50.value,
      ...(p50.below ? { below: 16 } : {}),
      target: { max: 16, source: '00 §9' },
      method,
    },
    {
      ...base,
      id: `${prefix}.p95`,
      value: p95.below ? null : p95.value,
      ...(p95.below ? { below: 16 } : {}),
      target: { max: 50, source: '00 §9' },
      method,
    },
    {
      ...base,
      id: `${prefix}.reported`,
      value: t.reported.length,
      unit: 'count',
      better: 'lower',
      method: 'keystrokes whose Event Timing duration reached 16 ms',
    },
    {
      ...base,
      id: `${prefix}.frame.p50`,
      value: round(frames.median),
      method:
        'cross-check: keydown time stamp to the first task after the next animation frame (requestAnimationFrame, then a MessageChannel message); not the target metric',
    },
    {
      ...base,
      id: `${prefix}.frame.p95`,
      value: round(frames.p95),
      method: 'cross-check, as above',
    },
  ];
}

const round = (v: number): number => Math.round(v * 10) / 10;

test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  const result: RunResult = {
    schema: RUN_SCHEMA,
    runId: id,
    startedAt,
    finishedAt: new Date().toISOString(),
    machine: machineInfo(),
    browser: { name: 'chromium', version: browserVersion },
    profile,
    corpus: corpusStamp(),
    commit: process.env['DOCEDIT_COMMIT'] ?? null,
    metrics,
  };
  const file = writeJson(`runs/${id}-${profile.name}.json`, {
    ...result,
    notes: { ...notes, backendMode: BACKEND_MODE },
  });
  console.log(`[harness] wrote ${file}`);
});

test('time to interactive for pages-20', async ({ browser }) => {
  browserVersion = browserInfo(browser, 'chromium').version;
  const load = cpuLoad();
  const loads: Record<string, number | null>[] = [];
  for (let i = 0; i < TTI_LOADS; i++) {
    const o = await open(browser, 'pages-20');
    loads.push(o.load);
    await o.close();
  }
  notes['pages-20'] = { loads, machineBusy: load.stop() };
  const tti = summarise(loads.map((l) => l.ttiMs ?? Number.NaN));
  const ready = summarise(loads.map((l) => l.readyExclBackendMs ?? Number.NaN));
  const method = `median of ${TTI_LOADS} cold loads in new contexts (no HTTP cache): navigation start to the end of the last long task (Long Tasks API, over 50 ms) before the first ${QUIET_MS / 1000} s without one, and never before the editor's de-ready event or the first contentful paint (Lighthouse's definition, without its network condition, since everything is local), less the time the in-page mock backend spent creating the document (test scaffolding; reported as backendMs)`;
  metrics.push(
    {
      id: 'tti',
      document: 'pages-20',
      value: round(tti.median),
      unit: 'ms',
      better: 'lower',
      target: { max: 2000, source: '13 §9' },
      method,
      samples: TTI_LOADS,
    },
    {
      id: 'ready',
      document: 'pages-20',
      value: round(ready.median),
      unit: 'ms',
      better: 'lower',
      method:
        "median of the same loads: navigation start to the element's de-ready event (document fetched, loaded through the in-memory backend and mounted), less the backend's document creation",
      samples: TTI_LOADS,
    },
  );
  console.log(
    `[harness] pages-20 TTI median ${tti.median.toFixed(0)} ms, ready ${ready.median.toFixed(0)} ms`,
  );
  expect(tti.n).toBe(TTI_LOADS);
});

test('keystroke-to-paint latency and memory for pages-100', async ({ browser }) => {
  const load = cpuLoad();
  const o = await open(browser, 'pages-100');
  const typed = await typeInto(o.page, KEYSTROKES);
  const memory = await measureMemory(browser, o.page);
  notes['pages-100'] = {
    load: o.load,
    typed: {
      reported: typed.reported,
      interactionCount: typed.interactionCount,
      frames: typed.frames.map(round),
      backendSubmits: typed.submitMs.length,
      backendSubmitMs: summarise(typed.submitMs),
    },
    memory,
    machineBusy: load.stop(),
  };
  await o.close();
  metrics.push(...typingMetrics('pages-100', 'typing', typed));
  metrics.push(
    {
      id: 'memory',
      document: 'pages-100',
      value: memory.rendererPrivateMB,
      unit: 'MB',
      better: 'lower',
      target: { max: 300, source: '13 §9' },
      method:
        'private memory (Windows PrivateMemorySize64; Linux Private_Clean + Private_Dirty) of the renderer process holding the page, after loading, the typing test and a forced garbage collection (HeapProfiler.collectGarbage); 1 MB = 2^20 bytes',
    },
    {
      id: 'memory.ua',
      document: 'pages-100',
      value: memory.uaSpecificMB,
      unit: 'MB',
      better: 'lower',
      method:
        'performance.measureUserAgentSpecificMemory() on the cross-origin isolated page, same moment',
    },
    {
      id: 'memory.jsHeap',
      document: 'pages-100',
      value: memory.jsHeapUsedMB,
      unit: 'MB',
      better: 'lower',
      method: 'DevTools Performance.getMetrics JSHeapUsedSize, same moment',
    },
  );
  console.log(
    `[harness] pages-100 typing: ${typed.reported.length}/${typed.total} keystrokes at or over 16 ms; memory ${memory.rendererPrivateMB} MB private`,
  );
  expect(typed.total).toBe(KEYSTROKES);
});

test('usable to 300 pages: pages-300 in the web view', async ({ browser }) => {
  const load = cpuLoad();
  const o = await open(browser, 'pages-300');
  const typed = await typeInto(o.page, KEYSTROKES);
  const memory = await measureMemory(browser, o.page);
  notes['pages-300'] = {
    load: o.load,
    typed: {
      reported: typed.reported,
      interactionCount: typed.interactionCount,
      frames: typed.frames.map(round),
      backendSubmits: typed.submitMs.length,
      backendSubmitMs: summarise(typed.submitMs),
    },
    memory,
    machineBusy: load.stop(),
  };
  await o.close();
  metrics.push(...typingMetrics('pages-300', 'usable300.typing', typed));
  metrics.push(
    {
      id: 'usable300.ready',
      document: 'pages-300',
      value: o.load['readyExclBackendMs'] === null ? null : round(o.load['readyExclBackendMs']!),
      unit: 'ms',
      better: 'lower',
      method: 'one cold load: navigation start to de-ready (reported; 13 §9 sets no time for it)',
    },
    {
      id: 'usable300.tti',
      document: 'pages-300',
      value: o.load['ttiMs'] === null ? null : round(o.load['ttiMs']!),
      unit: 'ms',
      better: 'lower',
      method: 'one cold load, time to interactive as for pages-20 (reported; no target)',
    },
    {
      id: 'usable300.memory',
      document: 'pages-300',
      value: memory.rendererPrivateMB,
      unit: 'MB',
      better: 'lower',
      method: 'as for pages-100 (reported; 13 §9 sets 300 MB for 100 pages only)',
    },
  );
  console.log(
    `[harness] pages-300 typing: ${typed.reported.length}/${typed.total} at or over 16 ms; ready ${o.load['readyMs']} ms`,
  );
  expect(typed.total).toBe(KEYSTROKES);
});
