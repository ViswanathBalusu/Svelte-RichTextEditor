/**
 * PRO-039 criteria 2 and 3 in a real browser: a document the person may not open (`forbidden`) is
 * shown as no access, with one action, and the host still gets its fatal `de-error` (decision 45).
 * The other codes are tested in packages/element/test/pro-039-failure-surface.test.ts, where the
 * wait of a refused request can be controlled.
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

test('a document the person may not open is shown as no access, and de-error is raised', async ({
  page,
}) => {
  await openEmbed(page);
  const errors = await page.evaluate(async () => {
    const e = (window as unknown as { __embed: { backend(sub: string, role: string): unknown } })
      .__embed;
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'no-access';
    const raised: unknown[] = [];
    el.addEventListener('de-error', (ev) => raised.push((ev as CustomEvent).detail));
    // The backend's token does not cover this document.
    el.backend = e.backend('ada', 'editor');
    el.setAttribute('doc-id', '0192f0c4-7b1e-7c3a-9a54-00000000beef');
    document.body.append(el);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return raised;
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: 'forbidden', fatal: true });
  const area = page.locator('doc-editor[data-test="no-access"] .de-failure');
  await expect(area).toBeVisible();
  await expect(area).toHaveAttribute('role', 'alert');
  await expect(area).toHaveAttribute('data-kind', 'no-access');
  await expect(area.locator('.de-failure-title')).toHaveText(
    'You do not have access to this document',
  );
  // One action; it is enabled, and nothing was retried before it was chosen.
  const action = area.locator('button');
  await expect(action).toHaveCount(1);
  await expect(action).toBeEnabled();
  expect(await page.evaluate(() => document.querySelectorAll('doc-editor').length)).toBe(1);
});
