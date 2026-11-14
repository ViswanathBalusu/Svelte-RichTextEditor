/**
 * PRO-082 criterion 2 (lane V-PRO-069-085): host extensions are registered when they are set before
 * the element is upgraded, after it connects but before `doc-id` and the backend, or after loading has
 * started, as `getToken` is (PRO-075). The list is built in the page by a function installed with
 * `addInitScript`, so no code is evaluated (the pages run under a script policy). Each case mounts the
 * element through the embed page with the in-memory backend and reads the shell's group tab to see
 * that the command the extension contributed is offered.
 * Run with `DOCEDIT_DEMO_PORT=57130 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-082-extensions-order.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const COMMAND = 'ext.notes.insert';

/** Offered now: the extension's group tab is chosen and its button is in the panel. */
function offered(page: Page, name: string): Promise<boolean> {
  return page.evaluate(
    ({ sel, command }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      const root = el?.shadowRoot;
      const tab = root?.querySelector<HTMLElement>('.de-tab[data-group="ext"]');
      if (!root || !tab) return false;
      tab.click();
      return root.querySelector(`.de-tabpanel [data-command-id="${command}"]`) !== null;
    },
    { sel: `doc-editor[data-test="${name}"]`, command: COMMAND },
  );
}

test.beforeEach(async ({ page }) => {
  // Installed before each page load: a function that builds the host's list in the page.
  await page.addInitScript((command: string) => {
    (window as unknown as { __makeList: () => unknown[] }).__makeList = () => [
      {
        manifest: { id: 'ext.notes', name: 'Notes', apiVersion: '1' },
        activate: (api: { registerCommand(c: unknown): void }) =>
          api.registerCommand({
            id: command,
            label: 'command.format.bold',
            group: 'ext',
            changesContent: false,
            capability: 'host-panels-and-commands',
            run: () => true,
          }),
      },
    ];
  }, COMMAND);
});

test.describe('PRO-082 extensions set in any order (V-PRO-069-085)', () => {
  test('set on an element that is not yet upgraded (created in an inert document)', async ({
    page,
  }) => {
    await openEmbed(page);
    await page.evaluate(async () => {
      const w = window as unknown as {
        __embed: { backend(sub: string, role: string): unknown; docId: string };
        __makeList: () => unknown[];
      };
      // A node created in a document that does not hold the definition is not upgraded yet.
      const inert = document.implementation.createHTMLDocument('inert');
      const el = inert.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        extensions: unknown;
      };
      el.dataset['test'] = 'pre';
      el.setAttribute('toolbar', 'full');
      el.extensions = w.__makeList();
      el.backend = w.__embed.backend('ada', 'editor');
      el.setAttribute('doc-id', w.__embed.docId);
      const ready = new Promise<void>((resolve) =>
        el.addEventListener('de-ready', () => resolve(), { once: true }),
      );
      document.getElementById('mount')!.append(document.adoptNode(el));
      await ready;
    });
    await expect(page.locator('doc-editor[data-test="pre"] .de-editing-surface')).toBeVisible();
    await expect.poll(() => offered(page, 'pre')).toBe(true);
  });

  test('set after connection and before doc-id, the backend and loading', async ({ page }) => {
    await openEmbed(page);
    await page.evaluate(async () => {
      const w = window as unknown as {
        __embed: { backend(sub: string, role: string): unknown; docId: string };
        __makeList: () => unknown[];
      };
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        extensions: unknown;
      };
      el.dataset['test'] = 'early';
      el.setAttribute('toolbar', 'full');
      document.getElementById('mount')!.append(el);
      el.extensions = w.__makeList();
      el.backend = w.__embed.backend('ada', 'editor');
      const ready = new Promise<void>((resolve) =>
        el.addEventListener('de-ready', () => resolve(), { once: true }),
      );
      el.setAttribute('doc-id', w.__embed.docId);
      await ready;
    });
    await expect(page.locator('doc-editor[data-test="early"] .de-editing-surface')).toBeVisible();
    await expect.poll(() => offered(page, 'early')).toBe(true);
  });

  test('set after loading has started, before de-ready, and the element still loads once', async ({
    page,
  }) => {
    await openEmbed(page);
    await page.evaluate(async () => {
      const w = window as unknown as {
        __embed: { backend(sub: string, role: string): unknown; docId: string };
        __makeList: () => unknown[];
      };
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        extensions: unknown;
      };
      el.dataset['test'] = 'late';
      el.setAttribute('toolbar', 'full');
      el.backend = w.__embed.backend('ada', 'editor');
      el.setAttribute('doc-id', w.__embed.docId);
      const ready = new Promise<void>((resolve) =>
        el.addEventListener('de-ready', () => resolve(), { once: true }),
      );
      document.getElementById('mount')!.append(el);
      // Loading has started; the list arrives before de-ready.
      el.extensions = w.__makeList();
      await ready;
    });
    await expect(page.locator('doc-editor[data-test="late"] .de-editing-surface')).toBeVisible();
    await expect.poll(() => offered(page, 'late')).toBe(true);
    const readyCount = await page.evaluate(
      () =>
        (
          window as unknown as {
            __embed: { events: { name: string; element: string | null }[] };
          }
        ).__embed.events.filter((ev) => ev.name === 'de-ready' && ev.element === 'late').length,
    );
    expect(readyCount).toBe(1);
  });
});
