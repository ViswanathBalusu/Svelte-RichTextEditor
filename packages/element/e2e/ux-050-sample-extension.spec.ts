/**
 * The reference host's sample extension in the real element (UX-050 criterion 6; UX-052 criterion
 * 3): a command that inserts a custom block, a side panel and a status-bar item, all set through
 * the element's `extensions` property exactly as the host page sets them
 * (apps/reference-host/src/lib/sample-extension.ts). axe runs on the open panel; the element's
 * suite runs in CI with axe in every supported browser (.github/workflows/ci.yml). Run with
 * `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/ux-050-sample-extension.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { events, openEmbed } from './embed-helpers.ts';

const HOST = 'doc-editor[data-test="sample"]';

async function mount(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      __embed: {
        backend(sub: string, role: string): unknown;
        docId: string;
        sample: { extension: unknown; strings: Record<string, string> };
      };
    };
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      extensions: unknown;
      strings: unknown;
    };
    el.dataset['test'] = 'sample';
    el.strings = { ...w.__embed.sample.strings };
    el.extensions = [w.__embed.sample.extension];
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = w.__embed.backend('ada', 'editor');
    el.setAttribute('doc-id', w.__embed.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  });
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

const exec = (page: Page, command: string) =>
  page.evaluate(
    ([sel, name]) =>
      (document.querySelector(sel!) as unknown as { exec(c: string): { ok: boolean } }).exec(name!)
        .ok,
    [HOST, command],
  );

test.describe('the reference host’s sample extension (UX-050 criterion 6, UX-052 criterion 3)', () => {
  test('its command inserts a custom block, its panel lists it, and axe finds no violation', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page);
    const surface = page.locator(`${HOST} .de-editing-surface`);

    // The extension loaded: its status item is in the bar with a text alternative, and nothing was
    // reported as a problem.
    const status = page.locator(`${HOST} [data-status-item="sample.status"]`);
    await expect(status).toHaveCount(1);
    await expect(status.locator('.de-visually-hidden')).toHaveText(
      'The sample extension is active',
    );
    expect((await events(page, 'de-error')).length).toBe(0);

    // The command: the caret is in a paragraph, and a custom block with the fallback text arrives.
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    expect(await exec(page, 'sample.insert-note')).toBe(true);
    await expect(surface).toContainText('Sample note 1');
    expect(await exec(page, 'sample.insert-note')).toBe(true);
    await expect(surface).toContainText('Sample note 2');

    // The panel: opened by the second command, it draws what the extension holds and takes focus.
    expect(await exec(page, 'sample.open-notes')).toBe(true);
    const pane = page.locator(`${HOST} .de-pane[data-pane="sample-notes"]`);
    await expect(pane).toBeVisible();
    await expect(pane.locator('[data-extension-pane] li')).toHaveText([
      'Sample note 1',
      'Sample note 2',
    ]);
    await expect(pane.getByRole('list', { name: 'Inserted notes' })).toBeVisible();

    // The panel's own button runs the same command.
    await pane.getByRole('button', { name: 'Insert a note' }).click();
    await expect(pane.locator('[data-extension-pane] li')).toHaveCount(3);
    await expect(surface).toContainText('Sample note 3');

    // axe runs on the open panel, which is inside the element's shadow root (UX-052 criterion 3).
    const results = await new AxeBuilder({ page })
      .include([[HOST, '.de-pane[data-pane="sample-notes"]']])
      .analyze();
    expect(results.passes.length).toBeGreaterThan(0);
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

    // Closing the panel removes what it drew; the extension's problems, if any, were non-fatal.
    await pane.getByRole('button', { name: 'Insert a note' }).focus();
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    expect((await events(page, 'de-error')).length).toBe(0);
  });

  test('its import filter inserts a .note file through the guards of typing (UX-055)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page);
    const surface = page.locator(`${HOST} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    expect(await exec(page, 'document.import')).toBe(true);
    const dialog = page.getByRole('dialog', { name: 'Import a file' });
    await expect(dialog.getByRole('listitem')).toHaveText(['Sample notes (.note)']);
    await dialog.getByLabel('File').setInputFiles({
      name: 'todo.note',
      mimeType: 'text/plain',
      buffer: Buffer.from('Imported from a note file.'),
    });
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog.getByRole('status')).toContainText('Imported todo.note.');
    await expect(surface).toContainText('Imported from a note file.');
    expect((await events(page, 'de-error')).length).toBe(0);
  });

  test('removing the extension removes its command, panel and status item', async ({ page }) => {
    await openEmbed(page);
    await mount(page);
    expect(await exec(page, 'sample.open-notes')).toBe(true);
    await expect(page.locator(`${HOST} .de-pane[data-pane="sample-notes"]`)).toBeVisible();
    await page.evaluate((sel) => {
      (document.querySelector(sel) as unknown as { extensions: unknown }).extensions = [];
    }, HOST);
    await expect(page.locator(`${HOST} [data-status-item="sample.status"]`)).toHaveCount(0);
    expect(await exec(page, 'sample.open-notes')).toBe(false);
  });
});
