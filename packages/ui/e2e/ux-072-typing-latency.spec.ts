/**
 * Typing latency with the shell active (UX-072; lane V-UX-061-075).
 *
 * Method. Chromium only: the Event Timing API (`PerformanceObserver`, type `event`) reports the
 * time from a keyboard event's input to the next paint. The page is throttled four times with the
 * Chrome DevTools Protocol (`Emulation.setCPUThrottlingRate`), so that the figures are not those
 * of a fast desktop; this is a stand-in for the reference machine, which the story does not name.
 * The shell is the harness with its panes open, presence of five peers and comment highlights on,
 * which are the harness's own fixtures, not the story's 100-page document.
 *
 * Limits of the method, recorded in the annotation and not hidden:
 * - the API reports only interactions of at least `durationThreshold` (16 ms, the minimum it
 *   accepts) and rounds durations to 8 ms, so the median and 95th percentile here are of the
 *   reported interactions only. The count of keys that were not reported is kept, because a key
 *   under 16 ms is not in the sample at all;
 * - the figures are not a gate: the story's targets apply on the reference machine.
 *
 * Run with `DOCEDIT_UI_PORT=56293 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-072-typing-latency --project=chromium`.
 */
import { type CDPSession, type Page } from '@playwright/test';
import { expect, focusSurface, harness, open, test } from './helpers.ts';

/** Keys typed per run; enough for a stable count, short enough for a quick run. */
const KEYS = 120;
/** CPU slow-down factor, applied through the DevTools Protocol. */
const CPU_RATE = 4;

interface Reported {
  name: string;
  duration: number;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** Starts the Event Timing observer and the count of keydown events, inside the page. */
async function startObserving(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __deTiming: Reported[];
      __deKeydowns: number;
    };
    w.__deTiming = [];
    w.__deKeydowns = 0;
    window.addEventListener(
      'keydown',
      () => {
        w.__deKeydowns += 1;
      },
      { capture: true },
    );
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        w.__deTiming.push({ name: entry.name, duration: entry.duration });
      }
    });
    observer.observe({
      type: 'event',
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit);
  });
}

async function readObserved(page: Page): Promise<{ keydowns: number; reported: Reported[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __deTiming: Reported[]; __deKeydowns: number };
    return { keydowns: w.__deKeydowns, reported: w.__deTiming };
  });
}

test.describe('typing latency with the shell active (UX-072)', () => {
  test.setTimeout(300_000);

  test('measures keystroke-to-paint with panes open and CPU throttled (criterion 1, figures only)', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Event Timing and CPU throttling are Chromium-only here');
    const h = await open(page, { extended: true, presence: [] });
    const cdp: CDPSession = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });

    // The panes of the shell, opened as the author would open them (UX-019).
    for (const id of ['view.outline', 'view.styles', 'view.permissions']) await h.exec(id);
    await expect(page.locator('.de-pane')).toHaveCount(1);

    await focusSurface(page);
    await startObserving(page);
    await page.keyboard.type('a'.repeat(KEYS), { delay: 0 });
    await h.frames(10);

    const { keydowns, reported } = await readObserved(page);
    const keydownDurations = reported
      .filter((r) => r.name === 'keydown')
      .map((r) => r.duration)
      .sort((a, b) => a - b);
    const median = quantile(keydownDurations, 0.5);
    const p95 = quantile(keydownDurations, 0.95);
    const figures = {
      figure:
        'Event Timing duration of keydown entries (input to next paint), durationThreshold 16 ms',
      browser: 'chromium',
      cpuThrottle: CPU_RATE,
      keysTyped: KEYS,
      keydownEvents: keydowns,
      reportedKeydownEntries: keydownDurations.length,
      notReported: keydowns - keydownDurations.length,
      medianMs: median,
      p95Ms: p95,
      targetsMs: { median: 16, p95: 50 },
      referenceMachine: 'not named in the story: not met or measured there',
      sampleCaveat:
        'interactions under 16 ms are not reported by the API; figures are of reported ones',
    };
    test.info().annotations.push({ type: 'typing-latency', description: JSON.stringify(figures) });
    console.log(`ux-072 typing (chromium, cpu x${CPU_RATE}): ${JSON.stringify(figures)}`);

    // The text reached the document and the shell still answers; the figures are recorded above.
    expect(keydowns).toBeGreaterThanOrEqual(KEYS);
    expect(await harness(page).commandIds()).toContain('view.outline');
  });
});
