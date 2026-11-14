/**
 * PRO-083 criterion 4 in the production element (lane U-PRO-069-085): when the host calls
 * `flush()` before it navigates away, and the connection is healthy, then after the promise
 * resolves a fresh load of the document shows every change. The fresh load is a new
 * `<doc-editor>` on the same page, so it reads the document from the service and not from the
 * removed editor's memory. Run from the repository root with
 * `DOCEDIT_DEMO_PORT=56130 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-083-flush-fresh-load.spec.ts`
 * (Chromium, Edge, Firefox and WebKit).
 */
import { expect, test } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

type Flushable = HTMLElement & { flush(opts?: { timeoutMs?: number }): Promise<void> };

test.describe('PRO-083 criterion 4: a flush before leaving, then a fresh load', () => {
  test('after flush() resolves on a healthy connection, a fresh load shows every change', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });

    const paragraph = page.locator('doc-editor[data-test="one"] .de-editing-surface p', {
      hasText: 'Last paragraph.',
    });
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' First change.');
    await page.keyboard.type(' Second change.');

    // The host waits for the save, then navigates: the editor is removed and a new one loads.
    await page.evaluate(async () => {
      const el = document.querySelector('doc-editor[data-test="one"]') as Flushable;
      await el.flush({ timeoutMs: 10_000 });
    });
    await page.evaluate(() => document.querySelector('doc-editor[data-test="one"]')!.remove());
    await mountEditor(page, { name: 'fresh', sub: 'ada', target: 'mount-2' });

    const text = await bodyText(page, 'fresh');
    expect(text).toContain('First change.');
    expect(text).toContain('Second change.');
  });
});
