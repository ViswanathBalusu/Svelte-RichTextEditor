/**
 * FE-065 criterion 3, the read view half: a change of `view` from web to read and back while the
 * element is open keeps the editing core. The session stays open behind the read view, the shell is
 * hidden (not unmounted) while the read view shows, and the same editing surface node and its text
 * come back (ADR 0304 item 1, option a). Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57065 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-065-view-switch.spec.ts`
 * (Chromium, Firefox and WebKit).
 *
 * The embed page's mock backend has no export port, so the read view reports its own failure; the
 * test looks only at the editing shell, not at the read view's content (FE-072 has its own spec).
 */
import { expect, test, type Page } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

function facts(page: Page) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    const shell = root.querySelector<HTMLElement>('.de-shell');
    const surface = root.querySelector<HTMLElement & { __kept?: boolean }>('.de-editing-surface');
    return {
      shells: root.querySelectorAll('.de-shell').length,
      shellDisplay: shell ? getComputedStyle(shell).display : null,
      shellInert: shell?.hasAttribute('inert') ?? null,
      readViews: root.querySelectorAll('.de-read-view').length,
      label: root.querySelector('.de-view-label')?.textContent ?? null,
      sameSurface: surface?.__kept === true,
    };
  }, editor);
}

const setView = (page: Page, value: string) =>
  page.evaluate((args) => document.querySelector(args.sel)!.setAttribute('view', args.value), {
    sel: editor,
    value,
  });

test('web to read and back keeps the same editing core and its text (FE-065, criterion 3)', async ({
  page,
}) => {
  // A machine with a touch screen answers `any-pointer: coarse` in some browsers, and a touch
  // device always gets the web view (FE-113); this test is about a desktop pointer.
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
  await openEmbed(page);
  await mountEditor(page, { attributes: { view: 'web' } });
  const before = await bodyText(page);
  // Mark the surface node: a new mount would make a new node.
  await page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    (root.querySelector('.de-editing-surface') as HTMLElement & { __kept?: boolean }).__kept = true;
  }, editor);

  await setView(page, 'read');
  await expect.poll(async () => (await facts(page)).readViews).toBe(1);
  const reading = await facts(page);
  expect(reading.shells).toBe(1);
  expect(reading.shellDisplay).toBe('none');
  expect(reading.shellInert).toBe(true);
  expect(reading.label).toBeNull();

  await setView(page, 'web');
  await expect.poll(async () => (await facts(page)).readViews).toBe(0);
  const back = await facts(page);
  expect(back.shells).toBe(1);
  expect(back.shellDisplay).not.toBe('none');
  expect(back.shellInert).toBe(false);
  expect(back.sameSurface).toBe(true);
  expect(back.label).toBe('Web layout');
  expect(await bodyText(page)).toBe(before);
});
