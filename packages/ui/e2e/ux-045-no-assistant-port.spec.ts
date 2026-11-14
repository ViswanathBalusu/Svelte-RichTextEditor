/**
 * UX-045 criterion 5 (lane U-UX-031-045): with no assistant port, the panes listed do not include
 * the assistant pane, so neither its command nor its element is offered. Run from the repository
 * root with `DOCEDIT_UI_PORT=56275 pnpm exec playwright test -c packages/ui/playwright.config.ts
 * packages/ui/e2e/ux-045-no-assistant-port.spec.ts`.
 */
import { expect, focusSurface, open, test } from './helpers.ts';

test.describe('the assistant pane without an assistant port (UX-045)', () => {
  test('is not offered: no command and no pane element', async ({ page }) => {
    const h = await open(page, { extended: true });
    await focusSurface(page);
    const ids = await h.commandIds();
    expect(ids.filter((id) => id.includes('assistant'))).toEqual([]);
    expect(await h.exec('view.assistant')).toMatchObject({ ran: false });
    await expect(page.locator('.de-pane[data-pane="assistant"]')).toHaveCount(0);
  });
});
