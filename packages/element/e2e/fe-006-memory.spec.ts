/**
 * FE-006 criterion 5 (lane U-FE-001-016): a single-page application mounts and removes a route
 * containing the editor 100 times; after forced garbage collection no editor instance is retained.
 *
 * Each removed editor is left to its grace period (30 seconds, driven by Playwright's fake clock),
 * so the destroy path runs as it would in a single-page application. Weak references to each
 * element and to its editing core are taken in the page; after `HeapProfiler.collectGarbage` the
 * test counts the references that still resolve. Chromium only: the forced collection goes through
 * the Chrome DevTools Protocol.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

interface EmbedHooks {
  internals(el: Element): { editor: { core: object } | null };
}

const CYCLES = 100;

test.describe('FE-006 memory after repeated mount and removal', () => {
  test.setTimeout(600_000);

  test('100 mount and remove cycles retain no editor after forced garbage collection', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'forced collection uses the Chrome DevTools Protocol');
    await page.clock.install();
    await openEmbed(page);
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)['__fe006Refs'] = [];
    });
    for (let i = 0; i < CYCLES; i++) {
      await mountEditor(page, { name: 'one', sub: 'ada' });
      await page.evaluate(() => {
        const e = (window as unknown as { __embed: EmbedHooks }).__embed;
        const refs = (window as unknown as { __fe006Refs: WeakRef<object>[] }).__fe006Refs;
        const el = document.querySelector('doc-editor[data-test="one"]') as HTMLElement;
        refs.push(new WeakRef(el));
        const core = e.internals(el).editor?.core;
        if (core) refs.push(new WeakRef(core));
        el.remove();
      });
      // Past the default 30-second grace period: the removed editor destroys itself.
      await page.clock.runFor(31_000);
    }
    const count = await page.evaluate(() => {
      const refs = (window as unknown as { __fe006Refs: WeakRef<object>[] }).__fe006Refs;
      return refs.length;
    });
    expect(count).toBeGreaterThanOrEqual(CYCLES);

    // Before the forced collection some targets still resolve: the references are live, so the
    // zero below is not a vacuous result.
    const beforeGc = await page.evaluate(() => {
      const refs = (window as unknown as { __fe006Refs: WeakRef<object>[] }).__fe006Refs;
      return refs.filter((r) => r.deref() !== undefined).length;
    });
    expect(beforeGc).toBeGreaterThan(0);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const retained = await page.evaluate(() => {
      const refs = (window as unknown as { __fe006Refs: WeakRef<object>[] }).__fe006Refs;
      return refs.filter((r) => r.deref() !== undefined).length;
    });
    expect(retained).toBe(0);
  });
});
