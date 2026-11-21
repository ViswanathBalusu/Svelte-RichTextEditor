/**
 * FE-136 criterion 4 in the real element: the host's font manifest names a font file; the element
 * reads its character map; a symbol inserted in a run set in that font, and that the font lacks, is
 * flagged in the status bar before any export, and the same symbol in a font that has it is not.
 * The font is KaTeX's Main face (a real TrueType file, served by a route): it has `A` and `Γ`, and
 * no `ω`.
 * Run: `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-136-glyph-notice.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'fe-136-glyph';
const HOST = `doc-editor[data-test="${NAME}"]`;
const FONT = readFileSync(
  fileURLToPath(
    new URL('../node_modules/katex/dist/fonts/KaTeX_Main-Regular.ttf', import.meta.url),
  ),
);

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
    async ({ id, name, origin }) => {
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
      const p = (pid: string, text: string, family: string) => ({
        type: 'paragraph',
        attrs: { id: pid, style: null },
        content: [
          { type: 'text', text, marks: [{ type: 'fontFamily', attrs: { value: family } }] },
        ],
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
              { type: 'page_setup', attrs: { id: 'ps1Fe136000000001' } },
            ],
          },
          {
            type: 'body',
            attrs: { pageSetup: 'ps1Fe136000000001' },
            content: [
              p('pTest00000000001', 'Test face text', 'Test Face'),
              p('pOther0000000001', 'Other face text', 'Other Face'),
            ],
          },
        ],
      };
      e.service.createDocument({ cdm: 1, requires: [], doc }, { id, grants: [] });
      const backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'owner' }) as {
        fonts?: unknown;
      };
      // The host's font manifest: Test Face is the file served below; Other Face has no file.
      backend.fonts = {
        manifest: () =>
          Promise.resolve({
            families: [
              {
                family: 'Test Face',
                licence: 'OFL-1.1',
                faces: [
                  {
                    url: `${origin}/fe136-fonts/main.ttf`,
                    sha256: 'b'.repeat(64),
                    weight: 400,
                    italic: false,
                  },
                ],
              },
            ],
          }),
      };
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
    { id, name: NAME, origin: new URL(page.url()).origin },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

/** Puts the caret at the end of the paragraph with a click, then inserts the symbol through the core. */
async function insertSymbol(page: Page, paragraph: number, symbol: string): Promise<boolean> {
  await page.locator(`${HOST} .de-editing-surface p`).nth(paragraph).click();
  await page.keyboard.press('End');
  return page.evaluate(
    ({ host, symbol }) => {
      type Core = { exec(name: string, args: unknown): boolean };
      const w = window as unknown as {
        __embed: { internals(el: Element): { editor: { core: Core } } };
      };
      const core = w.__embed.internals(document.querySelector(host)!).editor.core;
      return core.exec('insertSymbol', { symbol });
    },
    { host: HOST, symbol },
  );
}

const notice = (page: Page) => page.locator(`${HOST} .de-notice[data-kind="glyph"]`);

test('FE-136: a symbol the font lacks is flagged in the status bar, one it has is not', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/fe136-fonts/main.ttf', (route) =>
    route.fulfill({
      body: FONT,
      contentType: 'font/ttf',
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await openEmbed(page);
  // The coverage is read alongside the load, from the manifest's file.
  const fetched = page.waitForResponse('**/fe136-fonts/main.ttf');
  await mount(page);
  await fetched;

  // A character the font has: no flag.
  expect(await insertSymbol(page, 0, 'Γ')).toBe(true);
  await page.waitForTimeout(500);
  await expect(notice(page)).toHaveCount(0);

  // A character it lacks: the notice names the font and the character.
  expect(await insertSymbol(page, 0, 'ω')).toBe(true);
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toContainText('The font Test Face has no glyph for ω');

  // A family with no file in the manifest is never flagged: the notice stays that of Test Face.
  expect(await insertSymbol(page, 1, 'ψ')).toBe(true);
  await page.waitForTimeout(300);
  await expect(notice(page)).toContainText('for ω');
  expect(errors).toEqual([]);
});
