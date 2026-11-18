/**
 * Typing with the accessibility checker pane open (UX-066 criterion 5, the typing half; the
 * story's targets are UX-072's). Figures only: nothing here ticks a criterion.
 *
 * Method. Chromium only. Each keydown also changes the harness core's revision, as an edit would,
 * so the open pane is asked to follow the document 120 times. The pane works the list out after
 * the document is quiet, so the reads of the document during typing are counted, and the Event
 * Timing `keydown` durations are recorded as in ux-072-typing-latency.spec.ts (CPU throttled four
 * times, `durationThreshold` 16 ms, durations rounded to 8 ms by the API). The harness document is
 * the checker's six-issue fixture, not a 100-page document, and this is not the reference machine.
 *
 * Run with `DOCEDIT_UI_PORT=56294 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-066-checker-typing --project=chromium`.
 */
import { type CDPSession } from '@playwright/test';
import { expect, focusSurface, open, test } from './helpers.ts';

const KEYS = 120;
const CPU_RATE = 4;

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]!;
}

test.describe('typing with the checker pane open (UX-066 criterion 5)', () => {
  test.setTimeout(300_000);

  test('the document is read once after the typing, not on each key (figures of keydown latency recorded)', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Event Timing and CPU throttling are Chromium-only here');
    const h = await open(page, {
      extended: true,
      checker: true,
      permissions: {
        rev: 1,
        docRole: 'editor',
        caps: ['view', 'comment', 'suggest', 'edit'],
        scopes: {},
      },
    });
    await h.exec('view.checker');
    await expect(page.locator('.de-pane[data-pane="checker"]')).toBeVisible();
    const cdp: CDPSession = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    await focusSurface(page);
    const readsBefore = await h.checkerReads();
    await page.evaluate(() => {
      const w = window as unknown as {
        __t: Array<{ name: string; duration: number }>;
        __k: number;
        harness: { burstChecker(n: number): void };
      };
      w.__t = [];
      w.__k = 0;
      // A change of the document on each key, as the core's revision would move.
      window.addEventListener(
        'keydown',
        () => {
          w.__k += 1;
          setTimeout(() => w.harness.burstChecker(1), 0);
        },
        { capture: true },
      );
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[])
          w.__t.push({ name: e.name, duration: e.duration });
      }).observe({
        type: 'event',
        durationThreshold: 16,
        buffered: false,
      } as PerformanceObserverInit);
    });
    await page.keyboard.type('a'.repeat(KEYS), { delay: 0 });
    await h.frames(10);
    await page.waitForTimeout(800);
    const seen = await page.evaluate(() => {
      const w = window as unknown as {
        __t: Array<{ name: string; duration: number }>;
        __k: number;
      };
      return { keydowns: w.__k, timing: w.__t };
    });
    const durations = seen.timing
      .filter((r) => r.name === 'keydown')
      .map((r) => r.duration)
      .sort((a, b) => a - b);
    const reads = (await h.checkerReads()) - readsBefore;
    const figures = {
      figure: 'Event Timing keydown duration with the checker pane open, durationThreshold 16 ms',
      browser: 'chromium',
      cpuThrottle: CPU_RATE,
      keydownEvents: seen.keydowns,
      reportedKeydownEntries: durations.length,
      medianMs: quantile(durations, 0.5),
      p95Ms: quantile(durations, 0.95),
      documentReadsByTheChecker: reads,
      targetsMs: { median: 16, p95: 50 },
      referenceMachine: 'not this machine; document is the six-issue fixture, not 100 pages',
    };
    test.info().annotations.push({ type: 'typing-latency', description: JSON.stringify(figures) });
    console.log(`ux-066 checker typing (chromium, cpu x${CPU_RATE}): ${JSON.stringify(figures)}`);
    expect(seen.keydowns).toBeGreaterThanOrEqual(KEYS);
    // 120 changes while typing: the checker read the document a few times at most, not 120.
    expect(reads).toBeLessThan(20);
    await expect(page.locator('.de-pane[data-pane="checker"] [data-status="count"]')).toBeVisible();
  });
});
