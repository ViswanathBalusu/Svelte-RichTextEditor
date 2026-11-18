/**
 * FRW-075 (lane w4): the preview as a role in the real `<doc-editor>`, with the shell, the core and
 * the in-memory backend of the embed page (which runs the real authority). An editor opens the
 * roles pane, previews the document as the tenant, and sees fill mode for that role: a read-only
 * body, the tenant's fields editable and the landlord's not. What is typed in the preview is not
 * committed (the confirmed document is unchanged and nothing is in flight) and is gone when the
 * preview ends, and the caret returns to where it was.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-075-role-preview.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import {
  FIELD_IDS as IDS,
  confirmed,
  control,
  editorOf,
  mountFields,
  nodes,
  openPaneBySearch,
} from './frw-helpers.ts';

const NAME = 'one';
const EDITOR = editorOf(NAME);

interface Internals {
  editor: {
    core: {
      syncSnapshot(): { inflight: unknown; queue: unknown[] };
      permissions: { get(): { fill: { roles: string[] } | null } | null };
    };
  };
}

const state = (page: Page) =>
  page.evaluate((n) => {
    const e = (window as unknown as { __embed: { internals(el: Element): Internals } }).__embed;
    const core = e.internals(document.querySelector(`doc-editor[data-test="${n}"]`)!).editor.core;
    const snapshot = core.syncSnapshot();
    return {
      inflight: snapshot.inflight !== null,
      queued: snapshot.queue.length,
      roles: core.permissions.get()?.fill?.roles ?? null,
    };
  }, NAME);

const values = async (page: Page): Promise<Record<string, unknown>> =>
  Object.fromEntries(
    nodes(await confirmed(page, NAME), 'form_field').map((f) => [
      String(f.attrs?.['key']),
      f.attrs?.['value'] ?? null,
    ]),
  );

/** The position of the caret in the editing surface, as the shell's selection summary reports it. */
const caret = (page: Page): Promise<string> =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot! as ShadowRoot & {
      getSelection?: () => Selection | null;
    };
    const s = root.getSelection?.() ?? document.getSelection();
    return `${s?.anchorNode?.textContent ?? ''}|${s?.anchorOffset ?? -1}`;
  }, EDITOR);

test('the editor shows fill mode for the previewed role, commits nothing, and puts the caret back', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFields(page, { name: NAME, sub: 'bob', role: 'editor' });
  const pane = await openPaneBySearch(page, NAME, 'Roles', 'roles');
  const before = await values(page);

  // As an editor the body is editable and the tenant's field is the author's to change.
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toHaveAttribute(
    'contenteditable',
    'true',
  );

  // Criterion 1: fill mode for the tenant alone.
  await pane.getByRole('button', { name: 'Preview as Tenant' }).click();
  const bar = page.locator(EDITOR).getByRole('region', { name: 'Preview as a role' });
  await expect(bar).toContainText('Previewing as Tenant');
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toHaveAttribute(
    'contenteditable',
    'false',
  );
  expect((await state(page)).roles).toEqual(['role_tenant']);
  await expect(control(page, IDS.name, NAME)).toBeEditable();
  await expect(control(page, IDS.landlordName, NAME)).not.toBeEditable();
  // The other role's field is labelled with its role (FRW-077, FRW-079).
  await expect(control(page, IDS.landlordName, NAME)).toHaveAccessibleDescription(/for Landlord/);
  await expect(page.locator(EDITOR).getByRole('region', { name: 'Filling in' })).toBeVisible();

  // Criterion 2: a value entered in the preview is shown, and no commit is sent.
  await control(page, IDS.name, NAME).fill('Ada');
  await control(page, IDS.name, NAME).blur();
  await expect(control(page, IDS.name, NAME)).toHaveValue('Ada');
  await page.waitForTimeout(300);
  expect(await state(page)).toMatchObject({ inflight: false, queued: 0 });
  expect(await values(page)).toEqual(before);

  // Criterion 3: leaving restores the document, the mode and the body.
  await bar.getByRole('button', { name: 'Leave preview' }).click();
  await expect(bar).toHaveCount(0);
  await expect(control(page, IDS.name, NAME)).toHaveValue('');
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toHaveAttribute(
    'contenteditable',
    'true',
  );
  expect((await state(page)).roles).toBeNull();
  expect(await values(page)).toEqual(before);
});

test('the caret is where it was after the preview (criterion 3)', async ({ page }) => {
  await openEmbed(page);
  await mountFields(page, { name: NAME, sub: 'bob', role: 'editor' });
  const first = page.locator(`${EDITOR} .de-editing-surface p`).first();
  await first.click();
  await page.keyboard.press('End');
  const placed = await caret(page);
  const pane = await openPaneBySearch(page, NAME, 'Roles', 'roles');
  await pane.getByRole('button', { name: 'Preview as Tenant' }).click();
  await control(page, IDS.name, NAME).focus();
  await page.locator(EDITOR).getByRole('button', { name: 'Leave preview' }).click();
  await expect(page.locator(EDITOR).getByRole('region', { name: 'Preview as a role' })).toHaveCount(
    0,
  );
  await expect.poll(() => caret(page)).toBe(placed);
});
