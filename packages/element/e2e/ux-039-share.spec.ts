/**
 * The share button in the production element (UX-039, lane U-UX-031-045): activating it raises
 * `de-share-request` with identifiers only, the element shows no dialog of its own, the editor's
 * state survives the host's dialog, and focus returns to the share button when the host gives
 * focus back by calling `focus()`. Run with
 * `DOCEDIT_DEMO_PORT=56270 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-039-share.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { bodyText, events, mountEditor, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

/** The share button, found by its accessible name (role and name, not a test id). */
const share = (page: Page) =>
  page.locator(EDITOR).getByRole('button', { name: 'Share', exact: true });

async function docId(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __embed: { docId: string } }).__embed.docId);
}

/** The element's focused control inside its shadow root, by its command id. */
async function focusedCommand(page: Page): Promise<string | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    const active = el?.shadowRoot?.activeElement as HTMLElement | null | undefined;
    return active?.getAttribute('data-command-id') ?? null;
  }, EDITOR);
}

test.describe('the share button in the element (UX-039)', () => {
  test('criterion 1: activating it raises de-share-request with identifiers only, and shows no dialog of its own', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    await expect(share(page)).toBeVisible();
    await share(page).click();
    const raised = await events(page, 'de-share-request');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      name: 'de-share-request',
      composed: true,
      bubbles: true,
      element: 'one',
    });
    // Identifiers only: the detail has the document identifier and no other field.
    expect(raised[0]!.detail).toEqual({ docId: await docId(page) });
    // The element shows no sharing dialog of its own.
    await expect(page.locator(EDITOR).locator('dialog, [role="dialog"]')).toHaveCount(0);
  });

  test('criterion 2: the host dialog leaves the editor state alone, and focus returns to the share button when the host gives it back', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    await page.locator(`${EDITOR} .de-editing-surface`).focus();
    const before = await bodyText(page);
    // Focus first, then activate by keyboard: WebKit does not focus a button on a mouse click,
    // and focus returns to the control that had it.
    await share(page).focus();
    await page.keyboard.press('Enter');
    expect(await events(page, 'de-share-request')).toHaveLength(1);
    // The host's own dialog, in the light DOM, as a host would build it.
    await page.evaluate((sel) => {
      const dialog = document.createElement('dialog');
      dialog.id = 'host-share';
      const done = document.createElement('button');
      done.type = 'button';
      done.textContent = 'Done';
      done.addEventListener('click', () => {
        dialog.close();
        dialog.remove();
        (document.querySelector(sel) as HTMLElement & { focus(): void }).focus();
      });
      dialog.append(done);
      document.body.append(dialog);
      dialog.showModal();
    }, EDITOR);
    await expect(page.locator('#host-share')).toBeVisible();
    // The dialog took focus; the editor's text is unchanged.
    expect(await bodyText(page)).toBe(before);
    await page.locator('#host-share button').click();
    await expect(page.locator('#host-share')).toHaveCount(0);
    await expect.poll(() => focusedCommand(page)).toBe('document.share');
    // Nothing else was raised by the dialog.
    expect(await events(page, 'de-share-request')).toHaveLength(1);
  });

  test('criterion 4: the button has the name Share and is operated from the keyboard', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    await share(page).focus();
    await page.keyboard.press('Enter');
    const raised = await events(page, 'de-share-request');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.detail).toEqual({ docId: await docId(page) });
  });
});
