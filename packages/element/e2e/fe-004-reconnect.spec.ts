/**
 * FE-004 criterion 2 (lane V-FE-001-016): an element that has connected before connects again.
 * No second application and no second core are created, the global listeners are re-attached, and
 * the editor resumes. The checks use a same-task move (remove and insert), which keeps the element
 * connected from the element's point of view and does not suspend it (FE-005). The listener under
 * test is the host-document `pointerdown` listener (src/doc-editor.ts #onOutsidePress): it is
 * removed on disconnect and must be back after a reconnect, or focus is restored after a press
 * outside the element.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

test.describe('FE-004 criterion 2: reconnect resumes one application and one core', () => {
  test('a second connect keeps the same application and resumes editing', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });

    // Mark the editing surface and count the connects that raise de-ready after this point.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement & { shadowRoot: ShadowRoot };
      const surface = el.shadowRoot.querySelector('.de-editing-surface') as HTMLElement;
      (surface as HTMLElement & { __fe004?: string }).__fe004 = 'first';
      (window as unknown as { __fe004Ready: number }).__fe004Ready = 0;
      el.addEventListener('de-ready', () => {
        (window as unknown as { __fe004Ready: number }).__fe004Ready++;
      });
    }, editor);

    // Two same-task moves: out to the second container and back.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(async (sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        const other = document.getElementById(
          el.parentElement!.id === 'mount' ? 'mount-2' : 'mount',
        )!;
        el.remove();
        other.append(el);
        await new Promise((r) => setTimeout(r, 50));
      }, editor);
    }

    const state = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement & { shadowRoot: ShadowRoot };
      const surfaces = el.shadowRoot.querySelectorAll('.de-editing-surface');
      const surface = surfaces[0] as HTMLElement & { __fe004?: string };
      return {
        surfaceCount: surfaces.length,
        sameSurface: surface.__fe004 === 'first',
        readyAfterMoves: (window as unknown as { __fe004Ready: number }).__fe004Ready,
      };
    }, editor);
    expect(state.surfaceCount).toBe(1);
    expect(state.sameSurface).toBe(true);
    expect(state.readyAfterMoves).toBe(0);

    // The editor resumes: typing after the moves reaches the document.
    const surface = page.locator(`${editor} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' FE-004 resumed.');
    await expect(surface).toContainText('FE-004 resumed.');
  });

  test('the outside-press listener is re-attached after a reconnect', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    // A non-focusable block outside the element: a press on it moves focus to the body (no
    // relatedTarget on focusout), so only the document pointerdown listener can clear the flag.
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'fe004-outside';
      d.textContent = 'outside';
      d.style.height = '40px';
      document.body.append(d);
    });

    const surface = page.locator(`${editor} .de-editing-surface`);
    const focusInside = () =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement & { shadowRoot: ShadowRoot };
        return el.shadowRoot.activeElement !== null;
      }, editor);
    const move = () =>
      page.evaluate(async (sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        const other = document.getElementById(
          el.parentElement!.id === 'mount' ? 'mount-2' : 'mount',
        )!;
        el.remove();
        other.append(el);
        await new Promise((r) => setTimeout(r, 50));
      }, editor);

    // Focus the editor, then move it: focus comes back (the listener is attached from connect).
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    expect(await focusInside()).toBe(true);
    await move();
    expect(await focusInside()).toBe(true);

    // Press outside (this sets the flag through the document listener), then move again: focus
    // must not be taken back. If the listener had been lost on the first reconnect, the flag would
    // stay set and focus would wrongly return.
    await page.locator('#fe004-outside').click();
    expect(await focusInside()).toBe(false);
    await move();
    expect(await focusInside()).toBe(false);
  });
});
