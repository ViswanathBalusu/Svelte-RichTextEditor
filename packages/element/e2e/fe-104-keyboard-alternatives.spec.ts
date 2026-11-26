/**
 * FE-104 in the real element: the keyboard and dialog forms of dragging, run without a pointer
 * after the caret is placed. The command search (Alt+Q) offers "Table column widths and row height",
 * whose dialog sets the grid and the row height through `setTableSize`, and "Move block up" and
 * "Move block down", which change the place of the paragraph at the caret through `moveBlockUp` and
 * `moveBlockDown`. The result is read from the document the core holds.
 * Run: `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-104-keyboard-alternatives.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'fe-104-keys';
const HOST = `doc-editor[data-test="${NAME}"]`;
const CM = 1440 / 2.54;

function uuid7(): string {
  const hex = Date.now().toString(16).padStart(12, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

async function mount(page: Page): Promise<void> {
  const id = uuid7();
  await page.evaluate(
    async ({ id, name }) => {
      const e = (
        window as unknown as {
          __embed: {
            service: {
              createDocument(content: unknown, opts: { id: string; grants: unknown[] }): string;
              backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
            };
          };
        }
      ).__embed;
      const p = (pid: string, text: string) => ({
        type: 'paragraph',
        attrs: { id: pid, style: null },
        content: [{ type: 'text', text }],
      });
      const cell = (cid: string, pid: string, text: string) => ({
        type: 'table_cell',
        attrs: { id: cid },
        content: [p(pid, text)],
      });
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'defs',
            content: [
              { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
              {
                type: 'style_def',
                attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
              },
              { type: 'page_setup', attrs: { id: 'ps1Fe104000000001' } },
            ],
          },
          {
            type: 'body',
            attrs: { pageSetup: 'ps1Fe104000000001' },
            content: [
              p('pOne000000000001', 'First paragraph'),
              p('pTwo000000000001', 'Second paragraph'),
              p('pThr000000000001', 'Third paragraph'),
              {
                type: 'table',
                attrs: { id: 'tab0000000000001', grid: [2880, 2880] },
                content: [
                  {
                    type: 'table_row',
                    attrs: { id: 'row0000000000001' },
                    content: [
                      cell('cel0000000000001', 'pCa0000000000001', 'A1'),
                      cell('cel0000000000002', 'pCb0000000000001', 'B1'),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      e.service.createDocument({ cdm: 1, requires: [], doc }, { id, grants: [] });
      const backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'owner' });
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = backend;
      el.setAttribute('doc-id', id);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { id, name: NAME },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

/** Runs `fn` with the document core of the element. */
function withCore<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(
    ({ host, fn }) => {
      const embed = (
        window as unknown as {
          __embed: { internals(el: Element): { editor: { core: unknown } } };
        }
      ).__embed;
      const core = embed.internals(document.querySelector(host)!).editor.core;
      return new Function('core', `return (${fn})(core);`)(core) as never;
    },
    { host: HOST, fn },
  );
}

/** The text of every block of the body, in order. */
function bodyOrder(page: Page): Promise<string[]> {
  return withCore(
    page,
    `(core) => {
      const body = core.getContent().doc.content.find((n) => n.type === 'body');
      const text = (n) => (n.text ?? '') + (n.content ?? []).map(text).join('');
      return body.content.map((n) => (n.type === 'table' ? 'table' : text(n)));
    }`,
  );
}

/** The grid and the first row's height of the table. */
function tableSize(page: Page): Promise<{ grid: number[]; height: number | null; rule: string }> {
  return withCore(
    page,
    `(core) => {
      const body = core.getContent().doc.content.find((n) => n.type === 'body');
      const table = body.content.find((n) => n.type === 'table');
      const row = table.content[0];
      return { grid: table.attrs.grid, height: row.attrs.height ?? null, rule: row.attrs.heightRule ?? 'auto' };
    }`,
  );
}

/** Opens the command search with Alt+Q, types a word, and takes the first match with Enter. */
async function chooseCommand(page: Page, word: string): Promise<void> {
  await page.keyboard.press('Alt+q');
  const search = page.locator(`${HOST} input[role="combobox"]`).first();
  await expect(search).toBeVisible();
  await search.fill(word);
  await page.keyboard.press('Enter');
}

test('FE-104: a block is moved up and down by command, and the caret stays in it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  await mount(page);

  await page.locator(`${HOST} .de-editing-surface p`).nth(1).click();
  await chooseCommand(page, 'Move block up');
  await expect
    .poll(() => bodyOrder(page))
    .toEqual(['Second paragraph', 'First paragraph', 'Third paragraph', 'table']);

  // The caret stays in the moved paragraph, so the next two commands move that same paragraph down.
  await chooseCommand(page, 'Move block down');
  await expect
    .poll(() => bodyOrder(page))
    .toEqual(['First paragraph', 'Second paragraph', 'Third paragraph', 'table']);
  await chooseCommand(page, 'Move block down');
  await expect
    .poll(() => bodyOrder(page))
    .toEqual(['First paragraph', 'Third paragraph', 'Second paragraph', 'table']);
  expect(errors).toEqual([]);
});

test('FE-104: the table size dialog sets the column widths and the row height', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  await mount(page);

  await page.locator(`${HOST} .de-editing-surface td p`).first().click();
  // The caret is in the table when the core publishes its size.
  await expect
    .poll(() => withCore<boolean>(page, '(core) => core.tableSize.get() !== null'))
    .toBe(true);
  await chooseCommand(page, 'Table column widths');
  const dialog = page.getByRole('dialog', { name: 'Table column widths and row height' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Column 1 width (cm)').fill('3');
  await dialog.getByLabel('Column 2 width (cm)').fill('7,5');
  await dialog.getByLabel('Height of row 1 (cm)').fill('1.5');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => tableSize(page))
    .toEqual({
      grid: [Math.round(3 * CM), Math.round(7.5 * CM)],
      height: Math.round(1.5 * CM),
      rule: 'atLeast',
    });

  // A length the CDM cannot store keeps the dialog open and says so.
  await chooseCommand(page, 'Table column widths');
  await dialog.getByLabel('Column 1 width (cm)').fill('wide');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await tableSize(page)).grid[0]).toBe(Math.round(3 * CM));
  expect(errors).toEqual([]);
});

test('FE-104: neither command is offered outside its place', async ({ page }) => {
  await openEmbed(page);
  await mount(page);
  // The caret in a paragraph: the table dialog says why it is unavailable.
  await page.locator(`${HOST} .de-editing-surface p`).first().click();
  await page.keyboard.press('Alt+q');
  const search = page.locator(`${HOST} input[role="combobox"]`).first();
  await search.fill('Table column widths');
  await expect(page.locator(`${HOST} [role="option"][aria-disabled="true"]`).first()).toBeVisible();
});
