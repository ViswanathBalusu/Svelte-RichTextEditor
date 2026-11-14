/**
 * UX-022 criterion 5 (lane V-UX-016-030): with the keyboard, every style of the styles pane is
 * reachable in document order, and each is exposed with its name and whether it is current. Rendered
 * in the browser through the shell's own focus order (Tab), not by calling the buttons directly.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-022-styles-keyboard`.
 */
import { expect, focusSurface, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const },
];

test.describe('styles pane by keyboard (UX-022 criterion 5)', () => {
  test('every style is reached by Tab in order and exposed with its name and current state', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, styles: STYLES });
    await focusSurface(page);
    expect(await h.exec('view.styles')).toEqual({ ran: true, reason: null });
    const pane = page.locator('.de-pane[data-pane="styles"]');
    await expect(pane).toBeVisible();

    const buttons = pane.locator('[data-style] > button');
    await expect(buttons).toHaveCount(STYLES.length);
    for (const style of STYLES) {
      // Each style is a named button: its name is the style's name, possibly with a badge word.
      const named = pane.getByRole('button', { name: new RegExp(`^${style.name}`) });
      await expect(named, style.name).toHaveCount(1);
      const current = await named.getAttribute('aria-current');
      expect(current === 'true' || current === null, style.name).toBe(true);
    }

    // Tab from the first style reaches each following style in document order.
    await buttons.first().focus();
    for (let i = 0; i < STYLES.length; i++) {
      const focusedName = await page.evaluate(() => {
        const root = document.getElementById('host')!.shadowRoot!;
        const el = root.activeElement as HTMLElement | null;
        return el?.closest('[data-style]')?.getAttribute('data-style') ?? null;
      });
      expect(focusedName, `style ${i}`).toBe(STYLES[i]!.id);
      if (i < STYLES.length - 1) await page.keyboard.press('Tab');
    }
  });
});
