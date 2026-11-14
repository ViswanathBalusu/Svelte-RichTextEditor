/**
 * Host replacement strings on the production element (UX-064 criterion 3; UX-063 criterion 2; lane
 * U-UX-061-075). The `strings` property passes replacements by key to the shell's catalogue: an
 * override shows where its key is shown, a key without one falls back, an unknown key is reported
 * to the console, markup stays text, and a change after mount takes effect without a remount.
 * Run with
 * `DOCEDIT_DEMO_PORT=56291 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-064-strings.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { events, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

/**
 * Creates `<doc-editor>` with the strings property set before it connects (a framework's order),
 * mounts it and waits for `de-ready`.
 */
async function mountWithStrings(page: Page, strings: unknown): Promise<void> {
  await page.evaluate(async (value) => {
    const e = (
      window as unknown as {
        __embed: { backend(sub: string, role: string): unknown; docId: string };
      }
    ).__embed;
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      strings: unknown;
    };
    el.dataset['test'] = 'one';
    el.strings = value;
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = e.backend('ada', 'editor');
    el.setAttribute('doc-id', e.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, strings as never);
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

/** The editing toolbar, by its accessible name (role and name, not a test id). */
const toolbarNamed = (page: Page, name: string) =>
  page.locator(EDITOR).getByRole('toolbar', { name, exact: true });

test.describe('host replacement strings on the element (UX-064 criterion 3, UX-063 criterion 2)', () => {
  test('an override by key shows where its key is shown', async ({ page }) => {
    await openEmbed(page);
    await mountWithStrings(page, { 'toolbar.label': 'Writing tools' });
    await expect(toolbarNamed(page, 'Writing tools')).toBeVisible();
    await expect(toolbarNamed(page, 'Editing')).toHaveCount(0);
  });

  test('a key the host omits falls back to the source table', async ({ page }) => {
    await openEmbed(page);
    await mountWithStrings(page, { 'toolbar.label': 'Writing tools' });
    // The share command has no override, so its name is still the source text.
    await expect(
      page.locator(EDITOR).getByRole('button', { name: 'Share', exact: true }),
    ).toBeVisible();
  });

  test('an unknown key is reported to the console, and the editor still mounts', async ({
    page,
  }) => {
    const reports: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') reports.push(m.text());
    });
    await openEmbed(page);
    await mountWithStrings(page, { 'no.such.key': 'x', 'toolbar.label': 'Writing' });
    await expect(toolbarNamed(page, 'Writing')).toBeVisible();
    await expect.poll(() => reports.some((t) => t.includes('no.such.key'))).toBe(true);
    expect(await events(page, 'de-error')).toEqual([]);
  });

  test('an override is shown as text, never as markup', async ({ page }) => {
    await openEmbed(page);
    await mountWithStrings(page, { 'toolbar.label': '<b>Writing</b>' });
    await expect(toolbarNamed(page, '<b>Writing</b>')).toBeVisible();
    const markup = await page.evaluate(
      () =>
        document
          .getElementById('mount')!
          .querySelector('doc-editor')!
          .shadowRoot!.querySelectorAll('b').length,
    );
    expect(markup).toBe(0);
  });

  test('a change after mount takes effect without a remount, and a value that is not an object is ignored', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithStrings(page, null);
    await expect(toolbarNamed(page, 'Editing')).toBeVisible();
    await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="one"]') as HTMLElement & {
        strings: unknown;
      };
      el.strings = { 'toolbar.label': 'Late words' };
    });
    await expect(toolbarNamed(page, 'Late words')).toBeVisible();
    const ignored = await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="one"]') as HTMLElement & {
        strings: unknown;
      };
      el.strings = 'not a table';
      return el.strings;
    });
    expect(ignored).toBeNull();
    await expect(toolbarNamed(page, 'Editing')).toBeVisible();
  });
});
