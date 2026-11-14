/**
 * Host extensions on the production element (UX-050, lane V-UX-046-060). The `extensions` property
 * is set before the element connects (a framework's order), each entry is checked on its own, a
 * problem is raised as a non-fatal `de-error` that names the extension, and the others still load.
 * A list set after mount takes effect at once. Run with
 * `DOCEDIT_DEMO_PORT=57281 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-050-extensions.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { events, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

/**
 * Creates the element with the list set before it connects, mounts it and waits for `de-ready`.
 * `mixed` is a valid command, a bad identifier, an unsupported API version and a throwing
 * activation; `empty` is no extension. The list is built in the page, so no code is evaluated.
 */
async function mountWithExtensions(page: Page, kind: 'mixed' | 'empty'): Promise<void> {
  await page.evaluate(async (which) => {
    const e = (
      window as unknown as {
        __embed: { backend(sub: string, role: string): unknown; docId: string };
      }
    ).__embed;
    const command = (id: string) => ({
      id,
      label: 'command.format.bold',
      group: 'ext',
      changesContent: false,
      capability: 'host-panels-and-commands',
      run: () => true,
    });
    const list =
      which === 'mixed'
        ? [
            {
              manifest: { id: 'ext.notes', name: 'Notes', apiVersion: '1' },
              activate: (api: { registerCommand(c: unknown): void }) =>
                api.registerCommand(command('ext.notes.insert')),
            },
            { manifest: { id: 'Bad Id', name: 'Bad', apiVersion: '1' }, activate: () => {} },
            {
              manifest: { id: 'ext.old', name: 'Old', apiVersion: '0' },
              activate: (api: { registerCommand(c: unknown): void }) =>
                api.registerCommand(command('ext.old.cmd')),
            },
            {
              manifest: { id: 'ext.boom', name: 'Boom', apiVersion: '1' },
              activate: (api: { registerCommand(c: unknown): void }) => {
                api.registerCommand(command('ext.boom.cmd'));
                throw new Error('the extension failed while starting');
              },
            },
          ]
        : [];
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      extensions: unknown;
    };
    el.dataset['test'] = 'one';
    // The full layout shows each group as a tab, so the contributed group can be read from the shell.
    el.setAttribute('toolbar', 'full');
    el.extensions = list;
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = e.backend('ada', 'editor');
    el.setAttribute('doc-id', e.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, kind);
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

/** Sets the list on the mounted element, after mount. */
async function setList(page: Page, kind: 'mixed' | 'empty'): Promise<void> {
  await page.evaluate((which) => {
    const command = (id: string) => ({
      id,
      label: 'command.format.bold',
      group: 'ext',
      changesContent: false,
      capability: 'host-panels-and-commands',
      run: () => true,
    });
    const el = document.querySelector('doc-editor[data-test="one"]') as HTMLElement & {
      extensions: unknown;
    };
    el.extensions =
      which === 'mixed'
        ? [
            {
              manifest: { id: 'ext.notes', name: 'Notes', apiVersion: '1' },
              activate: (api: { registerCommand(c: unknown): void }) =>
                api.registerCommand(command('ext.notes.insert')),
            },
          ]
        : [];
  }, kind);
}

/**
 * Whether the shell shows the command `id` now: the extension's group tab is chosen and its button
 * is in the panel. (The element's `exec` answers from the core's own commands, not the shell's
 * registry, so the shell's rendering is what is read here.)
 */
function offered(page: Page, id: string): Promise<boolean> {
  return page.evaluate((command) => {
    const el = document.querySelector('doc-editor[data-test="one"]') as HTMLElement;
    const root = el.shadowRoot;
    const tab = root?.querySelector<HTMLElement>('.de-tab[data-group="ext"]');
    if (!root || !tab) return false;
    tab.click();
    return root.querySelector(`.de-tabpanel [data-command-id="${command}"]`) !== null;
  }, id);
}

test.describe('host extensions on the element (UX-050)', () => {
  test('a bad entry is reported non-fatally by name, the others load, and the unsupported and throwing ones are not kept', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithExtensions(page, 'mixed');
    await expect.poll(async () => (await events(page, 'de-error')).length).toBe(3);
    const reports = (await events(page, 'de-error')).map(
      (e) => e.detail as { message: string; fatal: boolean },
    );
    const messages = reports.map((r) => r.message);
    expect(messages.some((m) => m.startsWith('extension #2 was not loaded:'))).toBe(true);
    expect(
      messages.some(
        (m) => m.startsWith('extension ext.old was not loaded:') && m.includes('API version 0'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m === 'extension ext.boom was not loaded: the extension failed while starting',
      ),
    ).toBe(true);
    for (const r of reports) expect(r.fatal).toBe(false);
    // The valid entry loaded; the throwing one's partial command was undone; editing continues.
    await expect.poll(() => offered(page, 'ext.notes.insert')).toBe(true);
    expect(await offered(page, 'ext.boom.cmd')).toBe(false);
    expect(await offered(page, 'ext.old.cmd')).toBe(false);
    await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
  });

  test('a list set after mount is applied at once: emptied removes the contribution, and set again adds it', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithExtensions(page, 'empty');
    expect(await offered(page, 'ext.notes.insert')).toBe(false);
    await setList(page, 'mixed');
    await expect.poll(() => offered(page, 'ext.notes.insert')).toBe(true);
    await setList(page, 'empty');
    await expect.poll(() => offered(page, 'ext.notes.insert')).toBe(false);
  });
});
