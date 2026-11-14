/**
 * FE-028 criterion 4 (lane V-FE-017-032). A remote commit that removes the block the selection is
 * in maps the selection onto the document, and the element raises `de-selection` for the block the
 * caret lands in, as it does for a local removal. The remote commit goes through the S1 harness
 * (`RemoteOp` kind `delete`, packages/engine/src/testing.ts).
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts fe-028-remote-delete
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

interface SelectionDetail {
  scope: string;
  blockId: string | null;
}

declare global {
  interface Window {
    __deSel?: SelectionDetail[];
    __ready?: boolean;
  }
}

test('FE-028: a remote commit that removes the selected block raises de-selection for the block the caret moves to', async ({
  page,
}) => {
  // A capture listener set before the page's scripts run, so that `de-ready` is seen whatever the load order.
  await page.addInitScript(() => {
    document.addEventListener('de-ready', () => (window.__ready = true), true);
  });
  // `sync=1` opens the channel, so the session watches the editor and raises the selection events.
  const h = await openS1(page, '?sync=1');
  await expect.poll(() => page.evaluate(() => window.__ready === true)).toBe(true);
  await h.caretIn(SPIKE_IDS.last, 'start');
  await page.evaluate(() => {
    window.__deSel = [];
    document.querySelector('doc-editor')!.addEventListener('de-selection', (event) => {
      window.__deSel!.push((event as CustomEvent<SelectionDetail>).detail);
    });
  });

  expect(await h.remote({ kind: 'delete', node: SPIKE_IDS.last, mode: 'map' })).toBe('applied');

  await expect.poll(() => page.evaluate(() => window.__deSel?.length ?? 0)).toBeGreaterThan(0);
  const raised = await page.evaluate(() => window.__deSel!.at(-1)!);
  const ids = (await h.ids()).map((row) => row.id);
  const sel = await h.selection();

  expect(ids).not.toContain(SPIKE_IDS.last);
  expect(sel.inBody).toBe(true);
  expect(raised.scope).toBe('body');
  expect(raised.blockId).not.toBe(SPIKE_IDS.last);
  expect(ids).toContain(raised.blockId);
});
