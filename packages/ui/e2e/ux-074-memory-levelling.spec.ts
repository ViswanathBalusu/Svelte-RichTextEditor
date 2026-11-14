/**
 * Does the heap level off under repeated pane use? (UX-074, criterion 2, lane V-UX-061-075.)
 *
 * The earlier ux-074-memory.spec.ts read the heap after 30 cycles and found growth well above its
 * noise, not yet levelled. This run goes longer: 120 open-and-close cycles of the five panes, with a
 * reading after each block of 10 cycles, so the growth per block shows whether it flattens. It
 * records the figures in the annotations and the console and asserts only that the cycles ran; the
 * criterion is judged from the figures, in the story Notes. Chromium only (Chrome DevTools Protocol).
 *
 * Run with `DOCEDIT_UI_PORT=57292 DOCEDIT_BROWSERS=chromium pnpm exec playwright test -c packages/ui/playwright.config.ts ux-074-memory-levelling --output <scratchpad>`.
 */
import { type CDPSession, type Page } from '@playwright/test';
import { expect, harness, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const },
];

const PANES = [
  'view.outline',
  'view.styles',
  'view.permissions',
  'view.recovered',
  'view.shortcuts',
] as const;

const WARM_PASSES = 20;
const CYCLES = 120;
const BLOCK = 10;

async function usedHeap(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
  return usage.usedSize;
}

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

test.describe('heap levelling across repeated pane use (UX-074, criterion 2)', () => {
  test.setTimeout(1_800_000);

  test('the heap after each block of cycles, and the growth per block', async ({
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

    for (const id of PANES) await openAndClose(page, run, id);
    for (let pass = 0; pass < WARM_PASSES; pass++)
      for (const id of PANES) await openAndClose(page, run, id);

    const readings: number[] = [];
    for (let i = 0; i < 5; i++) readings.push(await usedHeap(cdp));
    const baseline = readings[readings.length - 1]!;
    const noise = Math.max(...readings) - Math.min(...readings);

    const blocks: number[] = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      for (const id of PANES) await openAndClose(page, run, id);
      if (cycle % BLOCK === 0) blocks.push(await usedHeap(cdp));
    }

    const growthPerBlock = blocks.map((b, i) => b - (i === 0 ? baseline : blocks[i - 1]!));
    const totalGrowth = blocks[blocks.length - 1]! - baseline;

    test.info().annotations.push({
      type: 'heap-levelling',
      description: JSON.stringify({
        figure: 'Runtime.getHeapUsage().usedSize after two HeapProfiler.collectGarbage calls',
        browser: 'chromium',
        baselineBytes: baseline,
        noiseBytes: noise,
        blockBytes: blocks,
        growthPerBlockBytes: growthPerBlock,
        totalGrowthBytes: totalGrowth,
        blockSize: BLOCK,
        cycles: CYCLES,
      }),
    });
    console.log(
      `ux-074 levelling (chromium): baseline ${baseline} B, noise ${noise} B, growth per ${BLOCK} cycles ${growthPerBlock.join(', ')} B, total ${totalGrowth} B`,
    );
    expect(blocks).toHaveLength(CYCLES / BLOCK);
    expect(await harness(page).commandIds()).toContain('view.outline');
  });
});
