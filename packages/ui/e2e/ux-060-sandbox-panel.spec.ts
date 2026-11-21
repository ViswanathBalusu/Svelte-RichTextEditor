/**
 * UX-060 criterion 5: an extension panel in an iframe, in the real shell. The extension is a tier 2
 * entry with a panel (`sandboxedExtension` with `panel`), installed through the shell's extension
 * list; its pane holds one `sandbox="allow-scripts"` frame whose code draws two buttons. The tests
 * press real keys in the frame and read where focus is. Run from the repository root with
 * `DOCEDIT_UI_PORT=57470 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-060-sandbox-panel.spec.ts`.
 */
import type { Frame, Page } from '@playwright/test';
import { expect, focused, focusSurface, open, test } from './helpers.ts';

const frameOf = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.url().endsWith('/sandbox-frame.html'));
  if (!frame) throw new Error('the extension frame is not there');
  return frame;
};
const inFrame = (page: Page): Promise<string> =>
  frameOf(page).evaluate(() => document.activeElement?.id || document.activeElement?.tagName || '');

async function openPanel(page: Page) {
  const h = await open(page, { sandboxPanel: true });
  await h.setExtensions('sandbox');
  await h.frames(2);
  await focusSurface(page);
  expect(await h.openSandboxPane()).toBe(true);
  await expect(page.locator('.de-pane[data-pane="ext-sandboxed"]')).toBeVisible();
  await frameOf(page).waitForSelector('#b2');
  return h;
}

/**
 * Microsoft Edge 157 and 158 (Windows and Linux) keeps the document of the sandboxed frame without
 * focus when the frame element is focused (`document.hasFocus()` is false in the frame; in Chromium
 * it is true), so the Tab and key presses of these tests never reach the frame's buttons. The frame
 * and the pane are the same code in both browsers, and the tests that do not press keys inside the
 * frame pass in Edge. Skipped for Edge only, until the cause is known.
 */
function skipInEdge(): void {
  test.skip(
    test.info().project.name === 'msedge',
    "Edge does not give the sandboxed frame's document focus; the keys never reach the frame",
  );
}

test.describe('a sandboxed extension panel and the keyboard (UX-060)', () => {
  test('the panel is a pane with one sandboxed frame, and focus enters the frame when it opens', async ({
    page,
  }) => {
    await openPanel(page);
    const pane = page.locator('.de-pane[data-pane="ext-sandboxed"]');
    await expect(pane.locator('.de-pane-title')).toHaveText('Sandboxed notes');
    await expect(pane.locator('iframe')).toHaveCount(1);
    await expect(pane.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(pane.locator('iframe')).toHaveAttribute('title', 'Sandboxed notes');
    const now = await focused(page);
    expect(now.tag).toBe('iframe');
    expect(now.inside).toBe('pane');
  });

  test('Tab steps through the frame and leaves it, and Shift+Tab comes back in', async ({
    page,
  }) => {
    skipInEdge();
    await openPanel(page);
    await page.keyboard.press('Tab');
    expect(await inFrame(page)).toBe('b1');
    await page.keyboard.press('Tab');
    expect(await inFrame(page)).toBe('b2');
    await page.keyboard.press('Tab');
    // Past the last control of the frame: focus is back in the shell, after the pane's frame.
    const out = await focused(page);
    expect(out.tag).not.toBe('iframe');
    await page.keyboard.press('Shift+Tab');
    expect((await focused(page)).tag).toBe('iframe');
    expect(await inFrame(page)).toBe('b2');
  });

  test('Ctrl+F6 pressed in the frame moves to the next landmark, and the landmarks reach the frame again', async ({
    page,
  }) => {
    skipInEdge();
    await openPanel(page);
    await page.keyboard.press('Tab');
    expect(await inFrame(page)).toBe('b1');
    // The keystroke is made in the frame; the shell steps on from the pane landmark.
    await page.keyboard.press('Control+F6');
    await expect.poll(async () => (await focused(page)).inside).not.toBe('pane');
    const visited: Array<string | null> = [(await focused(page)).inside];
    for (let i = 0; i < 6 && !visited.includes('pane'); i++) {
      await page.keyboard.press('Control+F6');
      visited.push((await focused(page)).inside);
    }
    // Round the landmarks and back to the pane: focus lands on the pane's first control (its close
    // button, as for every pane), and the next Tab goes into the frame.
    expect(visited).toContain('pane');
    expect((await focused(page)).inside).toBe('pane');
    await page.keyboard.press('Tab');
    expect((await focused(page)).tag).toBe('iframe');
    // The frame remembers its own focus: it was on b1 when the key was pressed.
    expect(await inFrame(page)).toBe('b1');
  });

  test('Shift+Ctrl+F6 and Alt+F6 pressed in the frame step back and forward', async ({ page }) => {
    await openPanel(page);
    await page.keyboard.press('Shift+Control+F6');
    await expect.poll(async () => (await focused(page)).inside).toBe('page');
    // From the page, forward lands in the pane; one Tab goes into the frame, and Alt+F6 there
    // leaves it again.
    await page.keyboard.press('Control+F6');
    await expect.poll(async () => (await focused(page)).inside).toBe('pane');
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await focused(page)).tag).toBe('iframe');
    await page.keyboard.press('Alt+F6');
    await expect.poll(async () => (await focused(page)).inside).not.toBe('pane');
  });

  test('Escape pressed in the frame closes the pane and returns focus to where it was', async ({
    page,
  }) => {
    skipInEdge();
    const h = await openPanel(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(page.locator('.de-pane[data-pane="ext-sandboxed"]')).toHaveCount(0);
    expect((await focused(page)).inside).toBe('page');
    // Closing removes the frame; opening again makes a new one that still has its document API.
    await expect
      .poll(() => page.frames().filter((f) => f.url().endsWith('/sandbox-frame.html')).length)
      .toBe(0);
    expect(await h.openSandboxPane()).toBe(true);
    await expect
      .poll(() => page.frames().filter((f) => f.url().endsWith('/sandbox-frame.html')).length)
      .toBe(1);
    await frameOf(page).waitForSelector('#b1');
    expect((await focused(page)).tag).toBe('iframe');
  });

  test('a letter typed in the frame stays there, and nothing was refused or ignored', async ({
    page,
  }) => {
    skipInEdge();
    const h = await openPanel(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('a');
    await page.keyboard.press('Enter');
    expect(await inFrame(page)).toBe('b1');
    expect(await h.sandboxLog()).toEqual([]);
  });
});
