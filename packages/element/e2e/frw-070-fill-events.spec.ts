/**
 * FRW-070 (lane w4): `de-field-change` and `de-fill-progress` from the real element, with the
 * shell's guided bar, the core's field controls and the in-memory backend of the embed page. A
 * participant who may only fill the tenant's fields opens the form document with `mode="fill"`,
 * types into the controls, and the page's listeners on `document` record what crosses the shadow
 * boundary.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-070-fill-events.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { events, openEmbed } from './embed-helpers.ts';
import { FIELD_IDS as IDS, control, editorOf, mountFields } from './frw-helpers.ts';

const EDITOR = editorOf('fill');
const mountFill = (page: Page): Promise<void> =>
  mountFields(page, { name: 'fill', sub: 'vic', fill: true });

test('an entry raises de-field-change without the value, across the shadow boundary', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);

  await control(page, IDS.name, 'fill').fill('Zebedee-Quux');
  await control(page, IDS.name, 'fill').press('Tab');
  await expect.poll(async () => (await events(page, 'de-field-change')).length).toBe(1);
  await control(page, IDS.email, 'fill').fill('not-an-address-7731');
  await control(page, IDS.email, 'fill').press('Tab');
  await expect.poll(async () => (await events(page, 'de-field-change')).length).toBe(2);

  const raised = await events(page, 'de-field-change');
  // Heard on `document`, outside the shadow root: the target is the element itself (05 §8.1).
  for (const e of raised) {
    expect(e.target).toBe('doc-editor');
    expect(e.element).toBe('fill');
    expect(e.composed).toBe(true);
    expect(e.bubbles).toBe(true);
  }
  expect(raised.map((e) => e.detail)).toEqual([
    { fieldId: IDS.name, key: 'tenant.name', valid: true, empty: false },
    { fieldId: IDS.email, key: 'tenant.email', valid: false, empty: false },
  ]);
  // Every event the page recorded, serialised: neither entry is in any of them.
  const wire = JSON.stringify(await events(page));
  expect(wire).not.toContain('Zebedee-Quux');
  expect(wire).not.toContain('not-an-address-7731');
});

test('de-fill-progress carries the count the guided bar shows', async ({ page }) => {
  await openEmbed(page);
  await mountFill(page);
  const bar = page.locator(`${EDITOR} .de-fill-bar [data-status="fill-progress"]`);
  // The landlord's required field is not this participant's: two required fields, not three.
  await expect(bar).toHaveText('0 of 2 required fields filled');
  await expect
    .poll(async () => (await events(page, 'de-fill-progress')).map((e) => e.detail))
    .toEqual([{ filled: 0, total: 2 }]);

  await control(page, IDS.name, 'fill').fill('Ada');
  await control(page, IDS.name, 'fill').press('Tab');
  await expect(bar).toHaveText('1 of 2 required fields filled');
  await expect
    .poll(async () => (await events(page, 'de-fill-progress')).at(-1)?.detail)
    .toEqual({ filled: 1, total: 2 });

  // An optional field does not move the count, so nothing more is raised.
  await control(page, IDS.amount, 'fill').fill('12');
  await control(page, IDS.amount, 'fill').press('Tab');
  await expect.poll(async () => (await events(page, 'de-field-change')).length).toBe(2);
  expect(await events(page, 'de-fill-progress')).toHaveLength(2);

  await control(page, IDS.email, 'fill').fill('ada@example.org');
  await control(page, IDS.email, 'fill').press('Tab');
  await expect(page.locator(`${EDITOR} .de-fill-bar [data-status="fill-done"]`)).toBeVisible();
  await expect(bar).toHaveText('2 of 2 required fields filled');
  const progress = await events(page, 'de-fill-progress');
  expect(progress.at(-1)?.detail).toEqual({ filled: 2, total: 2 });
  for (const e of progress) {
    expect(e.target).toBe('doc-editor');
    expect(e.composed).toBe(true);
    expect(e.bubbles).toBe(true);
  }
});
