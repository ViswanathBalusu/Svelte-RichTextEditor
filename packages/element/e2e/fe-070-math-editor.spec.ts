/**
 * FE-070 (lane w1): the math editor in the real element, under the strict policy the integration
 * guide lists for it (Trusted Types with `docedit-math`, inline style attributes allowed, fonts
 * from the page's origin). A document with an inline equation and an equation block is served by
 * the embed page's service whose rooms run the converter's math gate (`mathService`).
 *
 * - The editor's chunk and MathLive load on demand: before the first request no custom element
 *   other than the project's is defined, and after it exactly `math-field`, `math-span` and
 *   `math-div` have been added (criterion 1).
 * - Confirming sets the source in one commit, which the service accepts (criterion 2 through the UI).
 * - A source over a limit shows its reason and is not committed (criterion 3).
 * - A source the math gate rejects is not applied, the service's reason is shown, the input is kept
 *   and a corrected source can be confirmed (criterion 4).
 * - No policy violation and no page error (criterion 5).
 * - The editor is operated by keyboard: Enter on the selected equation opens it, Tab reaches every
 *   control, Escape closes it from the source field and from the visual field, and focus returns
 *   to the editing surface with the equation still selected (criterion 6).
 * - A viewer's dialog is read-only (criterion 7).
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57070 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-070-math-editor.spec.ts`
 * in Chromium, Firefox and WebKit.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { encodePolicy } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { openEmbed } from './embed-helpers.ts';

const FONT_DIR = fileURLToPath(new URL('../node_modules/katex/dist/fonts/', import.meta.url));
const EDITOR = 'doc-editor[data-test="math"]';
const DIALOG = `${EDITOR} dialog[data-dialog="math"]`;

/** The strict policy plus what the guide lists for the math editor (Trusted Types names too). */
const MATH_POLICY = policy({
  'trusted-types': 'docedit-math docedit-paste ProseMirrorClipboard docedit-worker',
  'style-src-attr': "'unsafe-inline'",
  'report-uri': null,
});

async function open(page: Page, role: 'editor' | 'viewer'): Promise<void> {
  await page.route('**/katex-fonts/*.woff2', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    await route.fulfill({ body: readFileSync(FONT_DIR + name), contentType: 'font/woff2' });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[]; __defined: string[] };
    w.__violations = [];
    w.__defined = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push(`${e.effectiveDirective}:${e.blockedURI}`);
    });
    const define = customElements.define.bind(customElements);
    customElements.define = (name: string, ...rest: [CustomElementConstructor, never?]) => {
      w.__defined.push(name);
      return define(name, ...rest);
    };
  });
  await openEmbed(page, `?csp=${encodePolicy(MATH_POLICY)}`);
  const outcome = await page.evaluate(
    async ({ env, role }) => {
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
      el.backend = w.__embed.mathService.backend({ sub: 'ada', name: 'Ada' }, { [id]: role });
      el.setAttribute('doc-id', id);
      document.getElementById('mount')!.append(el);
      return Promise.race([
        ready,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);
    },
    { env: JSON.parse(readFileSync(KITCHEN_SINK, 'utf8')), role },
  );
  expect(outcome).toBe('ready');
  await expect(page.locator(`${EDITOR} .de-equation .katex`).first()).toBeVisible({
    timeout: 15_000,
  });
}

const KITCHEN_SINK = fileURLToPath(
  new URL('../../model/fixtures/kitchen-sink.json', import.meta.url),
);

const inline = (page: Page): Locator => page.locator(`${EDITOR} .de-equation`).first();
const sourceField = (page: Page): Locator => page.locator(`${DIALOG} textarea`);
const applyButton = (page: Page): Locator => page.locator(`${DIALOG} button[type="submit"]`);

const seq = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const e = (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { core: { confirmedSeq: { get(): number } } } };
        };
      }
    ).__embed;
    return e
      .internals(document.querySelector('doc-editor[data-test="math"]')!)
      .editor.core.confirmedSeq.get();
  });

/** Selects the first inline equation as a click does, and opens the editor with Enter. */
async function openEditor(page: Page): Promise<void> {
  await inline(page).click();
  await expect(page.locator(`${EDITOR} .ProseMirror-selectednode`)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toBeVisible();
}

const custom = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __defined: string[] }).__defined);

test('FE-070: edit an equation by keyboard, with limits and the math gate, under the strict policy', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, 'editor');

  // Criterion 1: nothing of the math editor is defined until it is first needed.
  const before = await custom(page);
  expect(before).not.toContain('math-field');
  await openEditor(page);
  await expect(page.locator(`${DIALOG} [data-state="ready"]`)).toBeVisible({ timeout: 15_000 });
  const added = (await custom(page)).filter((n) => !before.includes(n)).sort();
  expect(added).toEqual(['math-div', 'math-field', 'math-span']);

  // Criterion 6: the source field has focus; Tab reaches the visual field's neighbours in order.
  await expect(sourceField(page)).toBeFocused();
  await expect(sourceField(page)).toHaveValue('x^2');
  await sourceField(page).fill('x^2+1');
  await expect(applyButton(page)).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(applyButton(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator(`${DIALOG} button`, { hasText: 'Cancel' })).toBeFocused();

  // Criterion 3: a source over 4,000 characters shows the reason and is not committed.
  const start = await seq(page);
  await sourceField(page).fill('x'.repeat(4001));
  await expect(page.locator(`${DIALOG} .de-error`)).toContainText('4,000');
  await expect(applyButton(page)).toBeDisabled();
  await sourceField(page).fill('{'.repeat(51) + '}'.repeat(51));
  await expect(page.locator(`${DIALOG} .de-error`)).toContainText('50');
  await expect(applyButton(page)).toBeDisabled();
  expect(await seq(page)).toBe(start);

  // Criterion 4: the math gate rejects a definition; nothing is applied, the reason is shown and
  // the input is kept.
  await sourceField(page).fill('\\def\\a{b}');
  await applyButton(page).click();
  await expect(page.locator(`${DIALOG} .de-math-reason`)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`${DIALOG} .de-error`).first()).toContainText('did not accept');
  await expect(sourceField(page)).toHaveValue('\\def\\a{b}');
  await expect(page.locator(`${DIALOG}`)).toBeVisible();
  await expect(inline(page)).toHaveAttribute('data-latex', 'x^2');

  // Criterion 2 through the UI: the corrected source is one commit, and the dialog closes.
  const before2 = await seq(page);
  await sourceField(page).fill('x^2+1');
  await applyButton(page).click();
  await expect(page.locator(DIALOG)).toHaveCount(0, { timeout: 15_000 });
  await expect(inline(page)).toHaveAttribute('data-latex', 'x^2+1');
  expect(await seq(page)).toBe(before2 + 1);

  // Focus returns to the editing surface, the equation still selected.
  await expect(page.locator(`${EDITOR} .ProseMirror-selectednode`)).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        document.querySelector('doc-editor[data-test="math"]')!.shadowRoot!.activeElement
          ?.className ?? '',
    ),
  ).toContain('ProseMirror');

  // Criterion 6: Escape closes from the source field, and from inside the visual field.
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(`${EDITOR} .ProseMirror-selectednode`)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator(`${DIALOG} [data-state="ready"]`)).toBeVisible({ timeout: 15_000 });
  // The visual field is the tab stop before the source field; Escape inside it closes the dialog.
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator(`${DIALOG} math-field`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(`${EDITOR} .ProseMirror-selectednode`)).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        document.querySelector('doc-editor[data-test="math"]')!.shadowRoot!.activeElement
          ?.className ?? '',
    ),
  ).toContain('ProseMirror');
  expect(await seq(page)).toBe(before2 + 1);

  // Criterion 5: no policy violation, no page error.
  expect(
    await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test('FE-070: a viewer opens the equation read-only', async ({ page }) => {
  await open(page, 'viewer');
  // A read-only view takes no keyboard focus, so the double click is the way in here.
  await inline(page).dblclick();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(sourceField(page)).toHaveAttribute('readonly', '');
  await expect(sourceField(page)).toHaveValue('x^2');
  await expect(applyButton(page)).toHaveCount(0);
  await expect(page.locator(`${DIALOG} .de-error`)).toContainText('cannot change');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(inline(page)).toHaveAttribute('data-latex', 'x^2');
});
