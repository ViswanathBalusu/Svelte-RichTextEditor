/**
 * UX-102 in the real element (lane w3, 2026-11-25): the ruler shows the indents of the paragraph at
 * the caret, a keyboard step or a drag on a marker changes the paragraph in the document through
 * `setParagraphFormat`, the paragraph dialog sets the same values, and the web view labels the
 * margins as the PDF's. The shell's own run, against a fake core, is
 * packages/ui/e2e/ux-102-ruler.spec.ts.
 * Run: `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-102-ruler.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'ux-102';
const HOST = `doc-editor[data-test="${NAME}"]`;
const CM = 1440 / 2.54;
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
              { type: 'page_setup', attrs: { id: 'ps1Ux102000000001' } },
            ],
          },
          {
            type: 'body',
            attrs: { pageSetup: 'ps1Ux102000000001' },
            content: [
              p('pOne000000000001', 'First paragraph'),
              p('pTwo000000000001', 'Second paragraph'),
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

/** The paragraph attributes of the block with this text. */
function attrsOf(page: Page, text: string): Promise<Record<string, unknown>> {
  return withCore(
    page,
    `(core) => {
      let found = null;
      const walk = (n) => {
        if (n.type === 'paragraph' && (n.content ?? []).some((c) => c.text === ${JSON.stringify(text)}))
          found = n.attrs;
        for (const c of n.content ?? []) walk(c);
      };
      walk(core.getContent().doc);
      return found;
    }`,
  );
}

const marker = (page: Page, name: string) =>
  page.locator(`${HOST} .de-ruler`).getByRole('slider', { name });

test('UX-102: the ruler follows the caret, and keys, a drag and the dialog change the paragraph', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  await mount(page);

  const ruler = page.locator(`${HOST} .de-ruler`);
  await expect(ruler).toBeVisible();
  await expect(ruler).toHaveAttribute('part', 'ruler');
  // Criterion 4: the margins are the PDF's, said in words; no page is drawn.
  await expect(ruler.locator('p.de-hint')).toContainText('The PDF has margins of');

  // Criterion 1: the caret in the first paragraph.
  await page.locator(`${HOST} .de-editing-surface p`).first().click();
  await expect(marker(page, 'Left indent')).toHaveAttribute('aria-valuenow', '0');

  // Criterion 3: a key on the left marker moves it a quarter of a centimetre, through the command.
  await marker(page, 'Left indent').focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await attrsOf(page, 'First paragraph'))['indentLeft'])
    .toBe(Math.round(CM / 4));
  expect((await attrsOf(page, 'Second paragraph'))['indentLeft'] ?? null).toBeNull();

  // Criterion 2: a drag on the right marker changes the right indent of the same paragraph.
  const right = marker(page, 'Right indent');
  const box = (await right.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 20, y, { steps: 4 });
  await page.mouse.move(x - 57, y, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => Number((await attrsOf(page, 'First paragraph'))['indentRight'] ?? 0))
    .toBeGreaterThan(Math.round(1.2 * CM));

  // Criterion 3: the dialog sets the same values.
  await page.locator(`${HOST} .de-editing-surface p`).last().click();
  await page.locator(`${HOST} .de-ruler`).getByRole('button', { name: 'Paragraph…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Paragraph' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Left indent (cm)').fill('2');
  await dialog.getByRole('button', { name: 'Add a tab stop' }).click();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await attrsOf(page, 'Second paragraph'))['indentLeft'])
    .toBe(Math.round(2 * CM));
  const tabs = (await attrsOf(page, 'Second paragraph'))['tabs'] as unknown[];
  expect(tabs).toHaveLength(1);
  await expect(marker(page, 'Tab stop, Left')).toHaveCount(1);
  expect(errors).toEqual([]);
});
