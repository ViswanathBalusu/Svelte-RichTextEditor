/**
 * FE-124 criterion 4 (lane V-FE-113-128): a host that removes and re-adds the element on route
 * changes, repeatedly. Within the grace period the typed state and the editing core survive each
 * re-add; after the last removal and the grace period the editor is destroyed and nothing of it is
 * left in the page. Uses the embed page and its in-memory backend, as fe-lifecycle.spec.ts does.
 *
 * Run: pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-124-remove-readd.spec.ts
 * with DOCEDIT_DEMO_PORT set to a port in 57070 to 57079.
 */
import { expect, test } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;

interface EmbedHooks {
  internals(el: Element): {
    editor: { core: object } | null;
    suspended: boolean;
    graceScheduled: boolean;
    session: unknown;
  };
}

test.describe('FE-124 criterion 4: repeated remove and re-add', () => {
  test('state survives each re-add inside the grace period, with the same core', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const surface = page.locator(`${editor('one')} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Route one');
    await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el = document.querySelector(sel) as HTMLElement;
      (window as unknown as Record<string, unknown>)['__core'] = e.internals(el).editor!.core;
      (window as unknown as Record<string, HTMLElement>)['__held'] = el;
    }, editor());

    for (let cycle = 0; cycle < 5; cycle++) {
      // Removed by the host (a route change), then re-added to the same container after 2 seconds,
      // well inside the 30-second grace period.
      await page.evaluate(() => {
        (window as unknown as Record<string, HTMLElement>)['__held']!.remove();
      });
      await page.waitForTimeout(2_000);
      const during = await page.evaluate(() => {
        const e = (window as unknown as { __embed: EmbedHooks }).__embed;
        const el = (window as unknown as Record<string, HTMLElement>)['__held']!;
        return {
          suspended: e.internals(el).suspended,
          shells: el.shadowRoot!.querySelectorAll('.de-shell').length,
        };
      });
      expect(during).toEqual({ suspended: true, shells: 1 });
      await page.evaluate(() => {
        document
          .getElementById('mount')!
          .append((window as unknown as Record<string, HTMLElement>)['__held']!);
      });
      await expect(page.locator(editor('one') + ' .de-editing-surface')).toBeVisible();
      const after = await page.evaluate(async (sel) => {
        const e = (window as unknown as { __embed: EmbedHooks }).__embed;
        const el = document.querySelector(sel) as HTMLElement;
        return {
          sameCore:
            e.internals(el).editor?.core ===
            (window as unknown as Record<string, unknown>)['__core'],
          suspended: e.internals(el).suspended,
          shells: el.shadowRoot!.querySelectorAll('.de-shell').length,
        };
      }, editor());
      expect(after).toEqual({ sameCore: true, suspended: false, shells: 1 });
      expect(await bodyText(page, 'one')).toContain('Last paragraph. Route one');
    }

    // Typing still goes to the same editor after the last re-add.
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Route six');
    expect(await bodyText(page, 'one')).toContain('Route six');
  });

  test('after repeated removes, the editor is destroyed once the grace period ends, and not before', async ({
    page,
  }) => {
    await page.clock.install();
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      (window as unknown as Record<string, HTMLElement>)['__held'] = el;
    }, editor());

    for (let cycle = 0; cycle < 4; cycle++) {
      await page.evaluate(() => {
        (window as unknown as Record<string, HTMLElement>)['__held']!.remove();
      });
      await page.clock.runFor(10_000);
      await page.evaluate(() => {
        document
          .getElementById('mount')!
          .append((window as unknown as Record<string, HTMLElement>)['__held']!);
      });
      await page.clock.runFor(1_000);
    }

    // The last removal: still inside the grace period at 27 seconds.
    await page.evaluate(() => {
      (window as unknown as Record<string, HTMLElement>)['__held']!.remove();
    });
    await page.clock.runFor(27_000);
    const early = await page.evaluate(() => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el = (window as unknown as Record<string, HTMLElement>)['__held']!;
      return {
        suspended: e.internals(el).suspended,
        shells: el.shadowRoot!.querySelectorAll('.de-shell').length,
      };
    });
    expect(early).toEqual({ suspended: true, shells: 1 });

    await page.clock.runFor(3_500);
    const late = await page.evaluate(() => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el = (window as unknown as Record<string, HTMLElement>)['__held']!;
      return {
        session: e.internals(el).session,
        graceScheduled: e.internals(el).graceScheduled,
        shells: el.shadowRoot!.querySelectorAll('.de-shell').length,
        connected: el.isConnected,
      };
    });
    expect(late).toEqual({ session: null, graceScheduled: false, shells: 0, connected: false });
  });
});
