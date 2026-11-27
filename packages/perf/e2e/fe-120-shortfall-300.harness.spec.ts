/**
 * FE-120 criterion 5 (lane V-BE-085-098 fixer, group 3 round 3): the typing shortfall on the
 * 300-page document and its dominant cause, both taken in ONE configuration, so that the cause is
 * the cause of the measured shortfall.
 *
 * Configuration: the reference project (Chromium headless, 1280 x 800, scale 1, the profile's CPU
 * throttling rate), Playwright tracing OFF, `backend=hold` (the in-page mock backend never answers
 * a commit, so no backend work runs on the page), one page, opened as `harness.spec.ts` opens it
 * (throttle, load, wait for five seconds without a long task).
 *
 * Three passes on the same page, one after the other:
 * 1. Measurement: keystrokes in the middle of the document, no instrumentation, latency by the
 *    Event Timing API with the method of `harness.spec.ts` (per keystroke the longest entry of its
 *    interaction; censored nearest-rank quantiles over all keystrokes sent). This is the shortfall.
 * 2. Attribution: the same typing under a Chromium performance trace (devtools.timeline and v8
 *    categories). Main-thread self time per trace event is split into scripting, style, layout,
 *    paint and compositing, garbage collection, event dispatch and other. This attributes the
 *    native work that a CPU profile shows only as `(program)`.
 * 3. JavaScript split: the same typing under the CPU profiler, with the inclusive time of the
 *    editor's transaction path (`applyTransaction`, `filterTransaction`, `nodesBetween`) and of
 *    ProseMirror's view update, so that the scripting share can be named by function.
 *
 * The passes run on `pages-100` and on `pages-300`, and a last test checks the dominant cause: the
 * causes that grow with the document (the filter walk and the selection sync) are together the
 * largest part of the main-thread time per keystroke on `pages-300` (over 40 per cent, and more
 * than twice any other cause), and each grows more than twofold from `pages-100`.
 *
 * The figures are of the machine the test runs on. They are recorded with that fact and are not
 * judged against a target: a target counts only on the reference machine of ADR 0037.
 *
 * Output: packages/perf/test-results/fe-120-shortfall-300.json.
 *
 * Run: DOCEDIT_PERF_PORT=57381 pnpm exec playwright test -c packages/perf/playwright.config.ts \
 *   fe-120-shortfall-300 --project=reference
 */
import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';
import { censoredQuantile, summarise } from '../src/stats.ts';
import { browserInfo, cpuLoad, machineInfo, runProfile, throttle, writeJson } from './helpers.ts';

// The DOM snapshotter of a Playwright trace runs inside the page and distorts what is measured.
test.use({ trace: 'off' });

const BACKEND_MODE = 'hold';
const MEASURE_KEYS = Number(process.env['DOCEDIT_KEYSTROKES'] ?? 150);
const TRACE_KEYS = 60;
const PROFILE_KEYS = 60;
const KEY_GAP_MS = 80;
const QUIET_MS = 5_000;
const TEXT = 'the quick brown fox jumps over the lazy dog while the editor keeps up ';
const profile = runProfile();

interface PerfEntry {
  startTime: number;
  duration: number;
  interactionId?: number;
}
interface PerfState {
  longTasks: PerfEntry[];
  events: PerfEntry[];
  readyAt?: number;
  error?: string;
}
const perfState = (page: Page): Promise<PerfState> =>
  page.evaluate(() => {
    const p = (globalThis as unknown as { __perf: PerfState }).__perf;
    return JSON.parse(
      JSON.stringify({
        longTasks: p.longTasks,
        events: p.events,
        readyAt: p.readyAt,
        error: p.error,
      }),
    ) as PerfState;
  });

/** Types `keys` characters at the caret with the harness's gap; returns Event Timing per keystroke. */
async function type(page: Page, keys: number): Promise<{ total: number; reported: number[] }> {
  const before = (await perfState(page)).events.length;
  for (let i = 0; i < keys; i++) {
    const ch = TEXT[i % TEXT.length]!;
    await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    await page.waitForTimeout(KEY_GAP_MS);
  }
  await page.waitForTimeout(1_000);
  const entries = (await perfState(page)).events
    .slice(before)
    .filter((e) => (e.interactionId ?? 0) > 0);
  const byInteraction = new Map<number, number>();
  for (const e of entries)
    byInteraction.set(
      e.interactionId!,
      Math.max(byInteraction.get(e.interactionId!) ?? 0, e.duration),
    );
  return { total: keys, reported: [...byInteraction.values()] };
}

const quantiles = (t: { total: number; reported: number[] }) => {
  const p50 = censoredQuantile(t.reported, t.total, 0.5, 16);
  const p95 = censoredQuantile(t.reported, t.total, 0.95, 16);
  return {
    keystrokes: t.total,
    reportedAtOrOver16: t.reported.length,
    p50: p50.below ? '<16' : p50.value,
    p95: p95.below ? '<16' : p95.value,
  };
};

// ---------------------------------------------------------------------------------------------
// Pass 2: the performance trace.

interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: { type?: string } };
}

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'toplevel',
  'v8',
  'v8.execute',
  'blink',
  'blink.user_timing',
  'disabled-by-default-v8.gc',
  'latencyInfo',
];

async function traced(cdp: CDPSession, work: () => Promise<void>): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (m) => {
    for (const e of m.value as unknown as TraceEvent[]) events.push(e);
  });
  const done = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()));
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: TRACE_CATEGORIES, recordMode: 'recordAsMuchAsPossible' },
  });
  await work();
  await cdp.send('Tracing.end');
  await done;
  return events;
}

const CATEGORIES = [
  'scripting',
  'selectionSync',
  'styleAndLayout',
  'paintAndCompositing',
  'spellcheck',
  'gc',
  'eventDispatch',
  'hitTest',
  'taskOverhead',
  'other',
] as const;
type Category = (typeof CATEGORIES)[number];

/**
 * The category of a trace event by its name. `selectionSync` is Blink's work to report the
 * selection to the browser process after a change (`Editor::SyncSelection`, `GetSelectionOffsets`),
 * which a CPU profile shows only as `(program)`.
 */
function categoryOf(name: string): Category {
  if (
    /^(Editor::SyncSelection|GetSelectionOffsets|FrameSelection|SelectionController|TextInput)/.test(
      name,
    )
  )
    return 'selectionSync';
  if (/SpellCheck/i.test(name)) return 'spellcheck';
  if (/GC|^BlinkGC|^ThreadState::|^CppGC/.test(name)) return 'gc';
  if (
    /^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|ScheduleStyleRecalculation|StyleEngine|Layout|LocalFrameView::performLayout|LocalFrameView::UpdateStyleAndLayout|Document::UpdateStyleAndLayout|Blink\.ForcedStyleAndLayout|Blink\.Style|Blink\.Layout|IntersectionObserverController::computeIntersections|ResizeObserver)/.test(
      name,
    )
  )
    return 'styleAndLayout';
  if (
    /^(PrePaint|Paint|Layerize|UpdateLayerTree|UpdateLayer|CompositeLayers|Commit|PaintImage|Decode|RasterTask|LocalFrameView::RunPostLifecycleSteps|LocalFrameView::UpdateLifecyclePhases|WebFrameWidgetImpl::UpdateLifecycle|Blink\.)/.test(
      name,
    )
  )
    return 'paintAndCompositing';
  if (name === 'EventDispatch') return 'eventDispatch';
  if (name === 'HitTest') return 'hitTest';
  if (
    /^(FunctionCall|EvaluateScript|v8\.|V8\.|RunMicrotasks|TimerFire|FireAnimationFrame|FireIdleCallback|v8::|EventTiming|ScheduleIdle)/.test(
      name,
    )
  )
    return 'scripting';
  if (/^(RunTask|ThreadControllerImpl::RunTask|ThreadPool|SequenceManager)/.test(name))
    return 'taskOverhead';
  return 'other';
}

interface Span {
  name: string;
  start: number;
  end: number;
  self: number;
}

/** Main-thread spans with self time (microseconds), from complete events and begin/end pairs. */
function mainThreadSpans(events: TraceEvent[]): {
  spans: Span[];
  keydowns: number[];
  pid: number;
  tid: number;
} {
  const mains = events.filter(
    (e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain',
  );
  // The page's main thread: the renderer main thread that dispatched the keydowns.
  let best: { pid: number; tid: number; n: number } | null = null;
  for (const m of mains) {
    const n = events.filter(
      (e) =>
        e.pid === m.pid &&
        e.tid === m.tid &&
        e.name === 'EventDispatch' &&
        e.args?.data?.type === 'keydown',
    ).length;
    if (!best || n > best.n) best = { pid: m.pid, tid: m.tid, n };
  }
  if (!best) return { spans: [], keydowns: [], pid: -1, tid: -1 };
  const mine = events.filter((e) => e.pid === best.pid && e.tid === best.tid);
  const raw: { name: string; start: number; end: number }[] = [];
  const open = new Map<string, number[]>();
  for (const e of mine) {
    if (e.ph === 'X' && e.dur !== undefined)
      raw.push({ name: e.name, start: e.ts, end: e.ts + e.dur });
    else if (e.ph === 'B') open.set(e.name, [...(open.get(e.name) ?? []), e.ts]);
    else if (e.ph === 'E') {
      const stack = open.get(e.name);
      const start = stack?.pop();
      if (start !== undefined) raw.push({ name: e.name, start, end: e.ts });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: Span[] = [];
  const stack: Span[] = [];
  for (const r of raw) {
    while (stack.length && stack[stack.length - 1]!.end <= r.start) stack.pop();
    const span: Span = { ...r, self: r.end - r.start };
    const parent = stack[stack.length - 1];
    if (parent) parent.self -= Math.min(r.end, parent.end) - r.start;
    spans.push(span);
    stack.push(span);
  }
  const keydowns = mine
    .filter((e) => e.name === 'EventDispatch' && e.args?.data?.type === 'keydown')
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  return { spans, keydowns, pid: best.pid, tid: best.tid };
}

function attribute(events: TraceEvent[]) {
  const { spans, keydowns } = mainThreadSpans(events);
  const byCategory = new Map<Category, number>();
  const byName = new Map<string, number>();
  const perKey: number[] = [];
  const perKeyByCategory = new Map<Category, number[]>();
  // Each keystroke's window runs from its keydown to the next keydown (the last one to 1 s after).
  const windows = keydowns.map((k, i) => [k, keydowns[i + 1] ?? k + 1_000_000] as const);
  let busyInWindows = 0;
  for (const [from, to] of windows) {
    let busy = 0;
    const cat = new Map<Category, number>();
    for (const s of spans) {
      if (s.start < from || s.start >= to || s.self <= 0) continue;
      const c = categoryOf(s.name);
      busy += s.self;
      cat.set(c, (cat.get(c) ?? 0) + s.self);
      byCategory.set(c, (byCategory.get(c) ?? 0) + s.self);
      byName.set(s.name, (byName.get(s.name) ?? 0) + s.self);
    }
    busyInWindows += busy;
    perKey.push(busy / 1000);
    for (const c of CATEGORIES)
      perKeyByCategory.set(c, [...(perKeyByCategory.get(c) ?? []), (cat.get(c) ?? 0) / 1000]);
  }
  const ms = (us: number): number => Math.round(us / 100) / 10;
  const categories = Object.fromEntries(
    [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, us]) => [
        c,
        {
          ms: ms(us),
          share: Math.round((us / Math.max(busyInWindows, 1)) * 1000) / 1000,
          perKeystrokeMedianMs:
            Math.round(summarise(perKeyByCategory.get(c) ?? []).median * 10) / 10,
        },
      ]),
  );
  const topEvents = [...byName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, us]) => ({ name, category: categoryOf(name), ms: ms(us) }));
  const k = summarise(perKey);
  return {
    keydownsInTrace: keydowns.length,
    mainThreadBusyMs: ms(busyInWindows),
    busyPerKeystroke: {
      medianMs: Math.round(k.median * 10) / 10,
      p95Ms: Math.round(k.p95 * 10) / 10,
    },
    categories,
    topEvents,
    dominantCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Pass 3: the CPU profile, by inclusive time of named functions.

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
}

const NAMED = [
  'applyTransaction',
  'filterTransaction',
  'nodesBetween',
  'updateState',
  'updateStateInner',
  'updateChildren',
  'dispatchTransaction',
] as const;

async function cpuProfiled(cdp: CDPSession, work: () => Promise<void>): Promise<CpuProfile> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');
  await work();
  const { profile: p } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile };
  await cdp.send('Profiler.disable');
  return p;
}

function inclusive(p: CpuProfile) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const named = new Map<string, number>(NAMED.map((n) => [n, 0]));
  const special = new Map<string, number>();
  let total = 0;
  let nonIdle = 0;
  let filterWalk = 0;
  const filterCallees = new Map<string, number>();
  p.samples.forEach((id, i) => {
    const us = p.timeDeltas[i + 1] ?? 0;
    total += us;
    const leaf = byId.get(id)?.callFrame.functionName ?? '';
    if (leaf === '(idle)' || leaf === '(program)' || leaf === '(garbage collector)') {
      special.set(leaf, (special.get(leaf) ?? 0) + us);
      if (leaf !== '(idle)') nonIdle += us;
      return;
    }
    nonIdle += us;
    const seen = new Set<string>();
    // The frame directly below the outermost filterTransaction, and whether nodesBetween is on the stack.
    let underFilter: string | null = null;
    let inNodesBetween = false;
    let below: string | null = null;
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const cf = byId.get(cur)?.callFrame;
      const f = cf?.functionName ?? '';
      if (f === 'nodesBetween') inNodesBetween = true;
      // Walking from the leaf up, the first filterTransaction is the innermost: a plugin's filter.
      if (f === 'filterTransaction' && underFilter === null) underFilter = below;
      if (f) below = `${f}@${cf?.url.split('/').pop() ?? ''}`;
      if (named.has(f) && !seen.has(f)) {
        seen.add(f);
        named.set(f, named.get(f)! + us);
      }
    }
    if (seen.has('filterTransaction')) {
      if (inNodesBetween) filterWalk += us;
      if (underFilter !== null)
        filterCallees.set(underFilter, (filterCallees.get(underFilter) ?? 0) + us);
    }
  });
  const ms = (us: number): number => Math.round(us / 100) / 10;
  return {
    sampledMs: ms(total),
    nonIdleMs: ms(nonIdle),
    javascriptMs: ms(
      nonIdle - (special.get('(program)') ?? 0) - (special.get('(garbage collector)') ?? 0),
    ),
    programMs: ms(special.get('(program)') ?? 0),
    garbageCollectorMs: ms(special.get('(garbage collector)') ?? 0),
    idleMs: ms(special.get('(idle)') ?? 0),
    inclusiveMs: Object.fromEntries([...named.entries()].map(([n, us]) => [n, ms(us)])),
    /** Samples with both filterTransaction and nodesBetween on the stack: the filter's document walk. */
    filterNodesBetweenMs: ms(filterWalk),
    /** The functions filterTransaction calls (the plugins' filters), by inclusive time. */
    filterCallees: [...filterCallees.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([f, us]) => ({ function: f, ms: ms(us) })),
  };
}

async function measureDoc(browser: Browser, doc: string) {
  const load = cpuLoad();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/health');
  const cdp = await throttle(page, profile.cpuThrottlingRate);
  await page.goto(`/pages/editor.html?doc=${doc}&backend=${BACKEND_MODE}`);
  await page.waitForFunction(
    () => {
      const p = (globalThis as unknown as { __perf: PerfState }).__perf;
      return p.readyAt !== undefined || p.error !== undefined;
    },
    undefined,
    { timeout: 600_000, polling: 100 },
  );
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

  // A body paragraph in the middle, outside any region (as harness.spec.ts).
  const outside = page.locator('doc-editor .de-editing-surface .de-body > p');
  const paragraphs =
    (await outside.count()) > 0 ? outside : page.locator('doc-editor .de-editing-surface p');
  const target = paragraphs.nth(Math.floor((await paragraphs.count()) / 2));
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(1_000);

  const measured = await type(page, MEASURE_KEYS);
  let tracedTyping: { total: number; reported: number[] } = { total: 0, reported: [] };
  // The CPU profiler runs inside the traced pass too, so that the JavaScript split and the native
  // split are of the same keystrokes.
  const same: { cpu: CpuProfile | null } = { cpu: null };
  const trace = await traced(cdp, async () => {
    same.cpu = await cpuProfiled(cdp, async () => {
      tracedTyping = await type(page, TRACE_KEYS);
    });
  });
  let profiledTyping: { total: number; reported: number[] } = { total: 0, reported: [] };
  const cpu = await cpuProfiled(cdp, async () => {
    profiledTyping = await type(page, PROFILE_KEYS);
  });
  await context.close();

  const shortfall = quantiles(measured);
  const attribution = attribute(trace);
  const js = inclusive(cpu);
  const tracedJs = same.cpu ? inclusive(same.cpu) : null;

  // The causes, per keystroke of the traced pass (trace and CPU profile of the same keystrokes).
  // The filter's document walk is JavaScript, so it is taken out of scripting, not added beside it.
  const perKey = (msTotal: number): number => Math.round((msTotal / TRACE_KEYS) * 10) / 10;
  const cat = (c: Category): number =>
    (attribution.categories as Record<string, { ms: number } | undefined>)[c]?.ms ?? 0;
  const filterWalk = tracedJs?.filterNodesBetweenMs ?? 0;
  const causes = [
    {
      cause: 'transaction filter walk (filterTransaction > nodesBetween, JavaScript)',
      msPerKeystroke: perKey(filterWalk),
    },
    {
      cause: 'other JavaScript',
      msPerKeystroke: perKey(Math.max(0, cat('scripting') - filterWalk)),
    },
    {
      cause: 'selection sync to the browser (Editor::SyncSelection, GetSelectionOffsets; native)',
      msPerKeystroke: perKey(cat('selectionSync')),
    },
    { cause: 'style and layout (native)', msPerKeystroke: perKey(cat('styleAndLayout')) },
    { cause: 'paint and compositing (native)', msPerKeystroke: perKey(cat('paintAndCompositing')) },
    { cause: 'spellcheck (native)', msPerKeystroke: perKey(cat('spellcheck')) },
    {
      cause: 'other native',
      msPerKeystroke: perKey(
        cat('other') + cat('taskOverhead') + cat('eventDispatch') + cat('hitTest') + cat('gc'),
      ),
    },
  ].sort((a, b) => b.msPerKeystroke - a.msPerKeystroke);

  const result = {
    story: 'FE-120',
    criterion: 5,
    lane: 'V-BE-085-098 (fixer, group 3 round 3)',
    takenAt: new Date().toISOString(),
    machine: machineInfo(),
    machineBusy: load.stop(),
    browser: browserInfo(browser, 'chromium'),
    configuration: {
      project: 'reference',
      profile,
      playwrightTrace: 'off',
      backend: BACKEND_MODE,
      document: doc,
      keyGapMs: KEY_GAP_MS,
      note: 'this machine; not judged against a target (ADR 0037 reference machine only)',
    },
    shortfall: {
      method:
        'Event Timing API (durationThreshold 16): per keystroke the longest entry of its interaction; censored nearest-rank quantiles over all keystrokes sent, as harness.spec.ts; no instrumentation during this pass',
      ...shortfall,
      targets: { p50: 16, p95: 50, source: '00 §9' },
    },
    attribution: {
      method:
        'Chromium performance trace (Tracing domain, devtools.timeline, toplevel, v8 and gc categories) of a second typing pass on the same page; self time of each main-thread trace event inside each keystroke window (keydown to next keydown), grouped by event name',
      typingUnderTrace: quantiles(tracedTyping),
      ...attribution,
      javascriptInSamePass: tracedJs,
    },
    causes: {
      method:
        "main-thread time per keystroke of the traced pass; the filter walk is from the CPU profile of the same keystrokes and is subtracted from the trace's scripting time; sorted, largest first",
      list: causes,
      dominant: causes[0]?.cause ?? null,
    },
    javascript: {
      method:
        'CPU profile (Profiler domain, 1 ms sampling) of a third typing pass on the same page; inclusive time of named functions over non-idle samples',
      typingUnderProfiler: quantiles(profiledTyping),
      ...js,
    },
  };
  console.log(
    `[fe-120] ${doc} shortfall p50 ${shortfall.p50} p95 ${shortfall.p95}; busy/key median ${attribution.busyPerKeystroke.medianMs} ms; dominant ${attribution.dominantCategory}; categories ${JSON.stringify(attribution.categories)}`,
  );
  console.log(`[fe-120] js ${JSON.stringify(js)}`);
  console.log(`[fe-120] causes ${JSON.stringify(causes)}`);

  expect(measured.total).toBe(MEASURE_KEYS);
  expect(attribution.keydownsInTrace).toBeGreaterThanOrEqual(TRACE_KEYS - 1);
  expect(attribution.mainThreadBusyMs).toBeGreaterThan(0);
  expect(attribution.dominantCategory).not.toBeNull();
  expect(js.nonIdleMs).toBeGreaterThan(0);
  return result;
}

type DocResult = Awaited<ReturnType<typeof measureDoc>>;
const results = new Map<string, DocResult>();
// pages-100 beside pages-300 shows which causes grow with the document (the caret is in the middle
// paragraph of each, so the text before it grows threefold).
const DOCS = ['pages-100', 'pages-300'] as const;

test.describe.configure({ mode: 'serial' });

for (const doc of DOCS)
  test(`FE-120: the typing shortfall on ${doc} and its causes, in one configuration`, async ({
    browser,
  }) => {
    test.setTimeout(900_000);
    results.set(doc, await measureDoc(browser, doc));
  });

const FILTER_WALK = 'transaction filter walk (filterTransaction > nodesBetween, JavaScript)';
const SELECTION_SYNC =
  'selection sync to the browser (Editor::SyncSelection, GetSelectionOffsets; native)';

const OTHER_JS = 'other JavaScript';

// Lane w1, 2026-11-27: the transaction filter's walk, the word count and the form field count no
// longer walk the whole document on a keystroke (referenced-targets.ts, word-count.ts,
// frw-072-form-fields.ts), so the filter's share is about zero. What grows with the document now is
// the rest of the JavaScript (the profile of fe-120-profile-300 names the suggestion list, the
// decorations and the form field views) and the browser's selection sync.
test('FE-120: the pages-300 shortfall is per-keystroke work that grows with the document', () => {
  const big = results.get('pages-300');
  const small = results.get('pages-100');
  expect(big).toBeDefined();
  expect(small).toBeDefined();
  const ms = (r: DocResult, cause: string): number =>
    r.causes.list.find((c) => c.cause === cause)?.msPerKeystroke ?? 0;
  const total = (r: DocResult): number => r.causes.list.reduce((s, c) => s + c.msPerKeystroke, 0);
  const proportional = ms(big!, OTHER_JS) + ms(big!, SELECTION_SYNC);
  // The two causes that grow with the document are most of the main-thread time per keystroke.
  expect(proportional / total(big!)).toBeGreaterThan(0.4);
  // The filter's walk is gone from the keystroke: a millisecond at most on the 300-page document.
  expect(ms(big!, FILTER_WALK)).toBeLessThan(1);
  // Each grows with the document: the caret's paragraph is three times further in on pages-300.
  expect(ms(big!, OTHER_JS) / Math.max(ms(small!, OTHER_JS), 1e-9)).toBeGreaterThan(2);
  expect(ms(big!, SELECTION_SYNC) / Math.max(ms(small!, SELECTION_SYNC), 1e-9)).toBeGreaterThan(2);
  // And the shortfall is real in this configuration: the median keystroke misses 16 ms.
  expect(typeof big!.shortfall.p50 === 'number' && big!.shortfall.p50 > 16).toBe(true);
});

test.afterAll(() => {
  const big = results.get('pages-300');
  if (!big) return;
  const small = results.get('pages-100');
  const total = big.causes.list.reduce((s, c) => s + c.msPerKeystroke, 0);
  const proportional = big.causes.list
    .filter((c) => c.cause === OTHER_JS || c.cause === SELECTION_SYNC)
    .reduce((s, c) => s + c.msPerKeystroke, 0);
  const scaling = small
    ? big.causes.list.map((c) => {
        const s = small.causes.list.find((x) => x.cause === c.cause)?.msPerKeystroke ?? 0;
        return {
          cause: c.cause,
          pages100MsPerKeystroke: s,
          pages300MsPerKeystroke: c.msPerKeystroke,
          ratio: s > 0 ? Math.round((c.msPerKeystroke / s) * 100) / 100 : null,
        };
      })
    : null;
  const file = writeJson('fe-120-shortfall-300.json', {
    ...big,
    pages100: small ?? null,
    dominantCause: {
      cause:
        'per-keystroke work that grows with the document: the JavaScript that still walks the whole document on a transaction (the suggestion list, the decorations, the form field views; the guard, the word count and the form field count no longer do), and Blink syncing the selection to the browser over the single editable root',
      msPerKeystroke: Math.round(proportional * 10) / 10,
      ofMainThreadMsPerKeystroke: Math.round(total * 10) / 10,
      share: Math.round((proportional / Math.max(total, 1e-9)) * 1000) / 1000,
    },
    scaling: {
      method:
        'main-thread ms per keystroke of each cause on pages-300 against pages-100, same configuration, same run; a ratio near 3 means the cause grows with the text before the caret',
      list: scaling,
    },
  });
  console.log(`[fe-120] wrote ${file}`);
  console.log(`[fe-120] scaling ${JSON.stringify(scaling)}`);
});
