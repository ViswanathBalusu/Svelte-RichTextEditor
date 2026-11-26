/**
 * FE-140 criteria 1 and 3 in the real element: an author inserts a citation of two sources, with a
 * prefix and a locator, through the command registry (command search, Alt+Q) and the keyboard alone;
 * the document stores a citation node naming the sources; the citation is a `note` whose accessible
 * name holds the sources in the document's style, which is what a screen reader reads when the caret
 * reaches it. No screen reader product is run.
 *
 * Run: `DOCEDIT_DEMO_PORT=57844 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-140-citation.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'fe-140';
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
              { type: 'page_setup', attrs: { id: 'ps1Fe140000000001' } },
              {
                type: 'source_def',
                attrs: {
                  id: 'smith2026',
                  kind: 'book',
                  title: 'A book',
                  authors: [{ family: 'Smith', given: 'Ann' }],
                  issued: '2026',
                },
              },
              {
                type: 'source_def',
                attrs: {
                  id: 'jones2024',
                  kind: 'article-journal',
                  title: 'An article',
                  authors: [{ family: 'Jones', given: 'Bo' }],
                  issued: '2024',
                },
              },
            ],
          },
          {
            type: 'body',
            attrs: { pageSetup: 'ps1Fe140000000001' },
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'pOne000000000001', style: null },
                content: [{ type: 'text', text: 'Alpha beta' }],
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
      el.setAttribute('toolbar', 'full');
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { id, name: NAME },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

/** The citations of the document the core holds, as `{ items, mode }`. */
function citations(page: Page): Promise<{ items: Record<string, unknown>[]; mode: string }[]> {
  return page.evaluate((host) => {
    const embed = (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { core: { getContent(): { doc: unknown } } } };
        };
      }
    ).__embed;
    const found: { items: Record<string, unknown>[]; mode: string }[] = [];
    const walk = (n: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
      if (n.type === 'citation')
        found.push({
          items: n.attrs?.['items'] as Record<string, unknown>[],
          mode: String(n.attrs?.['mode']),
        });
      for (const c of n.content ?? []) walk(c as typeof n);
    };
    walk(embed.internals(document.querySelector(host)!).editor.core.getContent().doc as never);
    return found;
  }, HOST);
}

test('FE-140: a citation is inserted from the command search and the keyboard, and is named by its sources', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  await mount(page);
  await page.locator(`${HOST} .de-editing-surface p`).first().click();

  // The command is in the registry: command search finds it by name.
  await page.keyboard.press('Alt+q');
  await expect(page.getByRole('combobox')).toBeFocused();
  await page.keyboard.type('Citation');
  await expect(page.getByRole('option', { name: /Citation/ }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Insert a citation' });
  await expect(dialog).toBeVisible();

  // The first source has focus; Space ticks it, Tab reaches its prefix, locator and suffix.
  await expect(dialog.getByRole('checkbox').first()).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await page.keyboard.type('see');
  await page.keyboard.press('Tab');
  await page.keyboard.type('12');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Insert' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);

  await expect.poll(async () => (await citations(page)).length).toBe(1);
  const [citation] = await citations(page);
  expect(citation!.mode).toBe('normal');
  expect(citation!.items).toEqual([
    { source: 'smith2026', prefix: 'see', locator: '12' },
    { source: 'jones2024' },
  ]);

  // A screen reader reads the note's name: the sources in order, with the prefix and the locator.
  const note = page.locator(`${HOST} .de-editing-surface .de-citation`);
  await expect(note).toHaveAttribute('role', 'note');
  await expect(note).toHaveAttribute(
    'aria-label',
    /^Citation: see Smith.*A book.*\(12\); Jones.*An article/,
  );
  await expect(page.getByRole('note', { name: /Citation: see Smith/ })).toBeVisible();
  expect(errors).toEqual([]);
});
