/**
 * FE-134 criterion 2 in the real element: the Cross-reference command opens a dialog that lists
 * what a reference may point at (a numbered caption, a labelled equation, a bookmark on a numbered
 * block), and choosing one inserts a `ref` field that targets it in the chosen format. Criterion 1
 * runs through the core first: a table caption and an equation caption.
 * Run: `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-134-cross-reference.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed, selectionSynced } from './embed-helpers.ts';

const NAME = 'fe-134';
const HOST = `doc-editor[data-test="${NAME}"]`;

/** A UUID version 7 for this run. */
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
      const p = (pid: string, text: string, content?: unknown[]) => ({
        type: 'paragraph',
        attrs: { id: pid, style: null },
        content: content ?? [{ type: 'text', text }],
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
              { type: 'page_setup', attrs: { id: 'ps1Fe134000000001' } },
            ],
          },
          {
            type: 'body',
            attrs: { pageSetup: 'ps1Fe134000000001' },
            content: [
              p('pIntro0000000001', 'Introduction'),
              {
                type: 'table',
                attrs: { id: 'tblFe13400000001', grid: [1440] },
                content: [
                  {
                    type: 'table_row',
                    attrs: { id: 'rowFe13400000001' },
                    content: [
                      {
                        type: 'table_cell',
                        attrs: { id: 'celFe13400000001' },
                        content: [p('pCell00000000001', 'Cell text')],
                      },
                    ],
                  },
                ],
              },
              { type: 'equation_block', attrs: { id: 'eqFe134000000001', latex: 'E=mc^2' } },
              p('pEnd000000000001', 'The end'),
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
      el.setAttribute('toolbar', 'full');
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { id, name: NAME },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

/** Runs `fn` with the document core of the element. */
function withCore<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    ({ host, fn, arg }) => {
      const embed = (
        window as unknown as {
          __embed: { internals(el: Element): { editor: { core: unknown } } };
        }
      ).__embed;
      const core = embed.internals(document.querySelector(host)!).editor.core;
      return new Function('core', 'arg', `return (${fn})(core, arg);`)(core, arg) as never;
    },
    { host: HOST, fn, arg },
  );
}

/** The `ref` fields of the document as `[target, format, cached]`. */
function refs(page: Page): Promise<unknown[][]> {
  return withCore(
    page,
    `(core) => {
      const out = [];
      const walk = (n) => {
        if (n.type === 'field' && n.attrs && n.attrs.kind === 'ref')
          out.push([n.attrs.target, n.attrs.format ?? null, n.attrs.cached ?? null]);
        for (const c of n.content ?? []) walk(c);
      };
      walk(core.getContent().doc);
      return out;
    }`,
  );
}

const dialog = (page: Page) => page.locator(`${HOST} dialog[data-dialog="cross-reference"]`);

test('FE-134: a table and an equation are numbered, and the dialog inserts a reference to either', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  await mount(page);

  // Criterion 1: a caption for the table the caret is in, and for the equation block.
  await page.locator(`${HOST} .de-editing-surface td p`).first().click();
  await selectionSynced(page, NAME);
  expect(
    await withCore<boolean>(
      page,
      `(core) => core.exec('insertCaption', { caption: { kind: 'here' } })`,
    ),
  ).toBe(true);
  expect(
    await withCore<boolean>(
      page,
      `(core) => core.exec('insertCaption', { caption: { kind: 'equation', id: 'eqFe134000000001' } })`,
    ),
  ).toBe(true);

  // Criterion 2: the dialog from the Insert tab.
  await page.locator(`${HOST} .de-editing-surface p`).last().click();
  await page.keyboard.press('End');
  await selectionSynced(page, NAME);
  await page.locator(`${HOST}`).getByRole('tab', { name: 'Insert' }).click();
  await page.locator(`${HOST} [data-command-id="insert.crossReference"]`).first().click();
  await expect(dialog(page)).toBeVisible();
  const items = dialog(page).locator('[data-cross-ref-target]');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveText('Table 1, prints 1');
  await expect(items.last()).toHaveText('eq1, prints 1');

  // Insert is off until a target is chosen; the filter keeps what matches.
  await expect(dialog(page).getByRole('button', { name: 'Insert' })).toBeDisabled();
  await dialog(page).getByLabel('Refer to').selectOption('equation');
  await expect(items).toHaveCount(1);

  await dialog(page).getByRole('radio', { name: /eq1/ }).check();
  await dialog(page).getByRole('radio', { name: 'The page number' }).check();
  await dialog(page).getByRole('button', { name: 'Insert' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => refs(page)).toEqual([['eq:eq1', 'page', '1']]);

  // A second reference, to the table caption, with the default format.
  await page.locator(`${HOST} .de-editing-surface p`).last().click();
  await page.keyboard.press('End');
  await selectionSynced(page, NAME);
  await page.locator(`${HOST} [data-command-id="insert.crossReference"]`).first().click();
  await dialog(page)
    .getByRole('radio', { name: /Table 1/ })
    .check();
  await dialog(page).getByRole('button', { name: 'Insert' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect
    .poll(async () => (await refs(page)).map((r) => r[0]).sort())
    .toEqual(['eq:eq1', expect.stringMatching(/^node:/)]);
  expect(errors).toEqual([]);
});
