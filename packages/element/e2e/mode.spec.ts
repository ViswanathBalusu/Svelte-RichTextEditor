/**
 * The `mode` attribute drives the editing surface (FE-029; 05 §8.1). Uses the embed page
 * (`pages/embed.html`) and its in-memory backend, as element.spec.ts does.
 *
 * Checked here: the surface's `contenteditable` follows a `mode` change while the editor is open,
 * with the same core and the unconfirmed typing kept and later confirmed (FE-029 criterion 7), and
 * a `mode` set before loading. Not checked here: selection and copying in `view` (FE-029 criterion
 * 2), and suggestion mode (FE-041).
 */
import { expect, test, type Page } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;
const surface = (page: Page, name = 'one') => page.locator(`${editor(name)} .de-editing-surface`);

interface CoreProbe {
  mode: { get(): { requested: string; effective: string } };
  syncSummary: { get(): { inflight: string | null; queued: number } };
  saveState: { get(): string };
}

interface EmbedHooks {
  docId: string;
  service: {
    holdWrites(docId: string): { release(): Promise<void> };
    document(docId: string): { content(): { doc: unknown } } | undefined;
  };
  internals(el: Element): { editor: { core: CoreProbe } | null };
}

/** The core's mode, what is unconfirmed, and whether the core is the one kept on `window`. */
function coreState(page: Page, name = 'one') {
  return page.evaluate((sel) => {
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const el = document.querySelector(sel)!;
    const core = e.internals(el).editor!.core;
    const sync = core.syncSummary.get();
    return {
      mode: core.mode.get(),
      unconfirmed: sync.queued + (sync.inflight === null ? 0 : 1),
      saveState: core.saveState.get(),
      sameCore: core === (window as unknown as Record<string, unknown>)['__core'],
      attribute: el.getAttribute('mode'),
    };
  }, editor(name));
}

test.describe('FE-029 the mode attribute drives the editing surface', () => {
  test('a mode change while open updates the surface without a reload and keeps unconfirmed work', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');

    // Writes are held, so the typing stays unconfirmed across the mode changes.
    await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const w = window as unknown as Record<string, unknown>;
      w['__hold'] = e.service.holdWrites(e.docId);
      w['__core'] = e.internals(document.querySelector(sel)!).editor!.core;
    }, editor());
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Unconfirmed');
    await expect.poll(async () => (await coreState(page)).unconfirmed).toBeGreaterThan(0);

    // To view: the surface stops taking input at once, with no document change to carry it.
    await page.evaluate(
      (sel) => document.querySelector(sel)!.setAttribute('mode', 'view'),
      editor(),
    );
    await expect(surface(page)).toHaveAttribute('contenteditable', 'false');
    let s = await coreState(page);
    expect(s).toMatchObject({
      mode: { requested: 'view', effective: 'view' },
      sameCore: true,
      attribute: 'view',
    });
    expect(s.unconfirmed).toBeGreaterThan(0);
    expect(await bodyText(page)).toContain('Last paragraph. Unconfirmed');
    // Typing reaches nothing in view mode.
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Refused');
    expect(await bodyText(page)).not.toContain('Refused');

    // Back to edit: the same core and surface take input again.
    await page.evaluate(
      (sel) => document.querySelector(sel)!.setAttribute('mode', 'edit'),
      editor(),
    );
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
    s = await coreState(page);
    expect(s).toMatchObject({ mode: { requested: 'edit', effective: 'edit' }, sameCore: true });
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Again');
    expect(await bodyText(page)).toContain('Last paragraph. Unconfirmed Again');

    // The held typing is confirmed once the writes go through: nothing was dropped.
    await page.evaluate(() =>
      (window as unknown as { __hold: { release(): Promise<void> } }).__hold.release(),
    );
    await expect.poll(async () => (await coreState(page)).saveState).toBe('saved');
    const server = await page.evaluate(() => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      return JSON.stringify(e.service.document(e.docId)!.content().doc);
    });
    expect(server).toContain('Last paragraph. Unconfirmed Again');
    expect(server).not.toContain('Refused');
  });

  test('fill and an unknown value: fill locks the body, an unknown value is edit', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      (window as unknown as Record<string, unknown>)['__core'] = e.internals(
        document.querySelector(sel)!,
      ).editor!.core;
    }, editor());
    await page.evaluate(
      (sel) => document.querySelector(sel)!.setAttribute('mode', 'fill'),
      editor(),
    );
    await expect(surface(page)).toHaveAttribute('contenteditable', 'false');
    await page.evaluate(
      (sel) => document.querySelector(sel)!.setAttribute('mode', 'unknown'),
      editor(),
    );
    await expect(surface(page)).toHaveAttribute('contenteditable', 'true');
    expect(await coreState(page)).toMatchObject({
      mode: { requested: 'edit', effective: 'edit' },
      sameCore: true,
      attribute: 'unknown',
    });
  });

  test('mode="view" set before loading: the surface does not take input', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', mode: 'view' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'false');
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Refused');
    expect(await bodyText(page)).not.toContain('Refused');
  });

  test('mode="edit" for a viewer: the effective mode is view and the surface does not take input', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'vic', role: 'viewer', mode: 'edit' });
    await expect(surface(page)).toHaveAttribute('contenteditable', 'false');
    expect((await coreState(page)).mode).toEqual({ requested: 'edit', effective: 'view' });
  });
});
