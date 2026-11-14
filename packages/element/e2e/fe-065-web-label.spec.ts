/**
 * FE-065 criteria 1 and 3, the web view part (lane V-FE-065-080, round 3). With `view="web"` (and
 * with the default) the web view is shown and labelled "Web layout", a label that comes from the
 * element's interface strings (view-select.ts, VIEW_STRINGS), and no page edge is drawn. A change of
 * `view` between web and print keeps the editing surface and its document: print has no page view
 * yet and falls back to the web view, so the session is kept (criterion 3 for those two values; the
 * read view has no core and is not covered here). Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57040 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-065-web-label.spec.ts`
 * (Chromium, Firefox and WebKit).
 */
import { expect, test, type Page } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

/** The label, page-edge and surface facts of the element's shadow root. */
function webFacts(page: Page) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    const label = root.querySelector<HTMLElement>('.de-view-label');
    return {
      label: label?.textContent ?? null,
      labelView: label?.dataset['view'] ?? null,
      surfaces: root.querySelectorAll('.de-editing-surface').length,
      pageEdges: root.querySelectorAll('[class*="page-edge"], [data-view="print"], .de-page-view')
        .length,
    };
  }, editor);
}

test('the web view is labelled "Web layout" and draws no page edge (FE-065, criterion 1)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { attributes: { view: 'web' } });

  const facts = await webFacts(page);
  expect(facts.label).toBe('Web layout');
  expect(facts.labelView).toBe('web');
  expect(facts.surfaces).toBe(1);
  expect(facts.pageEdges).toBe(0);
});

test('the label is there by default, with no view attribute (FE-065, criterion 1)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page);

  expect((await webFacts(page)).label).toBe('Web layout');
});

test('a change between web and print keeps the editing surface and its text (FE-065, criterion 3)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { attributes: { view: 'web' } });
  const before = await bodyText(page);
  // Mark the surface node: a new mount would make a new node.
  await page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    (root.querySelector('.de-editing-surface') as HTMLElement & { __kept?: boolean }).__kept = true;
  }, editor);

  await page.evaluate((sel) => document.querySelector(sel)!.setAttribute('view', 'print'), editor);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));

  const kept = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    return (
      (root.querySelector('.de-editing-surface') as HTMLElement & { __kept?: boolean }).__kept ===
      true
    );
  }, editor);
  expect(kept).toBe(true);
  expect(await bodyText(page)).toBe(before);
  expect((await webFacts(page)).label).toBe('Web layout');
});
