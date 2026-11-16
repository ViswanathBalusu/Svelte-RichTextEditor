/**
 * UX-015 criterion 6 (lane w3): when the host sets the `mode` attribute, or the user chooses a mode
 * in the switcher, the mode in effect is visible (the switcher's button), announced (the shell's
 * status region) and available to the host (`de-mode-change` and the `headerState` property;
 * the event is proposed in ADR 0361, since 05 §8.1 names none). The element, the shell and the
 * in-memory backend are the real ones of the embed page. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/ux-015-mode-in-effect.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { events, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const button = `${editor} .de-mode-button`;

/** Records every text the shell's status region takes, so a later announcement cannot hide one. */
async function recordAnnouncements(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    const region = root.querySelector('.de-visually-hidden[role="status"]')!;
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    new MutationObserver(() => {
      const text = region.textContent.trim();
      if (text !== '' && said.at(-1) !== text) said.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  }, editor);
}

const said = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __said: string[] }).__said);

async function lastModeEvent(page: Page): Promise<unknown> {
  const raised = (await events(page, 'de-mode-change')).filter((e) => e.element === 'one');
  return raised.at(-1)?.detail ?? null;
}

const headerMode = (page: Page): Promise<unknown> =>
  page.evaluate(
    (sel) =>
      (document.querySelector(sel) as HTMLElement & { headerState: { mode: unknown } | null })
        .headerState?.mode ?? null,
    editor,
  );

test.describe('UX-015 the mode in effect is visible, announced and given to the host', () => {
  test('a mode set by the host', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await recordAnnouncements(page);
    await expect(page.locator(button)).toHaveAttribute('data-mode', 'edit');
    await expect(page.locator(button)).toHaveText('Editing');
    await expect(page.locator(button)).toHaveAccessibleName('Mode: Editing');

    await page.evaluate((sel) => document.querySelector(sel)!.setAttribute('mode', 'view'), editor);
    await expect(page.locator(button)).toHaveAttribute('data-mode', 'view');
    await expect(page.locator(button)).toHaveText('Viewing');
    await expect(page.locator(button)).toHaveAccessibleName('Mode: Viewing');
    await expect.poll(() => said(page)).toContain('Mode: Viewing.');
    await expect.poll(() => lastModeEvent(page)).toEqual({ mode: 'view', requested: 'view' });
    expect(await headerMode(page)).toEqual({ mode: 'view', requested: 'view' });

    await page.evaluate((sel) => document.querySelector(sel)!.setAttribute('mode', 'edit'), editor);
    await expect(page.locator(button)).toHaveText('Editing');
    await expect.poll(() => said(page)).toContain('Mode: Editing.');
    await expect.poll(() => lastModeEvent(page)).toEqual({ mode: 'edit', requested: 'edit' });
  });

  test('a mode chosen by the user in the switcher', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await recordAnnouncements(page);
    const before = (await events(page, 'de-mode-change')).filter((e) => e.element === 'one').length;

    await page.locator(button).click();
    const view = page.locator(`${editor} [role="menuitemradio"][data-command-id="mode.view"]`);
    await expect(view).toHaveAttribute('aria-checked', 'false');
    await view.click();

    await expect(page.locator(button)).toHaveAttribute('data-mode', 'view');
    await expect(page.locator(button)).toHaveText('Viewing');
    await expect.poll(() => said(page)).toContain('Mode: Viewing.');
    await expect
      .poll(async () => ((await lastModeEvent(page)) as { mode: string } | null)?.mode)
      .toBe('view');
    const raised = (await events(page, 'de-mode-change')).filter((e) => e.element === 'one');
    expect(raised.length).toBeGreaterThan(before);
    expect([raised.at(-1)!.composed, raised.at(-1)!.bubbles]).toEqual([true, true]);
    expect(((await headerMode(page)) as { mode: string }).mode).toBe('view');

    // The menu shows the mode in effect as the checked item, and the keyboard changes it back.
    await page.locator(button).focus();
    await page.keyboard.press('ArrowDown');
    await expect(view).toHaveAttribute('aria-checked', 'true');
    const edit = page.locator(`${editor} [role="menuitemradio"][data-command-id="mode.edit"]`);
    await edit.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(button)).toHaveText('Editing');
    await expect.poll(() => said(page)).toContain('Mode: Editing.');
    await expect
      .poll(async () => ((await lastModeEvent(page)) as { mode: string } | null)?.mode)
      .toBe('edit');
  });
});
