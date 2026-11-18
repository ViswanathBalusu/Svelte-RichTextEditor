/**
 * FRW-078 (lane w4): the summary of what is left, in the real element and its shadow root, against
 * the in-memory backend of the embed page. The participant (`vic`) holds the tenant's role and may
 * only fill. The form document has two required tenant fields (name and e-mail), an optional
 * amount, and a landlord field the participant does not fill.
 *
 * - Criterion 2: activating a link in the summary moves focus to the control of the field in the
 *   editing surface, and scrolls it into view.
 * - Criterion 5: the summary is reached and operated by keyboard alone, its links are named
 *   buttons, and closing it returns focus to the control that opened it.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-078-summary.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { FIELD_IDS as IDS, control, editorOf, mountFields } from './frw-helpers.ts';

const FILL = editorOf('fill');
const bar = (page: Page) => page.locator(`${FILL} .de-fill-bar`);
const toggle = (page: Page) => bar(page).getByRole('button', { name: 'What is left' });
const pane = (page: Page) => page.locator(`${FILL} .de-pane[data-pane="fill"]`);
const link = (page: Page, label: string) =>
  pane(page).locator('[data-status="fill-progress"] ~ ul li button', { hasText: label }).first();

/** The name of the part that holds focus, read in the shadow root of the editor. */
const focused = (page: Page) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    const a = root.activeElement as HTMLElement | null;
    if (!a) return null;
    const field = a.closest('.de-form-field')?.getAttribute('data-field');
    return field ? `field:${field}` : `${a.tagName.toLowerCase()}:${a.textContent?.trim() ?? ''}`;
  }, FILL);

test('activating a link moves focus to the field and scrolls it into view (criterion 2)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFields(page, { name: 'fill', sub: 'vic', fill: true });

  // Push the fields out of view, so that the scroll is the link's doing.
  await control(page, IDS.email, 'fill').evaluate((el) => {
    const block = el.closest('p');
    if (block) block.style.marginTop = '4000px';
  });
  await expect(control(page, IDS.email, 'fill')).not.toBeInViewport();

  await toggle(page).click();
  await expect(pane(page)).toBeVisible();
  await link(page, 'E-mail').click();

  await expect(control(page, IDS.email, 'fill')).toBeFocused();
  expect(await focused(page)).toBe(`field:${IDS.email}`);
  await expect(control(page, IDS.email, 'fill')).toBeInViewport();

  // A second link goes to another field: focus follows each time.
  await link(page, 'Name').click();
  await expect(control(page, IDS.name, 'fill')).toBeFocused();
  await expect(control(page, IDS.name, 'fill')).toBeInViewport();
});

test('the summary is reached and operated by keyboard, and closing returns focus (criterion 5)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFields(page, { name: 'fill', sub: 'vic', fill: true });

  // Reach the summary's control and open it with Enter.
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expect(pane(page)).toBeVisible();

  // The pane is a landmark with a name, its links are buttons with the field's label in the name,
  // and focus moved into it.
  await expect(pane(page)).toHaveAttribute('aria-labelledby', /.+/);
  const nameLink = pane(page).getByRole('button', { name: /^Name/ }).first();
  await expect(nameLink).toContainText('Required, not filled');
  expect(await focused(page)).toMatch(/^button:/);

  // Tab walks the links; Enter on one moves focus to the field.
  await nameLink.focus();
  await page.keyboard.press('Enter');
  await expect(control(page, IDS.name, 'fill')).toBeFocused();

  // The summary stays open. Escape in it closes it, and focus returns to the control that opened
  // it, not to the top of the page.
  await expect(pane(page)).toBeVisible();
  await pane(page)
    .getByRole('button', { name: /^E-mail/ })
    .first()
    .focus();
  await page.keyboard.press('Escape');
  await expect(pane(page)).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
});

test('opening the summary from the keyboard and closing it with the control returns focus (criterion 5)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFields(page, { name: 'fill', sub: 'vic', fill: true });
  await toggle(page).focus();
  await page.keyboard.press('Space');
  await expect(pane(page)).toBeVisible();
  await pane(page)
    .getByRole('button', { name: /^Close/ })
    .click();
  await expect(pane(page)).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
});
