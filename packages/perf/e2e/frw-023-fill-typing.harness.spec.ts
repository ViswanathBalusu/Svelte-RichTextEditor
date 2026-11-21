/**
 * FRW-023 criterion 6 on the reference profile (ADR 0037): keystroke to paint while a participant
 * fills a document at the limits of 12 §3.6, 2,000 fields and 500 rules, in the fill mode of
 * `<doc-editor>`.
 *
 * - The document is built here (it is not a corpus document): 2,000 text fields of one role, ten to
 *   a paragraph, and 500 rules; rule `k` hides field `1000 + k` while field `k` holds `hide`. The
 *   page of the harness (pages/editor.html) is asked for it by name and the request is answered
 *   from this file, so the in-memory backend validates it like any document (I13 to I15).
 * - The keystrokes are real key events on the field's control (Playwright's keyboard), 80 ms apart.
 *   A cycle types `hide` into a field and leaves it with Tab, which submits the entry: the rules
 *   that read the field are evaluated again and the field the rule names goes. Then it types `show`
 *   and the field comes back. Characters and Tab are counted apart: a character is checked while it
 *   is typed, and Tab carries the re-evaluation.
 * - The figure is the Event Timing API's (00 §9; FND-007): per keystroke the longest entry of its
 *   interaction, to the next paint, rounded to 8 ms by the browser and not reported below 16 ms, so
 *   a quantile among the unreported keystrokes is "below 16 ms". The time from the key event to the
 *   first task after the next animation frame is recorded as a cross-check, uncensored.
 * - The first test takes the same keystrokes in two bare text controls on an empty page: the
 *   browser's own keystroke to paint in this mode, at the time of the run. It is what the figures
 *   of the document are read against.
 *
 * Run from the repository root (a port of its own, so that no other run's server is reused):
 *
 *   $env:DOCEDIT_PERF_PORT = '<a free port>'
 *   pnpm exec playwright test -c packages/perf/playwright.config.ts --project=reference e2e/frw-023-fill-typing.harness.spec.ts
 *
 * It writes test-results/runs/<run>-frw-023-<profile>.json and prints one line for each kind of
 * keystroke. Like the harness of FND-007 it records and does not judge: a figure is a measurement
 * of the run that took it, and the test fails only when the page is wrong.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { RUN_SCHEMA, meetsTarget, type Metric } from '../src/results.ts';
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

const FIELDS = 2000;
const RULES = 500;
const ROLE = 'role_tenant';
const DOC = 'frw-023-limits';
const CONTROL = 'bare-text-controls';
const CYCLES = Number(process.env['DOCEDIT_FRW023_CYCLES'] ?? 30);
// DOCEDIT_FRW023_PROFILE=1 also records a CPU profile of the measured keystrokes (DevTools
// `Profiler`), written beside the result as a .cpuprofile file. A profiled run is slower: its
// figures are for finding where the time goes, not for the story.
const PROFILE = process.env['DOCEDIT_FRW023_PROFILE'] === '1';
const KEY_GAP_MS = 80;
const QUIET_MS = 5_000;

type J = Record<string, unknown>;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');
const fieldKey = (i: number): string => `s.f${pad(i, 4)}`;
const fieldId = (i: number): string => `fLimit${pad(i, 10)}`;

/** The document at the limits: 2,000 fields of one role and 500 rules, each with its own target. */
function limitsDocument(): J {
  const defs: J[] = [
    { type: 'settings', attrs: { lang: 'en-GB' } },
    {
      type: 'style_def',
      attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
    },
    { type: 'page_setup', attrs: { id: 'ps1' } },
    { type: 'role_def', attrs: { id: ROLE, name: 'Tenant', color: '#1F77B4' } },
  ];
  for (let k = 0; k < RULES; k++)
    defs.push({
      type: 'rule_def',
      attrs: {
        id: `rLimit${pad(k, 4)}`,
        when: { '==': [{ field: fieldKey(k) }, 'hide'] },
        then: [{ hide: [fieldKey(1000 + k)] }],
      },
    });
  const body: J[] = [];
  for (let p = 0; p < FIELDS / 10; p++) {
    const content: J[] = [];
    for (let j = 0; j < 10; j++) {
      const i = p * 10 + j;
      content.push(
        {
          type: 'form_field',
          attrs: {
            id: fieldId(i),
            key: fieldKey(i),
            kind: 'text',
            label: `Field ${i}`,
            assignee: ROLE,
            value: null,
          },
        },
        { type: 'text', text: ' ' },
      );
    }
    body.push({ type: 'paragraph', attrs: { id: `pLimit${pad(p, 10)}` }, content });
  }
  return {
    cdm: 1,
    requires: ['fields'],
    doc: {
      type: 'doc',
      content: [
        { type: 'defs', content: defs },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

interface PerfEntry {
  name: string;
  startTime: number;
  duration: number;
  interactionId?: number;
}

interface PerfState {
  longTasks: PerfEntry[];
  events: PerfEntry[];
  frames: number[];
  keydowns: number[];
  submitMs?: number[];
  readyAt?: number;
  error?: string;
}

interface KeyDown {
  key: string;
  t: number;
}

/**
 * The observers of pages/editor.html, for a page that has none: Event Timing entries, long tasks,
 * and for each keydown the time to the first task after the next animation frame.
 */
function installObservers(): void {
  const h = { longTasks: [], events: [], keydowns: [], frames: [] } as {
    longTasks: unknown[];
    events: unknown[];
    keydowns: number[];
    frames: number[];
  };
  (globalThis as unknown as { __perf: typeof h }).__perf = h;
  const watch = (type: string, list: unknown[], extra: object = {}): void => {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) list.push(e.toJSON());
    }).observe({ type, buffered: true, ...extra });
  };
  watch('longtask', h.longTasks);
  watch('event', h.events, { durationThreshold: 16 });
  addEventListener(
    'keydown',
    (e) => {
      const start = e.timeStamp;
      requestAnimationFrame(() => {
        const c = new MessageChannel();
        c.port1.onmessage = () => h.frames.push(performance.now() - start);
        c.port2.postMessage(0);
      });
      h.keydowns.push(start);
    },
    true,
  );
}

/** The key of every keydown the page sees, in order, with the event's time stamp. */
function installKeyLog(): void {
  const keys: KeyDown[] = [];
  (globalThis as unknown as { __keys: KeyDown[] }).__keys = keys;
  addEventListener('keydown', (e) => keys.push({ key: e.key, t: e.timeStamp }), true);
}

const perfState = (page: Page): Promise<PerfState> =>
  page.evaluate(() => {
    const p = (globalThis as unknown as { __perf: PerfState }).__perf;
    return JSON.parse(JSON.stringify(p)) as PerfState;
  });

const keyLog = (page: Page): Promise<KeyDown[]> =>
  page.evaluate(() => (globalThis as unknown as { __keys: KeyDown[] }).__keys);

const round = (v: number): number => Math.round(v * 10) / 10;

const KINDS = {
  // A character typed into the control: the entry is checked while it is typed.
  character: (key: string) => key.length === 1,
  // Tab leaves the control: the entry is submitted and the rules that read it are evaluated.
  commit: (key: string) => key === 'Tab',
} as const;

const METHOD =
  'Event Timing API (PerformanceObserver type "event", durationThreshold 16): per keystroke the longest entry of its interaction (keydown, keypress, keyup), from the key event to the next paint, durations rounded to 8 ms by the browser; keystrokes below 16 ms are not reported, so a quantile among them is given as "below 16 ms"; nearest-rank quantiles over all keystrokes of the kind';

/** The metrics of the keystrokes a page saw between two readings of its observers. */
function metricsOf(
  document: string,
  before: PerfState,
  after: PerfState,
  keys: readonly KeyDown[],
): { metrics: Metric[]; summary: Record<string, unknown> } {
  // The frame cross-check has one sample for each keydown, in the order of the keydowns.
  const frames = after.frames.slice(before.frames.length);
  expect(after.keydowns.length - before.keydowns.length).toBe(keys.length);
  expect(frames.length).toBe(keys.length);
  // Event Timing: the longest keyboard entry of each interaction, given to the keydown it follows.
  const reported = new Map<number, number>();
  const entries = after.events
    .slice(before.events.length)
    .filter((e) => (e.interactionId ?? 0) > 0 && /^key(down|press|up)$/.test(e.name));
  for (const e of entries) {
    let at = -1;
    for (let i = 0; i < keys.length; i++) if (keys[i]!.t <= e.startTime + 0.5) at = i;
    if (at >= 0) reported.set(at, Math.max(reported.get(at) ?? 0, e.duration));
  }
  const metrics: Metric[] = [];
  const summary: Record<string, unknown> = {};
  for (const [kind, is] of Object.entries(KINDS)) {
    const index = keys.map((k, i) => (is(k.key) ? i : -1)).filter((i) => i >= 0);
    const durations = index.flatMap((i) => (reported.has(i) ? [reported.get(i)!] : []));
    const p50 = censoredQuantile(durations, index.length, 0.5, 16);
    const p95 = censoredQuantile(durations, index.length, 0.95, 16);
    const frame = summarise(index.map((i) => frames[i]!));
    const base = { document, unit: 'ms' as const, better: 'lower' as const, samples: index.length };
    const median: Metric = {
      ...base,
      id: `frw023.${kind}.p50`,
      value: p50.below ? null : p50.value,
      ...(p50.below ? { below: 16 } : {}),
      target: { max: 16, source: '00 §9; FRW-023 criterion 6' },
      method: METHOD,
    };
    metrics.push(
      median,
      {
        ...base,
        id: `frw023.${kind}.p95`,
        value: p95.below ? null : p95.value,
        ...(p95.below ? { below: 16 } : {}),
        method: METHOD,
      },
      {
        ...base,
        id: `frw023.${kind}.reported`,
        value: durations.length,
        unit: 'count',
        method: 'keystrokes whose Event Timing duration reached 16 ms',
      },
      {
        ...base,
        id: `frw023.${kind}.frame.p50`,
        value: round(frame.median),
        method:
          'cross-check: keydown time stamp to the first task after the next animation frame (requestAnimationFrame, then a MessageChannel message); not the target metric',
      },
      {
        ...base,
        id: `frw023.${kind}.frame.p95`,
        value: round(frame.p95),
        method: 'cross-check, as above',
      },
    );
    summary[kind] = {
      keystrokes: index.length,
      reportedDurations: [...durations].sort((a, b) => a - b),
      frames: index.map((i) => round(frames[i]!)),
    };
    const say = (q: { value: number; below: boolean }): string =>
      q.below ? 'below 16 ms' : `${q.value} ms`;
    console.log(
      `[frw-023] ${document}, ${kind}: ${index.length} keystrokes, ${durations.length} at or over 16 ms; median ${say(p50)} (${meetsTarget(median) ? 'within' : 'over'} the 16 ms of 00 §9), 95th percentile ${say(p95)}; to the frame median ${frame.median.toFixed(1)} ms, 95th ${frame.p95.toFixed(1)} ms`,
    );
    expect(index.length, `${kind} keystrokes`).toBe(kind === 'commit' ? CYCLES * 2 : CYCLES * 8);
  }
  return { metrics, summary };
}

/** Waits for the first window of QUIET_MS without a long task after `from` (page time, ms). */
async function quiet(page: Page, from: number): Promise<void> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const s = await perfState(page);
    if (s.error) throw new Error(s.error);
    const nowMs = await page.evaluate(() => performance.now());
    const lastEnd = Math.max(from, ...s.longTasks.map((t) => t.startTime + t.duration));
    if (nowMs - lastEnd >= QUIET_MS) return;
    if (Date.now() > deadline) throw new Error('the main thread never became quiet');
    await page.waitForTimeout(250);
  }
}

// No trace: Playwright's trace takes a snapshot of the DOM inside the page around every action, on
// the main thread the keystroke is measured on (ADR 0307, item 6).
test.use({ trace: 'off' });
test.describe.configure({ mode: 'serial' });

const profile = runProfile();
const id = runId();
const startedAt = new Date().toISOString();
const metrics: Metric[] = [];
const notes: Record<string, unknown> = {};
let browserVersion = 'unknown';

test.afterAll(() => {
  const file = writeJson(`runs/${id}-frw-023-${profile.name}.json`, {
    schema: RUN_SCHEMA,
    runId: id,
    startedAt,
    finishedAt: new Date().toISOString(),
    machine: machineInfo(),
    browser: { name: 'chromium', version: browserVersion },
    profile,
    commit: process.env['DOCEDIT_COMMIT'] ?? null,
    metrics,
    notes: { story: 'FRW-023 criterion 6', cycles: CYCLES, keyGapMs: KEY_GAP_MS, ...notes },
  });
  console.log(
    `[frw-023] Chromium ${browserVersion}, profile ${profile.name} (CPU rate ${profile.cpuThrottlingRate}); wrote ${file}`,
  );
});

async function newPage(browser: Browser): Promise<Page> {
  browserVersion = browserInfo(browser, 'chromium').version;
  const context = await browser.newContext();
  return context.newPage();
}

test("the browser's own keystroke to paint in this mode: two bare text controls", async ({
  browser,
}) => {
  const load = cpuLoad();
  const page = await newPage(browser);
  await page.addInitScript(installObservers);
  await page.addInitScript(installKeyLog);
  await page.goto('/health');
  await throttle(page, profile.cpuThrottlingRate);
  // The page is reloaded so that it runs in the throttled renderer, then given two controls.
  await page.goto('/health');
  await page.evaluate(() => {
    document.body.replaceChildren();
    for (const name of ['one', 'two']) {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = name;
      input.setAttribute('aria-label', name);
      document.body.append(input);
    }
  });
  await quiet(page, await page.evaluate(() => performance.now()));

  /** The cycle of the document, with no editor: type the word, leave the control with Tab. */
  const enter = async (word: string): Promise<void> => {
    await page.locator('#one').click();
    await page.locator('#one').selectText();
    for (const ch of word) {
      await page.keyboard.press(ch);
      await page.waitForTimeout(KEY_GAP_MS);
    }
    await page.keyboard.press('Tab');
    await page.waitForTimeout(KEY_GAP_MS);
  };
  await enter('hide');
  await enter('show');
  await page.waitForTimeout(1_000);

  const before = await perfState(page);
  const keysBefore = (await keyLog(page)).length;
  for (let c = 0; c < CYCLES; c++) {
    await enter('hide');
    await expect(page.locator('#two')).toBeFocused();
    await enter('show');
  }
  await page.waitForTimeout(1_000);
  await expect(page.locator('#one')).toHaveValue('show');
  const after = await perfState(page);
  const keys = (await keyLog(page)).slice(keysBefore);
  const measured = metricsOf(CONTROL, before, after, keys);
  metrics.push(...measured.metrics);
  notes[CONTROL] = { machineBusy: load.stop(), ...measured.summary };
  await page.context().close();
});

test('keystroke to paint while filling a document of 2,000 fields and 500 rules (FRW-023 criterion 6)', async ({
  browser,
}) => {
  const load = cpuLoad();
  const page = await newPage(browser);
  await page.addInitScript(installKeyLog);
  const envelope = JSON.stringify(limitsDocument());
  await page.route(`**/corpus/${DOC}.cdm.json`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // The headers the harness server sends: the page is cross-origin isolated.
      headers: { 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' },
      body: envelope,
    }),
  );
  // Same-origin first, so that the throttled renderer is the one the document loads in.
  await page.goto('/health');
  const cdp = await throttle(page, profile.cpuThrottlingRate);
  await page.goto(`/pages/editor.html?doc=${DOC}&backend=deferred&fill=${ROLE}`);
  await page.waitForFunction(
    () => {
      const p = (globalThis as unknown as { __perf: PerfState }).__perf;
      return p.readyAt !== undefined || p.error !== undefined;
    },
    undefined,
    { timeout: 600_000, polling: 100 },
  );
  const ready = (await perfState(page)).readyAt ?? 0;
  await quiet(page, ready);

  // The page is the document at the limits, in the fill mode, for a participant of the role.
  const control = (i: number) =>
    page.locator(`doc-editor [data-field="${fieldId(i)}"] .de-form-field-control`);
  const box = (i: number) => page.locator(`doc-editor [data-field="${fieldId(i)}"]`);
  const submits = (): Promise<number> =>
    page.evaluate(
      () => (globalThis as unknown as { __perf: PerfState }).__perf.submitMs?.length ?? 0,
    );
  await expect(page.locator('doc-editor')).toHaveAttribute('mode', 'fill');
  expect(await page.locator('doc-editor .de-form-field').count()).toBe(FIELDS);
  await expect(control(0)).toBeEditable();

  /** Types `word` into field `i` and leaves it with Tab; waits for the backend to take the commit. */
  const enter = async (i: number, word: string): Promise<void> => {
    await control(i).click();
    // Replace what the control holds: select it, then type over it.
    await control(i).selectText();
    for (const ch of word) {
      await page.keyboard.press(ch);
      await page.waitForTimeout(KEY_GAP_MS);
    }
    const n = await submits();
    await page.keyboard.press('Tab');
    // The frame of the keystroke first; nothing of this harness runs in the page meanwhile.
    await page.waitForTimeout(KEY_GAP_MS);
    // The in-page backend does the room's work on this main thread after the frame; wait for it,
    // so that every keystroke starts on an idle main thread, as with a remote backend.
    await page
      .waitForFunction(
        (k) => ((globalThis as unknown as { __perf: PerfState }).__perf.submitMs?.length ?? 0) > k,
        n,
        { timeout: 10_000, polling: 50 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(KEY_GAP_MS);
  };

  // A cycle before the measured ones, so that the code of the keystroke is compiled.
  await enter(999, 'hide');
  await enter(999, 'show');
  await page.waitForTimeout(1_000);

  const before = await perfState(page);
  const keysBefore = (await keyLog(page)).length;
  if (PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
  }
  for (let c = 0; c < CYCLES; c++) {
    const k = 20 + c;
    await enter(k, 'hide');
    // The rule that reads field k hid its target.
    await expect(box(1000 + k)).toHaveAttribute('data-hidden', 'true');
    await expect(box(1000 + k)).toBeHidden();
    await enter(k, 'show');
    await expect(box(1000 + k)).not.toHaveAttribute('data-hidden', 'true');
    await expect(box(1000 + k)).toBeVisible();
  }
  await page.waitForTimeout(1_000);
  if (PROFILE) {
    const { profile: cpu } = (await cdp.send('Profiler.stop')) as { profile: unknown };
    console.log(`[frw-023] CPU profile: ${writeJson(`profiles/${id}-frw-023.cpuprofile`, cpu)}`);
  }
  // No other field went: every field is shown again.
  expect(await page.locator('doc-editor .de-form-field[data-hidden="true"]').count()).toBe(0);

  const after = await perfState(page);
  const keys = (await keyLog(page)).slice(keysBefore);
  const measured = metricsOf(DOC, before, after, keys);
  metrics.push(...measured.metrics);
  const submitMs = (after.submitMs ?? []).slice((before.submitMs ?? []).length);
  notes[DOC] = {
    document: { fields: FIELDS, rules: RULES, mode: 'fill', role: ROLE },
    readyMs: round(ready),
    backendSubmits: submitMs.length,
    backendSubmitMs: summarise(submitMs),
    machineBusy: load.stop(),
    ...measured.summary,
  };
  await page.context().close();
});
