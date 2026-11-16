/**
 * UX-013 criterion 3 (lane w3): every row of the shortcut table (`src/shortcuts/table.ts`) is
 * pressed, each key and each alternative on its own freshly opened page, with focus in the editing
 * surface, and the row's command is seen to run. The rows come from the table itself: a row with no
 * check here fails the suite, so a new shortcut cannot be published without being pressed.
 *
 * The shell runs on the browser harness with the fake core, so "runs" means the command reached the
 * core or the shell acted (a pane, a dialog, a menu, focus). Run from the repository root with
 * `DOCEDIT_BROWSERS=chromium,msedge,firefox,webkit pnpm exec playwright test -c
 * packages/ui/playwright.config.ts ux-013-w3-table-keys`.
 */
import type { Page } from '@playwright/test';
import { SHORTCUT_TABLE } from '../src/shortcuts/table.ts';
import { expect, focusSurface, focused, open, test } from './helpers.ts';

type Remote = Awaited<ReturnType<typeof open>>;

/** A key of the table (`Shift-Mod-c`) in Playwright's notation (`Shift+Control+c`). */
function playwrightKey(key: string): string {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  return key
    .split('-')
    .map((part, i, all) => {
      if (part === 'Mod') return mod;
      if (part === 'Ctrl') return 'Control';
      return i === all.length - 1 && part.length === 1 ? part.toLowerCase() : part;
    })
    .join('+');
}

const painter = (page: Page) => page.locator('.de-toolbar [data-command-id="format.painter"]');

/** Presses the key with focus in the text and expects exactly this core command to have run. */
const coreCommand =
  (name: string) =>
  async (page: Page, h: Remote, key: string): Promise<void> => {
    await h.setUndo(2, 1);
    await focusSurface(page);
    await page.keyboard.press(key);
    await expect.poll(() => h.runs()).toEqual([name]);
  };

/** Presses the key with focus in the text and expects focus on another landmark of the editor. */
async function landmark(page: Page, _h: Remote, key: string): Promise<void> {
  await focusSurface(page);
  const before = await focused(page);
  expect(before.className).toContain('de-editing-surface');
  await page.keyboard.press(key);
  await expect
    .poll(async () => {
      const now = await focused(page);
      return now.inside !== null && now.inside !== before.inside;
    })
    .toBe(true);
}

const CHECKS: Readonly<Record<string, (page: Page, h: Remote, key: string) => Promise<void>>> = {
  'edit.undo': coreCommand('undo'),
  'edit.redo': coreCommand('redo'),
  'edit.selectAll': coreCommand('selectAll'),
  'format.bold': coreCommand('bold'),
  'format.italic': coreCommand('italic'),
  'format.painter': async (page, h, key) => {
    await h.setSelection({ empty: false, marks: ['bold'] });
    await focusSurface(page);
    await page.keyboard.press(key);
    await expect(painter(page)).toHaveAttribute('aria-pressed', 'true');
    expect((await h.named()).map((n) => n[0])).toEqual(['copyFormat']);
  },
  'view.commandSearch': async (page, _h, key) => {
    await focusSurface(page);
    await page.keyboard.press(key);
    await expect(page.locator('.de-command-search')).toBeVisible();
    await expect(page.locator('.de-command-search [role="combobox"]')).toBeFocused();
  },
  'view.find': async (page, _h, key) => {
    await focusSurface(page);
    await page.keyboard.press(key);
    await expect(page.locator('.de-pane [data-search]')).toBeFocused();
  },
  'shell.nextLandmark': landmark,
  'shell.previousLandmark': landmark,
  'shell.contextMenu': async (page, _h, key) => {
    await focusSurface(page);
    await page.keyboard.press(key);
    await expect(page.getByRole('menu', { name: 'Commands for the selection' })).toBeVisible();
  },
  // The painter's own keys: armed first from the toolbar, then the key with focus in the text.
  'shell.applyFormat': async (page, h, key) => {
    await h.setSelection({ empty: false, marks: ['bold'] });
    await painter(page).click();
    await expect(painter(page)).toHaveAttribute('aria-pressed', 'true');
    await h.setSelection({ empty: false, marks: [] });
    await focusSurface(page);
    await page.keyboard.press(key);
    await expect(painter(page)).toHaveAttribute('aria-pressed', 'false');
    expect((await h.named()).map((n) => n[0])).toEqual(['copyFormat', 'pasteFormat']);
  },
  'shell.cancel': async (page, h, key) => {
    await h.setSelection({ empty: false, marks: ['bold'] });
    await painter(page).click();
    await expect(painter(page)).toHaveAttribute('aria-pressed', 'true');
    await focusSurface(page);
    await page.keyboard.press(key);
    await expect(painter(page)).toHaveAttribute('aria-pressed', 'false');
    expect((await h.named()).map((n) => n[0])).toEqual(['copyFormat']);
  },
};

test.describe('UX-013: every key of the shortcut table, pressed in the text', () => {
  test('the table has a check for every row, and no check is left over', () => {
    expect(Object.keys(CHECKS).sort()).toEqual(SHORTCUT_TABLE.map((r) => r.id).sort());
  });

  for (const row of SHORTCUT_TABLE)
    for (const key of [...row.keys, ...row.alternative])
      test(`${row.id}: ${key}${row.alternative.includes(key) ? ' (alternative)' : ''}`, async ({
        page,
      }) => {
        const check = CHECKS[row.id];
        expect(check, `no check for the row ${row.id}`).toBeDefined();
        const h = await open(page, { extended: true });
        await check!(page, h, playwrightKey(key));
      });
});
