/**
 * UX-037 criterion 1 in the real element: the review pane lists each suggestion with the server
 * time of the commit that introduced it, read through the history port (`GET
 * /documents/{id}/suggestions/{sid}/introduction`, HIS-042; decision 109 of
 * `docs/owner-decisions-2026-11-15.md`). The port here is a stand-in that answers a fixed time and
 * counts its calls; the route itself is tested in the document service (HIS-042). Without a history
 * port the row shows no time. Run with `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c
 * packages/element/playwright.config.ts packages/element/e2e/ux-037-review-time.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'ux-037-time';
const HOST = `doc-editor[data-test="${NAME}"]`;
const TIME = '2026-11-12T10:30:00Z';

async function mount(page: Page, withHistory: boolean): Promise<void> {
  await page.evaluate(
    async ({ name, withHistory, time }) => {
      const w = window as unknown as {
        __embed: { backend(sub: string, role: string): unknown; docId: string };
      };
      const backend = w.__embed.backend('bob', 'suggester') as {
        features: ReadonlySet<string>;
        history?: unknown;
      };
      if (withHistory) {
        let features: ReadonlySet<string> = backend.features;
        Object.defineProperty(backend, 'features', {
          configurable: true,
          get: () => new Set([...features, 'history']),
          set: (v: ReadonlySet<string>) => {
            features = v;
          },
        });
        (window as unknown as { __asked: string[] }).__asked = [];
        backend.history = {
          suggestionIntroduction: (_doc: string, id: string) => {
            (window as unknown as { __asked: string[] }).__asked.push(id);
            return Promise.resolve({ suggestion: id, time, user: 'bob', origin: 'client', seq: 2 });
          },
        };
      }
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      const ready = new Promise<void>((resolve) =>
        el.addEventListener('de-ready', () => resolve(), { once: true }),
      );
      el.backend = backend;
      el.setAttribute('doc-id', w.__embed.docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { name: NAME, withHistory, time: TIME },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

/** Bob, a suggester, types in two paragraphs: two insertions he authored. */
async function suggest(page: Page): Promise<void> {
  const surface = page.locator(`${HOST} .de-editing-surface`);
  await surface.locator('p', { hasText: 'Last paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('ZZ');
  await surface.locator('p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('QQ');
  await expect(surface.locator('.de-suggest-ins')).toHaveCount(2);
}

const open = (page: Page) =>
  page.evaluate(
    (sel) =>
      (document.querySelector(sel) as unknown as { exec(c: string): { ok: boolean } }).exec(
        'view.review',
      ).ok,
    HOST,
  );

test.describe('the review pane shows when a suggestion was made (UX-037 criterion 1)', () => {
  test('each row has the server time of the introducing commit, asked once for each suggestion', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, true);
    await suggest(page);
    expect(await open(page)).toBe(true);
    const rows = page.locator(`${HOST} .de-pane[data-pane="review"] li[data-suggestion]`);
    await expect(rows).toHaveCount(2);
    // The time arrives after the list is drawn: the pane reads the list again when it does.
    for (const i of [0, 1]) {
      const time = rows.nth(i).locator('.de-review-head time');
      await expect(time).toHaveAttribute('datetime', TIME);
      await expect(time).toHaveText(/2026/);
      // Kind, author, time and words are in the row's accessible name (criterion 5).
      await expect(rows.nth(i).locator('.de-review-head')).toHaveAccessibleName(/Insertion by .+/);
    }
    // Document order, with the excerpts.
    await expect(rows.nth(0).locator('.de-review-excerpt')).toHaveText('QQ');
    await expect(rows.nth(1).locator('.de-review-excerpt')).toHaveText('ZZ');
    const asked = await page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);
    expect(new Set(asked).size).toBe(2);
    // Once known, a time is not asked again when the list is read again.
    const count = asked.length;
    await page.locator(`${HOST} .de-editing-surface`).locator('p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    await expect(rows.nth(0).locator('.de-review-excerpt')).toHaveText('QQX');
    const after = await page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);
    expect(after.slice(0, count)).toEqual(asked);
    expect(new Set(after).size).toBe(2);
  });

  test('without a history port the row shows no time', async ({ page }) => {
    await openEmbed(page);
    await mount(page, false);
    await suggest(page);
    expect(await open(page)).toBe(true);
    const rows = page.locator(`${HOST} .de-pane[data-pane="review"] li[data-suggestion]`);
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('.de-review-head time')).toHaveCount(0);
  });
});
