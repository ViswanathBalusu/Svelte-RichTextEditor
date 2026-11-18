/**
 * UX-022 on the mounted element (lane w3): the styles pane on the real editing core and the embed
 * page's in-memory backend. The styles of the document are listed with their kinds and the one in
 * effect at the caret is marked (criterion 1); a user without `structure` cannot create, change or
 * delete a style and is told why (criterion 2); a user who may only suggest applies a style as a
 * formatting suggestion (criterion 4); and a change to a style that an approved region uses is
 * refused in words naming the region (criterion 3).
 */
import { expect, test, type Page } from '@playwright/test';
import { clickToolbarCommand, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;
const surface = (page: Page, name = 'one') => page.locator(`${editor(name)} .de-editing-surface`);
const pane = (page: Page, name = 'one') => page.locator(`${editor(name)} .de-styles`);
const note = (page: Page) => pane(page).locator('[data-styles="note"]');

async function openStyles(page: Page, role: string, doc?: 'regions'): Promise<void> {
  await openEmbed(page);
  await mountEditor(page, { name: 'one', sub: 'ada', role, ...(doc ? { doc } : {}) });
  await clickToolbarCommand(page, 'view.styles');
  await pane(page).waitFor();
}

test.describe('UX-022 the styles pane on the mounted element', () => {
  test('lists the styles by kind, marks the one at the caret and applies the one chosen', async ({
    page,
  }) => {
    await openStyles(page, 'editor');
    const p = pane(page);
    await expect(p.getByRole('heading', { name: 'Paragraph style' })).toBeVisible();
    await expect(p.locator('[data-style="Normal"] > button')).toContainText('Normal');
    await expect(p.locator('[data-style="Heading1"] > button')).toContainText('Heading 1');
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await expect(p.locator('[data-style="Normal"] > button')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await p.locator('[data-style="Heading1"] > button').click();
    await expect(
      surface(page).locator('[data-style="Heading1"]', { hasText: 'Last paragraph.' }),
    ).toBeVisible();
    await expect(p.locator('[data-style="Heading1"] > button')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(p.locator('[data-style="Heading1"] > button')).toContainText(
      'In use at the cursor',
    );
    await expect(p.locator('[data-style="Normal"] > button')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('a user who may edit only a region cannot create, change or delete a style, and is told why', async ({
    page,
  }) => {
    // A commenter, with the grant that makes Ada an editor of the one region (07 §7).
    await openStyles(page, 'commenter');
    const p = pane(page);
    await expect(p.locator('[data-styles="why"]')).toContainText(
      'needs permission to change the structure of the document',
    );
    for (const el of await p.locator('[data-style-action]').all())
      await expect(el).toHaveAttribute('aria-disabled', 'true');
    await p.getByRole('button', { name: 'New style' }).click({ force: true });
    await expect(p.locator('form')).toHaveCount(0);
    // Applying an existing style inside the region still works.
    await surface(page).locator('p', { hasText: 'Liability is limited to' }).click();
    await p.locator('[data-style="Heading1"] > button').click();
    await expect(
      surface(page).locator('[data-style="Heading1"]', { hasText: 'Liability is limited to' }),
    ).toBeVisible();
  });

  test('an owner creates, renames and deletes a style, and applies the new one', async ({
    page,
  }) => {
    await openStyles(page, 'owner');
    const p = pane(page);
    await expect(p.locator('[data-styles="why"]')).toHaveCount(0);
    await p.getByRole('button', { name: 'New style' }).click();
    const form = p.locator('form[data-form]');
    await form.getByRole('textbox', { name: 'Name of the style' }).fill('Callout');
    await form.getByRole('combobox', { name: 'Based on' }).selectOption('Normal');
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(note(page)).toHaveText('Style created.');
    const row = p.locator('[data-style] > button', { hasText: 'Callout' });
    await expect(row).toHaveCount(1);
    // A second style with the same name is refused in words.
    await p.getByRole('button', { name: 'New style' }).click();
    await form.getByRole('textbox', { name: 'Name of the style' }).fill('callout');
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(note(page)).toHaveText('Another style of this kind has that name.');
    await form.getByRole('button', { name: 'Cancel' }).click();
    // Apply it, rename it.
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await p.getByRole('button', { name: 'Change style Callout' }).click();
    await form.getByRole('textbox', { name: 'Name of the style' }).fill('Call-out');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(note(page)).toHaveText('Style changed.');
    await expect(p.locator('[data-style] > button', { hasText: 'Call-out' })).toHaveCount(1);
    // It is in use, so it is not deleted; a built-in style is not either.
    await p.getByRole('button', { name: 'Delete style Call-out' }).click();
    await expect(note(page)).toHaveText('This style is in use, so it cannot be deleted.');
    await p.getByRole('button', { name: 'Delete style Normal' }).click();
    await expect(note(page)).toHaveText('A built-in style cannot be renamed or deleted.');
    // Back to Normal, and then it goes.
    await p.locator('[data-style="Normal"] > button').click();
    await p.getByRole('button', { name: 'Delete style Call-out' }).click();
    await expect(note(page)).toHaveText('Style deleted.');
    await expect(p.locator('[data-style] > button', { hasText: 'Call-out' })).toHaveCount(0);
  });

  test('a user who may only suggest applies a style as a formatting suggestion', async ({
    page,
  }) => {
    await openStyles(page, 'suggester');
    await surface(page).locator('p', { hasText: 'Last paragraph.' }).click();
    await pane(page).locator('[data-style="Heading1"] > button').click();
    const marks = await page.evaluate((sel) => {
      const e = (
        window as unknown as {
          __embed: {
            internals(el: Element): {
              editor: { core: { getContent(): { doc: unknown } } };
            };
          };
        }
      ).__embed;
      const doc = JSON.stringify(
        e.internals(document.querySelector(sel)!).editor.core.getContent().doc,
      );
      const at = doc.indexOf('"Heading1"');
      return { heading: at >= 0, fmt: doc.includes('"type":"fmt"') };
    }, editor());
    expect(marks).toEqual({ heading: true, fmt: true });
  });

  test('names the approved region that stops a change to a style it uses', async ({ page }) => {
    await openStyles(page, 'owner', 'regions');
    const p = pane(page);
    // The owner makes a style and puts the region's first paragraph in it.
    await p.getByRole('button', { name: 'New style' }).click();
    const form = p.locator('form[data-form]');
    await form.getByRole('textbox', { name: 'Name of the style' }).fill('Clause');
    await form.getByRole('button', { name: 'Create' }).click();
    await expect(note(page)).toHaveText('Style created.');
    await surface(page).locator('p', { hasText: 'Region first.' }).click();
    await p.locator('[data-style] > button', { hasText: 'Clause' }).click();
    // The style and its use reach the server; then the region is approved there.
    type Node = { attrs?: Record<string, unknown>; content?: Node[] };
    type Embed = {
      service: {
        document(id: string): {
          content(): { doc: Node };
          setRegionState(region: string, state: string): unknown;
        };
      };
      regionsDocId: string;
      REGION_IDS: { region: string; first: string };
    };
    await expect
      .poll(() =>
        page.evaluate(() => {
          const e = (window as unknown as { __embed: Embed }).__embed;
          const find = (n: Node): Node | null =>
            n.attrs?.['id'] === e.REGION_IDS.first
              ? n
              : (n.content?.map(find).find((x) => x !== null) ?? null);
          const para = find(e.service.document(e.regionsDocId).content().doc);
          return typeof para?.attrs?.['style'] === 'string';
        }),
      )
      .toBe(true);
    await page.evaluate(() => {
      const e = (window as unknown as { __embed: Embed }).__embed;
      e.service.document(e.regionsDocId).setRegionState(e.REGION_IDS.region, 'approved');
    });
    // A fresh editor reads the region list, with its states, from the server.
    await page.evaluate(() => document.querySelector('doc-editor')!.remove());
    await mountEditor(page, { name: 'one', sub: 'ada', role: 'owner', doc: 'regions' });
    await clickToolbarCommand(page, 'view.styles');
    await pane(page).waitFor();
    await p.getByRole('button', { name: 'Change style Clause' }).click();
    await expect(note(page)).toHaveText(
      'This style is used in the region Middle, which is approved, so it cannot be changed.',
    );
    await expect(p.locator('form')).toHaveCount(0);
  });
});
