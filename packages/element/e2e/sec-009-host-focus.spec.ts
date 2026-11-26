/**
 * SEC-009 criterion 2 (lane w3, 2026-11-15), in a browser with real focus: the focus is in a field
 * of the host page, the keys that are editor shortcuts are pressed there, and nothing in the
 * editor fires. The earlier Node.js test (test/sec-009-host-shortcuts.test.ts) built a keyboard
 * event by hand; here the browser delivers the keys.
 *
 * The session types a marker into the editor first, so that an undo that reached the editor would
 * remove text. Then a host `<input>` outside the element takes the focus, and each shortcut is
 * pressed with Control and with Meta (the editor's modifier differs by platform): bold, italic,
 * underline, undo, redo (two spellings), select all and save. Afterwards the editor's text is the
 * same, the page recorded no new `de-*` event, no key was cancelled (the page's capture listener
 * sees `defaultPrevented` false in the bubble phase at `window`), and the focus is still in the
 * host field. The control: with the focus back in the editor, the undo shortcut does remove text,
 * so the shortcut is live and the result above is not an idle keymap.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/sec-009-host-focus.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import { events, mountEditor, openEmbed } from './embed-helpers.ts';

const MARKER = 'sec009hostfocus';
const KEYS = ['b', 'i', 'u', 'z', 'y', 'Shift+z', 'a', 's'];

test('SEC-009: editor shortcuts pressed with the focus in the host page do nothing in the editor', async ({
  page,
}) => {
  // Fixed in lane w8 (2026-11-25): the browser keeps one undo history for the page, so Control+Z in
  // the host field reached the typing in the editor's surface in Chromium, Edge and WebKit. The
  // body view now cancels a history beforeinput while it has no focus (packages/engine/src/view/web.ts).
  await openEmbed(page);
  await mountEditor(page, { name: 'sec-009-focus', sub: 'ada', role: 'editor' });
  const surface = page.locator('doc-editor[data-test="sec-009-focus"] .de-editing-surface');
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(` ${MARKER}`);
  await expect
    .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
    .toContain(MARKER);
  await page.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="sec-009-focus"]') as HTMLElement & {
      flush(): Promise<void>;
    };
    await el.flush();
  });
  await page.waitForTimeout(300);

  // A field of the host page, outside the element, and a record of every key the page sees.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'host-field';
    input.value = 'host value';
    document.body.prepend(input);
    const w = window as unknown as { __hostKeys: Array<{ key: string; cancelled: boolean }> };
    w.__hostKeys = [];
    window.addEventListener('keydown', (ev) => {
      w.__hostKeys.push({ key: ev.key, cancelled: ev.defaultPrevented });
    });
  });
  await page.locator('#host-field').focus();
  // The move of the focus raises its own events; they are not the keys'.
  await page.waitForTimeout(500);
  const textBefore = await surface.evaluate((el) => el.textContent ?? '');
  const htmlBefore = await surface.evaluate((el) => el.innerHTML);
  const eventsBefore = (await events(page)).filter((e) => e.name.startsWith('de-')).length;

  const changedBy: string[] = [];
  for (const modifier of ['Control', 'Meta'])
    for (const key of KEYS) {
      await page.keyboard.press(`${modifier}+${key}`);
      await page.waitForTimeout(50);
      if ((await surface.evaluate((el) => el.textContent ?? '')) !== textBefore)
        changedBy.push(`${modifier}+${key}`);
    }
  await page.waitForTimeout(300);
  expect(changedBy, 'no host-page key changed the editor’s text').toEqual([]);

  const keys = await page.evaluate(
    () =>
      (window as unknown as { __hostKeys: Array<{ key: string; cancelled: boolean }> }).__hostKeys,
  );
  const pressed = keys.filter((k) => !['Control', 'Meta', 'Shift'].includes(k.key));
  expect(pressed.length, 'the host page saw the shortcut keys').toBeGreaterThanOrEqual(KEYS.length);
  expect(
    pressed.filter((k) => k.cancelled),
    'the editor cancelled no host-page key',
  ).toEqual([]);
  expect(await surface.evaluate((el) => el.textContent ?? '')).toBe(textBefore);
  expect(await surface.evaluate((el) => el.innerHTML)).toBe(htmlBefore);
  expect(
    (await events(page)).filter((e) => e.name.startsWith('de-')).length,
    'no de-* event was raised by the host-page keys',
  ).toBe(eventsBefore);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('host-field');

  // The control: the same undo key, with the focus in the editor, reaches the command.
  await surface.locator('p').last().click();
  await page.keyboard.press('Control+z');
  let after = await surface.evaluate((el) => el.textContent ?? '');
  if (after === textBefore) {
    await page.keyboard.press('Meta+z');
    after = await surface.evaluate((el) => el.textContent ?? '');
  }
  expect(after, 'undo with the focus in the editor removes typed text').not.toBe(textBefore);
});
