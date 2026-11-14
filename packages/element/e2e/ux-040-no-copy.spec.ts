/**
 * `no-copy` in the production element (UX-040 criterion 2; lane U-UX-031-045, round 13). The real
 * engine and shell run in the element; the restriction is set on the engine core the way the
 * session does when `perm.changed` arrives (`core.setAccess`). Pressing Ctrl+C or Ctrl+X in the
 * editing surface then writes nothing to the clipboard, a cut removes nothing, and the status notice
 * says why nothing was copied. Without the restriction the same copy writes the selected text.
 * Run with
 * `DOCEDIT_DEMO_PORT=56277 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-040-no-copy.spec.ts --project=<browser>`.
 */
import { type Page, expect, test } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

/** Sets the restriction on the element's core as a new access revision. */
async function setRestrictions(page: Page, restrictions: string[]): Promise<void> {
  await page.evaluate(
    ({ sel, list }) => {
      const el = document.querySelector(sel) as HTMLElement;
      const embed = (
        window as unknown as {
          __embed: {
            internals(el: Element): {
              editor: {
                core: {
                  permissions: { get(): { rev: number } & Record<string, unknown> };
                  setAccess(a: unknown): void;
                };
              } | null;
            };
          };
        }
      ).__embed;
      const core = embed.internals(el).editor!.core;
      const current = core.permissions.get();
      core.setAccess({ ...current, rev: current.rev + 1, restrictions: list });
    },
    { sel: EDITOR, list: restrictions },
  );
}

/** Records, in the document's bubbling phase, the text that each copy or cut event carried. */
async function recordClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __clip: string[] };
    w.__clip = [];
    for (const type of ['copy', 'cut']) {
      document.addEventListener(type, (event) => {
        w.__clip.push((event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '');
      });
    }
  });
}

async function clipboardRecords(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __clip: string[] }).__clip);
}

const notice = (page: Page) => page.locator(EDITOR).locator('.de-status [data-status="notice"]');

test.describe('no-copy in the element (UX-040 criterion 2)', () => {
  test('under no-copy a copy and a cut write nothing, remove nothing, and say why', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    await page.locator(`${EDITOR} .de-editing-surface`).focus();
    await page.keyboard.press('ControlOrMeta+A');
    await recordClipboard(page);
    const before = await bodyText(page);
    expect(before.length).toBeGreaterThan(0);
    await setRestrictions(page, ['no-copy']);

    await page.keyboard.press('ControlOrMeta+C');
    await expect(notice(page)).toContainText(
      'Nothing was copied: your access does not allow copying from this document.',
    );
    expect(await clipboardRecords(page)).toEqual(['']);

    await page.keyboard.press('ControlOrMeta+X');
    expect(await clipboardRecords(page)).toEqual(['', '']);
    expect(await bodyText(page)).toBe(before);
  });

  test('under no-copy a drag of the selection starts nothing, changes nothing and says why', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    const surface = page.locator(`${EDITOR} .de-editing-surface`);
    await surface.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await setRestrictions(page, ['no-copy']);
    const before = await bodyText(page);
    // The first line of text is where the selection is dragged from; the drop is lower in the surface.
    const line = await surface.locator('p').first().boundingBox();
    const box = await surface.boundingBox();
    expect(line).not.toBeNull();
    expect(box).not.toBeNull();
    const from = { x: line!.x + 12, y: line!.y + line!.height / 2 };
    const to = { x: box!.x + 12, y: box!.y + box!.height - 12 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await expect(notice(page)).toContainText('Nothing was copied');
    expect(await bodyText(page)).toBe(before);
  });

  test('control: without the restriction the copy writes the selected text and shows no notice', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    await page.locator(`${EDITOR} .de-editing-surface`).focus();
    await page.keyboard.press('ControlOrMeta+A');
    await recordClipboard(page);
    await page.keyboard.press('ControlOrMeta+C');
    await expect
      .poll(async () => (await clipboardRecords(page)).some((text) => text.length > 0))
      .toBe(true);
    await expect(notice(page)).toHaveCount(0);
  });
});
