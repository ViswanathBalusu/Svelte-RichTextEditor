/**
 * FE-046 criterion 2 in the real element: a suggestion's author and time are available on hover and
 * when the caret is in it. The author is named through the host's `resolveUsers`; the time is the
 * server time of the commit that introduced the suggestion, read through the history port
 * (`GET /documents/{id}/suggestions/{sid}/introduction`, HIS-042; decision 109 of
 * `docs/owner-decisions-2026-11-15.md`). The port here is a stand-in that answers a fixed time.
 *
 * `bob` joins as a suggester: what he types is recorded as an insertion he authored, and a word he
 * deletes as a deletion. Escape dismisses the card (WCAG 1.4.13). Run with
 * `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/fe-046-suggestion-card.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'fe-046-card';
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
        (window as unknown as { __cardAsked: string[] }).__cardAsked = [];
        backend.history = {
          suggestionIntroduction: (docId: string, id: string) => {
            (window as unknown as { __cardAsked: string[] }).__cardAsked.push(id);
            return Promise.resolve({ suggestion: id, time, user: 'bob', origin: 'client', seq: 2 });
          },
        };
      }
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        resolveUsers: unknown;
      };
      el.dataset['test'] = name;
      el.resolveUsers = async (ids: readonly string[]) =>
        ids.map((id) => ({ id, name: `Host name of ${id}` }));
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

/** Bob deletes a word and types: a deletion and an insertion he authored. */
async function suggest(page: Page): Promise<void> {
  const surface = page.locator(`${HOST} .de-editing-surface`);
  await surface.locator('p', { hasText: 'Last paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Backspace');
  await page.keyboard.type(' Typed');
  await expect(surface.locator('ins')).not.toHaveCount(0);
  await expect(surface.locator('del')).not.toHaveCount(0);
}

const card = (page: Page) => page.locator(`${HOST} .de-suggestion-card`);

test.describe('FE-046 criterion 2: the author and the time of a suggestion', () => {
  test('the card shows on hover and at the caret, with the name and the server time, and Escape dismisses it', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, true);
    await suggest(page);

    // The caret is at the end of Bob's insertion: the keyboard reader has the card.
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveText(/^Host name of bob, .*2026/);
    // The card is a status region, so a screen reader is given the words when they appear.
    await expect(card(page)).toHaveAttribute('role', 'status');
    expect(
      await page.evaluate(() => (window as unknown as { __cardAsked: string[] }).__cardAsked),
    ).not.toHaveLength(0);

    // Escape dismisses it; the caret has not moved.
    await page.keyboard.press('Escape');
    await expect(card(page)).toBeHidden();

    // The pointer over the deletion shows the card for that suggestion, and leaving hides it.
    await page.locator(`${HOST} .de-editing-surface del`).first().hover();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveText(/^Host name of bob, .*2026/);
    await page.mouse.move(2, 2);
    await expect(card(page)).toBeHidden();
  });

  test('without a history port the card names the author alone', async ({ page }) => {
    await openEmbed(page);
    await mount(page, false);
    await suggest(page);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveText('Host name of bob');
  });
});
