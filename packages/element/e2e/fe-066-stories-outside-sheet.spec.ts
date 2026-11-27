/**
 * FE-066 criterion 6, in part (lane w1): a document with a header and a footer story is shown in
 * the web view without either story in the continuous sheet, and the header is reached through its
 * panel with the shell's own command (`page.header`); the footer is reached the same way with
 * `page.footer`, which opens the footer and not the header.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-066-stories-outside-sheet.spec.ts --retries=0
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const HEADER = 'Running header of the contract';
const FOOTER = 'Running footer of the contract';
const BODY = 'Body paragraph of the contract.';

test('FE-066 header and footer stories are not in the sheet; each opens in its panel', async ({
  page,
}) => {
  await openEmbed(page);
  await page.evaluate(
    async ({ header, footer, body }) => {
      const e = (
        window as unknown as {
          __embed: {
            service: { createDocument(doc: unknown): string };
            backend(sub: string, role: string, docs: string[]): unknown;
          };
        }
      ).__embed;
      const p = (id: string, text: string) => ({
        type: 'paragraph',
        attrs: { id },
        content: [{ type: 'text', text }],
      });
      const docId = e.service.createDocument({
        cdm: 1,
        requires: [],
        doc: {
          type: 'doc',
          content: [
            {
              type: 'defs',
              content: [
                { type: 'settings', attrs: { lang: 'en-GB' } },
                {
                  type: 'style_def',
                  attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
                },
                {
                  type: 'page_setup',
                  attrs: {
                    id: 'ps1',
                    headerDefault: 'stHeader00000001',
                    footerDefault: 'stFooter00000001',
                  },
                },
              ],
            },
            {
              type: 'story',
              attrs: { id: 'stHeader00000001', kind: 'header' },
              content: [p('pHeader000000001', header)],
            },
            {
              type: 'story',
              attrs: { id: 'stFooter00000001', kind: 'footer' },
              content: [p('pFooter000000001', footer)],
            },
            { type: 'body', attrs: { pageSetup: 'ps1' }, content: [p('pBody00000000001', body)] },
          ],
        },
      });
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'one';
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = e.backend('ada', 'editor', [docId]);
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { header: HEADER, footer: FOOTER, body: BODY },
  );

  // The sheet shows the body and neither story: no text of them is rendered in it.
  const sheet = page.locator('doc-editor .de-editing-surface').first();
  await expect(sheet).toContainText(BODY);
  const shown = await sheet.innerText();
  expect(shown).not.toContain(HEADER);
  expect(shown).not.toContain(FOOTER);
  // Whatever element holds a story in the sheet's DOM takes no room in it.
  const boxes = await sheet.evaluate(
    (root, texts) =>
      texts.map((text) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let area = 0;
        for (let n = walker.nextNode(); n; n = walker.nextNode())
          if (n.textContent?.includes(text)) {
            const box = n.parentElement!.getBoundingClientRect();
            area += box.width * box.height;
          }
        return area;
      }),
    [HEADER, FOOTER],
  );
  expect(boxes).toEqual([0, 0]);

  // A command of the shell: in the toolbar row, or in the overflow menu when the row is narrow.
  const runCommand = async (id: string): Promise<void> => {
    const inRow = page.locator(`doc-editor .de-toolbar > [data-command-id="${id}"]`);
    if (await inRow.isVisible()) await inRow.click();
    else {
      await page.locator('doc-editor [data-command-id="toolbar.more"]').click();
      await page.locator(`doc-editor [role="menu"] [data-command-id="${id}"]`).click();
    }
  };

  // The header is reached through its panel, opened with the shell's command.
  await runCommand('page.header');
  const panel = page.locator('doc-editor .de-sub-editor');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(HEADER);
  await expect(panel).not.toContainText(FOOTER);
  // The panel is not inside the sheet.
  expect(
    await panel.evaluate(
      (el) => el.closest('.de-editing-surface') === null || el.matches('.de-editing-surface'),
    ),
  ).toBe(true);

  // The footer has its command (FE-066 criterion 6): the panel shows the footer and not the header.
  await runCommand('page.footer');
  await expect(panel).toContainText(FOOTER);
  await expect(panel).not.toContainText(HEADER);
  const afterFooter = await sheet.innerText();
  expect(afterFooter).not.toContain(FOOTER);
  expect(afterFooter).not.toContain(HEADER);
});
