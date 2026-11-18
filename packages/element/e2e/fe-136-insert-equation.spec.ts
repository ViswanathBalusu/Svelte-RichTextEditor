/**
 * FE-136 criterion 5 in the real element: the equation command (`insertEquation`) inserts an empty
 * block or inline equation at the caret, and the math editor opens on it (FE-070), with an empty
 * source and focus in it. Confirming a source stores it on the new equation. The setup is the one
 * of fe-070-math-editor.spec.ts: the embed page's math service and the strict policy the
 * integration guide lists for the editor.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57136 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-136-insert-equation.spec.ts`
 * in Chromium, Firefox and WebKit.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { encodePolicy } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { openEmbed } from './embed-helpers.ts';

const FONT_DIR = fileURLToPath(new URL('../node_modules/katex/dist/fonts/', import.meta.url));
const KITCHEN_SINK = fileURLToPath(
  new URL('../../model/fixtures/kitchen-sink.json', import.meta.url),
);
const EDITOR = 'doc-editor[data-test="math"]';
const DIALOG = `${EDITOR} dialog[data-dialog="math"]`;

const MATH_POLICY = policy({
  'trusted-types': 'docedit-math docedit-paste ProseMirrorClipboard docedit-worker',
  'style-src-attr': "'unsafe-inline'",
  'report-uri': null,
});

async function open(page: Page): Promise<void> {
  await page.route('**/katex-fonts/*.woff2', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    await route.fulfill({ body: readFileSync(FONT_DIR + name), contentType: 'font/woff2' });
  });
  await openEmbed(page, `?csp=${encodePolicy(MATH_POLICY)}`);
  const outcome = await page.evaluate(
    async ({ env }) => {
      const w = window as unknown as {
        __embed: {
          mathService: {
            createDocument(env: unknown): string;
            backend(user: unknown, grants: Record<string, string>): unknown;
          };
        };
      };
      const id = w.__embed.mathService.createDocument(env);
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        config: unknown;
      };
      el.dataset['test'] = 'math';
      el.config = { katexFontsUrl: `${location.origin}/katex-fonts/` };
      const ready = new Promise<string>((resolve) => {
        el.addEventListener('de-ready', () => resolve('ready'), { once: true });
        el.addEventListener('de-error', () => resolve('error'), { once: true });
      });
      el.backend = w.__embed.mathService.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'editor' });
      el.setAttribute('doc-id', id);
      document.getElementById('mount')!.append(el);
      return Promise.race([
        ready,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);
    },
    { env: JSON.parse(readFileSync(KITCHEN_SINK, 'utf8')) },
  );
  expect(outcome).toBe('ready');
  await expect(page.locator(`${EDITOR} .de-equation .katex`).first()).toBeVisible({
    timeout: 15_000,
  });
}

/** Puts the caret in the first paragraph, then runs the equation command through the core. */
async function insert(page: Page, display: boolean): Promise<boolean> {
  return page.evaluate((display) => {
    type Core = {
      exec(name: string, args: unknown): boolean;
      focus(): void;
    };
    const w = window as unknown as {
      __embed: { internals(el: Element): { editor: { core: Core } } };
    };
    const el = document.querySelector('doc-editor[data-test="math"]')!;
    const core = w.__embed.internals(el).editor.core;
    // A click in the first paragraph puts the caret there, as a person would.
    const p = el.shadowRoot!.querySelector<HTMLElement>('.de-editing-surface p')!;
    const r = p.getBoundingClientRect();
    p.dispatchEvent(
      new MouseEvent('mousedown', { clientX: r.left + 2, clientY: r.top + 2, bubbles: true }),
    );
    core.focus();
    return core.exec('insertEquation', { newEquation: { display } });
  }, display);
}

test('FE-136: the equation command opens the math editor on a new equation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);

  const blocks = page.locator(`${EDITOR} .de-equation-block`);
  const before = await blocks.count();
  expect(await insert(page, true)).toBe(true);

  // The editor opens on the new, empty equation, with focus in the source field.
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`${DIALOG} [data-state="ready"]`)).toBeVisible({ timeout: 15_000 });
  const source = page.locator(`${DIALOG} textarea`);
  await expect(source).toHaveValue('');
  await expect(source).toBeFocused();
  expect(await blocks.count()).toBe(before + 1);

  // Confirming stores the source on the new equation and closes the editor.
  await source.fill('a^2+b^2');
  await page.locator(`${DIALOG} button[type="submit"]`).click();
  await expect(page.locator(DIALOG)).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(`${EDITOR} .de-equation-block[data-latex="a^2+b^2"]`)).toHaveCount(1);
  expect(errors).toEqual([]);
});
