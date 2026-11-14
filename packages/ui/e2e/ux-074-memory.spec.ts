/**
 * Memory of the shell across repeated pane use (UX-074 criteria 2 and 3; lane U-UX-061-075).
 *
 * Method. The figure is the JavaScript heap in use, `Runtime.getHeapUsage().usedSize` after two
 * `HeapProfiler.collectGarbage` calls, read through the Chrome DevTools Protocol. It is measurable
 * in Chromium only: Firefox and WebKit expose no such figure to Playwright, so the test is skipped
 * there. Warm-up: every pane is opened and closed once, then 20 more times, so that the one-time load
 * of each pane's code (UX-070) and the early compilation of the code it runs are not counted as
 * repeated use. The noise is the spread (largest minus smallest) of five readings taken back to back
 * with no action. The heap is then read after each of 30 further cycles.
 *
 * This file records the figures; it does not assert criterion 2. The heap after the cycles is above
 * the baseline by more than the noise, and the heap-object diff of an earlier run was dominated by
 * V8's own code objects, so whether that growth levels off is not yet shown. The story's Notes say so.
 *
 * Run with `DOCEDIT_UI_PORT=56292 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-074-memory`.
 */
import { type CDPSession, type Page } from '@playwright/test';
import { expect, harness, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const },
];

/** The panes of the shell that the harness can open by command (UX-019; 13 section 3). */
const PANES = [
  'view.outline',
  'view.styles',
  'view.permissions',
  'view.recovered',
  'view.shortcuts',
] as const;

/** Warm-up passes over every pane after the first, before the baseline is read. */
const WARM_PASSES = 20;
/** Open-and-close cycles of every pane, each followed by a reading. */
const CYCLES = 30;

interface HeapUsage {
  usedSize: number;
}

/** The JavaScript heap in use, after a full collection. */
async function usedHeap(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const usage = (await cdp.send('Runtime.getHeapUsage')) as HeapUsage;
  return usage.usedSize;
}

/** Opens a pane by its command, then closes it with its close button. */
async function openAndClose(page: Page, run: (id: string) => Promise<unknown>, id: string) {
  await run(id);
  const pane = page.locator('.de-pane');
  await expect(pane).toHaveCount(1);
  await pane
    .getByRole('button', { name: /^Close / })
    .first()
    .click();
  await expect(pane).toHaveCount(0);
}

test.describe('shell memory across repeated pane use (UX-074)', () => {
  test.setTimeout(900_000);

  test('records the heap before and after repeated open and close of each pane (criteria 2 and 3)', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'the heap figure comes from the Chrome DevTools Protocol',
    );
    const h = await open(page, { extended: true, styles: STYLES });
    const run = (id: string) => h.exec(id);
    const cdp = await page.context().newCDPSession(page);

    // Warm-up: the first open of each pane loads its code (UX-070), and the first passes compile it.
    for (const id of PANES) await openAndClose(page, run, id);
    for (let pass = 0; pass < WARM_PASSES; pass++)
      for (const id of PANES) await openAndClose(page, run, id);

    const readings: number[] = [];
    for (let i = 0; i < 5; i++) readings.push(await usedHeap(cdp));
    const baseline = readings[readings.length - 1]!;
    const noise = Math.max(...readings) - Math.min(...readings);

    const perCycle: number[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      for (const id of PANES) await openAndClose(page, run, id);
      perCycle.push(await usedHeap(cdp));
    }
    const after = perCycle[perCycle.length - 1]!;
    const growth = after - baseline;

    test.info().annotations.push({
      type: 'heap-usage',
      description: JSON.stringify({
        figure: 'Runtime.getHeapUsage().usedSize after two HeapProfiler.collectGarbage calls',
        browser: 'chromium',
        baselineBytes: baseline,
        afterBytes: after,
        growthBytes: growth,
        noiseBytes: noise,
        perCycleBytes: perCycle,
        warmPasses: WARM_PASSES,
        cycles: CYCLES,
        panes: PANES.length,
      }),
    });
    console.log(
      `ux-074 heap (chromium): baseline ${baseline} B, noise ${noise} B, after ${CYCLES} cycles ${after} B, growth ${growth} B`,
    );
    // The cycles ran and the shell still answers; the heap figures are recorded above.
    expect(perCycle).toHaveLength(CYCLES);
    expect(await harness(page).commandIds()).toContain('view.outline');
  });
});
