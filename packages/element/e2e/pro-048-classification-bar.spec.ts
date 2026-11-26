/**
 * PRO-048 criterion 2 and UX-085 criterion 2 in the product: the element's core offers the
 * `classification` view over `GET /documents/{id}` (the mock backend's metadata read), the status
 * bar shows the label as text, and a change reaches the open editor through `document.updated`
 * with no reload. The shell's own rendering (markup in a name, blank labels, axe) is in
 * packages/ui/e2e/classification.spec.ts; this run proves the chain from the backend to the bar.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

test('PRO-048: the status bar shows the label of the document resource and follows a change', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { sub: 'ada', name: 'classified' });
  const editor = page.locator('doc-editor[data-test="classified"]');
  await expect(editor.locator('.de-editing-surface')).toBeVisible();
  const label = editor.locator('.de-status [data-status="classification"]');
  await expect(label).toHaveCount(0);

  const set = (value: string | null) =>
    page.evaluate((v) => {
      const e = (
        window as unknown as {
          __embed: {
            docId: string;
            service: { setClassification(id: string, label: string | null): void };
          };
        }
      ).__embed;
      e.service.setClassification(e.docId, v);
    }, value);

  await set('Internal use only');
  await expect(label).toHaveText('Classification: Internal use only');
  expect(await label.evaluate((el) => el.children.length)).toBe(0);

  await set('Confidential');
  await expect(label).toHaveText('Classification: Confidential');

  await set(null);
  await expect(label).toHaveCount(0);
});
