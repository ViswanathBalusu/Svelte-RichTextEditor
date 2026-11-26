/**
 * UX-005 criterion 6 against the demo stack (lane w3, 2026-11-26): the reference host's example
 * toolbar (`src/lib/glue/host-toolbar.ts`, shown by the editor page, UX-093 criterion 4) beside the
 * element's built-in toolbar. A walk of selections is made with the keyboard, and after each step
 * the two toolbars agree on enabled and active for every command the example offers.
 *
 * Everything here is the product's: the published `<doc-editor>` bundle in the host's editor page,
 * the host's page glue, and the document service. The host toolbar's buttons are read from the
 * page (`aria-disabled`, `aria-pressed`); the built-in buttons from the element's shadow root, the
 * same attributes. Run against a stack that is already up:
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/w3-ux-005-toolbar-parity.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { editor, eventsOf, PEOPLE, recordEvents, signIn } from './support.ts';

const COMMANDS = ['format.bold', 'format.italic', 'edit.undo', 'edit.redo'] as const;

interface Shown {
  enabled: boolean;
  active: boolean | null;
}

/** What the host's buttons and the built-in buttons show now, per command; null when absent. */
async function both(
  page: Page,
): Promise<Record<string, { host: Shown | null; built: Shown | null }>> {
  return page.evaluate((ids) => {
    const el = document.querySelector('doc-editor') as HTMLElement;
    const read = (b: Element | null): Shown | null =>
      b
        ? {
            enabled:
              b.getAttribute('aria-disabled') !== 'true' && !(b as HTMLButtonElement).disabled,
            active: b.hasAttribute('aria-pressed')
              ? b.getAttribute('aria-pressed') === 'true'
              : null,
          }
        : null;
    const out: Record<string, { host: Shown | null; built: Shown | null }> = {};
    for (const id of ids) {
      out[id] = {
        host: read(document.querySelector(`.host-toolbar button[data-command="${id}"]`)),
        built: read(el.shadowRoot!.querySelector(`button[data-command-id="${id}"]`)),
      };
    }
    return out;
  }, COMMANDS);
}

test('the host toolbar and the built-in toolbar agree over a walk of selections (UX-005 criterion 6)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await recordEvents(context);
  const page = await context.newPage();
  try {
    await signIn(page, PEOPLE.olivia);
    await page
      .getByLabel('Title', { exact: true })
      .fill(`Toolbar parity ${Date.now().toString(36)}`);
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
    await expect
      .poll(async () => (await eventsOf(page, 'de-ready')).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect(page.locator('.host-toolbar button')).toHaveCount(COMMANDS.length);

    const paragraph = editor(page).locator('p.de-p').first();
    const walk: Array<{ at: string; shown: Awaited<ReturnType<typeof both>> }> = [];
    const record = async (at: string) => {
      await expect
        .poll(
          async () => {
            const s = await both(page);
            return COMMANDS.filter(
              (id) =>
                !(
                  s[id]!.host !== null &&
                  s[id]!.built !== null &&
                  s[id]!.host.enabled === s[id]!.built.enabled &&
                  (s[id]!.host.active ?? false) === (s[id]!.built.active ?? false)
                ),
            ).map((id) => `${id}: ${JSON.stringify(s[id])}`);
          },
          { message: `the toolbars agree at: ${at}`, timeout: 15_000 },
        )
        .toEqual([]);
      walk.push({ at, shown: await both(page) });
    };

    await paragraph.click();
    await page.keyboard.press('Home');
    await record('caret in plain text');
    await page.keyboard.press('Shift+End');
    await record('plain selection');
    await page.keyboard.press('Control+B');
    await record('bold selection');
    await page.keyboard.press('Control+I');
    await record('bold and italic selection');
    await page.keyboard.press('ArrowRight');
    await record('caret in formatted text');
    await page.keyboard.press('Control+Z');
    await record('after undo');
    await page.keyboard.press('Control+Y');
    await record('after redo');

    // The walk is not vacuous: bold was seen on and off, and undo was seen enabled and disabled
    // or redo was seen enabled, so that the agreement covers more than one state.
    const boldActive = walk.map((w) => w.shown['format.bold']!.host!.active);
    expect(boldActive).toContain(true);
    expect(boldActive).toContain(false);
    const undoEnabled = walk.map((w) => w.shown['edit.undo']!.host!.enabled);
    const redoEnabled = walk.map((w) => w.shown['edit.redo']!.host!.enabled);
    expect(new Set([...undoEnabled, ...redoEnabled]).size).toBe(2);
  } finally {
    await context.close();
  }
});
