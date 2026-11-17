/**
 * FRW-072 criteria 1 and 4 (lane w4): the field palette in the real element, with the shell, the
 * core and the in-memory backend of the embed page. An editor puts the caret in a body paragraph
 * and chooses each kind of phase 1b from the palette, by the command search; each field is read
 * back from the confirmed document. In a document one field short of the limit, the 2,000th field
 * is inserted and then every insert command is disabled with the stated reason.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-072-insert-fields.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { confirmed, editorOf, mountFields, nodes } from './frw-helpers.ts';

const EDITOR = editorOf('one');
const KINDS = [
  ['Text field', 'text'],
  ['Number field', 'number'],
  ['Date field', 'date'],
  ['Checkbox', 'checkbox'],
  ['Choice field', 'choice'],
] as const;
const LIMIT_REASON = 'The document already has the largest number of fields it may have.';

/** Opens the command search and types `label`; the first option is the command with that label. */
async function search(page: Page, label: string) {
  await page.keyboard.press('Alt+q');
  await expect(page.locator(`${EDITOR} [role="combobox"]`)).toBeFocused();
  await page.keyboard.type(label);
  const option = page.locator(`${EDITOR} [role="option"]`).first();
  await expect(option).toContainText(label);
  return option;
}

const formFields = async (page: Page) => nodes(await confirmed(page, 'one'), 'form_field');

test('each kind of the palette is inserted at the caret with a fresh identifier and a unique key', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFields(page, { name: 'one', sub: 'bob', role: 'editor' });
  const before = await formFields(page);
  expect(before).toHaveLength(4);
  await page.locator(`${EDITOR} .de-editing-surface p`, { hasText: 'Last paragraph.' }).click();

  for (const [label] of KINDS) {
    await search(page, label);
    await page.keyboard.press('Enter');
  }
  await expect.poll(async () => (await formFields(page)).length).toBe(9);

  const all = await formFields(page);
  const known = new Set(before.map((f) => f.attrs?.['id']));
  const added = all.filter((f) => !known.has(f.attrs?.['id']));
  expect(added.map((f) => f.attrs?.['kind']).sort()).toEqual(KINDS.map(([, k]) => k).sort());
  for (const f of added) expect(String(f.attrs?.['id'])).toMatch(/^[A-Za-z0-9_-]{16}$/);
  // Fresh identifiers and keys that no other field of the document has.
  expect(new Set(all.map((f) => f.attrs?.['id'])).size).toBe(9);
  expect(new Set(all.map((f) => f.attrs?.['key'])).size).toBe(9);
  // The fields are inline in the paragraph the caret was in, and drawn as controls.
  const paragraph = nodes(await confirmed(page, 'one'), 'paragraph').find((p) =>
    (p.content ?? []).some((n) => n.type === 'text' && String(n['text' as never]).includes('Last')),
  );
  expect((paragraph?.content ?? []).filter((n) => n.type === 'form_field')).toHaveLength(5);
  for (const f of added)
    await expect(
      page.locator(`${EDITOR} .de-form-field[data-field="${String(f.attrs?.['id'])}"]`),
    ).toBeVisible();
});

test('at 2,000 fields the insert commands are disabled with the stated reason', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openEmbed(page);
  await mountFields(page, { name: 'one', sub: 'bob', role: 'editor', limit: true });
  expect(await formFields(page)).toHaveLength(1999);
  await page.locator(`${EDITOR} .de-editing-surface p`, { hasText: 'Last paragraph.' }).click();

  // One short of the limit: the command is offered and the 2,000th field is stored.
  const offered = await search(page, 'Text field');
  await expect(offered).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await formFields(page)).length).toBe(2000);

  // At the limit: every kind is listed disabled with the reason, and Enter inserts nothing.
  for (const [label] of KINDS) {
    const option = await search(page, label);
    await expect(option).toHaveAttribute('aria-disabled', 'true');
    await expect(option).toContainText(LIMIT_REASON);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
  }
  expect(await formFields(page)).toHaveLength(2000);
});
