/**
 * FE-113 criterion 3 (lane V-FE-113-128): on a mobile browser, reading, scrolling, comments and
 * read-only mode work. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-113-mobile-browsers.spec.ts --project=chromium --project=webkit`.
 *
 * Emulation, not devices: the Chromium project uses Playwright's "Pixel 7" profile (Android Chrome
 * in emulation: touch, mobile flag, 412 by 915 CSS pixels) and the WebKit project uses "iPhone 13"
 * (iOS Safari's engine in emulation, 390 by 664 CSS pixels). Firefox and Edge are skipped: Playwright
 * has no mobile profile for Firefox, and Edge is Chromium. A real iPhone or Android phone is not used
 * here; the story's matrix allows emulation.
 *
 * Each test opens its own context with the profile, so the other specs' viewports are not changed.
 * Touch decisions come from the element (FE-113 criterion 2): on a touch profile the web view is
 * shown, and this spec checks that view.
 */
import { type Browser, type Page, devices, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const profiles = {
  chromium: devices['Pixel 7'],
  webkit: devices['iPhone 13'],
} as const;

type Profile = keyof typeof profiles;

/** Runs `body` on a fresh mobile-emulated page for the project's engine, then closes the context. */
async function withMobile(
  browser: Browser,
  engine: Profile,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ ...profiles[engine] });
  try {
    const page = await context.newPage();
    await openEmbed(page);
    await body(page);
  } finally {
    await context.close();
  }
}

/** The project's engine, or null when this file does not run there. */
function engineOf(projectName: string): Profile | null {
  if (projectName === 'chromium' || projectName === 'webkit') return projectName;
  return null;
}

const TEXT_IN_DOC = 'Alpha bravo charlie';

test.describe('FE-113 criterion 3: a mobile browser reads, scrolls, shows comments and is read-only', () => {
  test('reading: the document text is shown, with no sideways scroll on a phone profile', async ({
    browser,
  }, testInfo) => {
    const engine = engineOf(testInfo.project.name);
    test.skip(
      engine === null,
      'this file runs in Chromium (Android profile) and WebKit (iPhone profile)',
    );
    await withMobile(browser, engine!, async (page) => {
      await mountEditor(page, { name: 'one', sub: 'ada' });
      const surface = page.locator('doc-editor[data-test="one"] .de-editing-surface');
      await expect(surface).toBeVisible();
      await expect(surface).toContainText(TEXT_IN_DOC);
      const widths = await page.evaluate(() => ({
        viewport: window.innerWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(widths.page).toBeLessThanOrEqual(widths.viewport);
    });
  });

  test('read-only mode: mode="view" shows the text and refuses typing', async ({
    browser,
  }, testInfo) => {
    const engine = engineOf(testInfo.project.name);
    test.skip(
      engine === null,
      'this file runs in Chromium (Android profile) and WebKit (iPhone profile)',
    );
    await withMobile(browser, engine!, async (page) => {
      await mountEditor(page, { name: 'one', sub: 'ada', mode: 'view' });
      const surface = page.locator('doc-editor[data-test="one"] .de-editing-surface');
      await expect(surface).toContainText(TEXT_IN_DOC);
      await expect(surface).not.toHaveAttribute('contenteditable', 'true');
      const before = await surface.innerText();
      await surface.tap().catch(() => undefined);
      await page.keyboard.type('XYZ');
      expect(await surface.innerText()).toBe(before);
    });
  });

  test('comments: a thread by another user is listed, opened and answered by touch', async ({
    browser,
  }, testInfo) => {
    const engine = engineOf(testInfo.project.name);
    test.skip(
      engine === null,
      'this file runs in Chromium (Android profile) and WebKit (iPhone profile)',
    );
    await withMobile(browser, engine!, async (page) => {
      await mountEditor(page, { name: 'one', sub: 'ada' });
      const editor = page.locator('doc-editor[data-test="one"]');
      // Another user starts a thread on the first block, through the backend's comments port.
      await page.evaluate(async () => {
        const e = (window as unknown as { __embed: Record<string, unknown> })
          .__embed as unknown as {
          backend(
            sub: string,
            role: string,
          ): {
            connect(): Promise<void>;
            comments: {
              createThread(doc: string, body: unknown): Promise<unknown>;
            };
            sync: { loadContent(doc: string): Promise<{ doc: { content: unknown[] } }> };
          };
          docId: string;
        };
        const bob = e.backend('bob', 'editor');
        await bob.connect();
        const content = await bob.sync.loadContent(e.docId);
        const body = (
          content.doc.content as Array<{
            type: string;
            content?: Array<{ attrs?: { id?: string } }>;
          }>
        ).find((n) => n.type === 'body')!;
        const block = body.content![0]!.attrs!.id!;
        await bob.comments.createThread(e.docId, {
          target: { block },
          comment: { body: [{ type: 'text', text: 'Is this section final?' }] },
        });
      });
      // The pane lists it without a reload; the page does not scroll sideways with the pane open.
      await page.evaluate(() =>
        (
          document.querySelector('doc-editor[data-test="one"]') as unknown as {
            exec(command: string): unknown;
          }
        ).exec('view.comments'),
      );
      const row = editor.locator('.de-comment-row');
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('group').first()).toHaveAttribute(
        'aria-label',
        /bob, Open, 0 replies/,
      );
      await row.locator('[data-thread-open]').tap();
      const view = editor.locator('[data-thread-view]');
      await expect(view).toContainText('Is this section final?');
      // The reader answers with the on-screen keyboard's text, and the reply is in the thread.
      await view.locator('[data-reply-field]').fill('Yes, it is final.');
      await view.locator('[data-reply-post]').tap();
      await expect(view).toContainText('Yes, it is final.');
      const widths = await page.evaluate(() => ({
        viewport: window.innerWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(widths.page).toBeLessThanOrEqual(widths.viewport);
    });
  });
});
