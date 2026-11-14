/**
 * PRO-080 criterion 2 in the production element (lane U-PRO-069-085): when an owner with `manage`
 * opens the grants pane and types in "Find a person or group", the element asks the host's
 * `searchPrincipals` for matching users and groups, with the document identifier and the query
 * text only, and lists the answer. Run from the repository root with
 * `DOCEDIT_DEMO_PORT=56130 pnpm exec playwright test -c packages/element/playwright.config.ts --project=chromium packages/element/e2e/pro-080-grants-search.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const EL = 'doc-editor[data-test="one"]';

test.describe('PRO-080 criterion 2: the grants pane asks the host for people and groups', () => {
  // Known gap (lane U-PRO-069-085, 2026-11-13): the element's shell core has no `regions` view (PRM-032)
  // and no `grants` service (PRM-035), so the grants pane is not offered and `openPane` returns false.
  // The test stays as a fixme until the engine and the element provide them.
  test.fixme('an owner who types in the grant search gets the host’s answer, with identifiers and text only', async ({
    page,
  }) => {
    await openEmbed(page);
    // The regions document has a region named "Middle"; the owner holds `manage` on it.
    await mountEditor(page, { name: 'one', sub: 'ada', role: 'owner', doc: 'regions' });
    await page.evaluate(() => {
      const w = window as unknown as { asked: unknown[] };
      w.asked = [];
      const el = document.querySelector('doc-editor[data-test="one"]') as HTMLElement & {
        searchPrincipals: unknown;
      };
      el.searchPrincipals = async (query: unknown) => {
        w.asked.push(query);
        return [
          { principal: 'user:bob', name: 'Bob Host' },
          { principal: 'group:editors', name: 'Editors' },
        ];
      };
    });

    const opened = await page.evaluate(() => {
      return (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
          };
        }
      ).__embed
        .internals(document.querySelector('doc-editor[data-test="one"]')!)
        .editor.openPane('permissions');
    });
    expect(opened).toBe(true);

    const element = page.locator(EL);
    await element.getByRole('button', { name: 'Middle', exact: true }).click();
    const search = element.getByRole('combobox', { name: 'Find a person or group' });
    await search.fill('Bo');

    await expect(element.getByRole('listbox')).toContainText('Bob Host');
    await expect(element.getByRole('listbox')).toContainText('Editors');

    const asked = await page.evaluate(
      () => (window as unknown as { asked: unknown[] }).asked as unknown[],
    );
    const regionsDocId = await page.evaluate(
      () => (window as unknown as { __embed: { regionsDocId: string } }).__embed.regionsDocId,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual({
      text: 'Bo',
      docId: regionsDocId,
      purpose: 'grant',
      kinds: ['user', 'group'],
      limit: 20,
    });
  });
});
