/**
 * UX-046 criterion 6 in the real element: the review pane names the model and the person an
 * assistant's suggestion was written for. The history port here is a stand-in that answers the
 * agent and its registered name, as the route does for a commit made on an agent connection (the
 * route and the agent token are tested in the document service,
 * services/document-service/test/control-plane/ux-046-agent-token.test.ts). Run with
 * `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/ux-046-assistant-review.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'ux-046-assistant';
const HOST = `doc-editor[data-test="${NAME}"]`;
const TIME = '2026-11-12T10:30:00Z';

type Answer = Record<string, string>;

async function mount(page: Page, answer: Answer): Promise<void> {
  await page.evaluate(
    async ({ name, answer, time }) => {
      const w = window as unknown as {
        __embed: { backend(sub: string, role: string): unknown; docId: string };
      };
      const backend = w.__embed.backend('bob', 'suggester') as {
        features: ReadonlySet<string>;
        history?: unknown;
      };
      {
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
            return Promise.resolve({
              suggestion: id,
              time,
              user: 'bob',
              origin: 'assistant',
              seq: 2,
              ...answer,
            });
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
    { name: NAME, answer, time: TIME },
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

test.describe('the review pane names the model and the person (UX-046 criterion 6)', () => {
  test('an assistant suggestion shows the registered model and the person it acted for', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, { agent: 'agt_1', agentName: 'Model X' });
    await suggest(page);
    expect(await open(page)).toBe(true);
    const rows = page.locator(`${HOST} .de-pane[data-pane="review"] li[data-suggestion]`);
    await expect(rows).toHaveCount(2);
    for (const i of [0, 1]) {
      const line = rows.nth(i).locator('.de-review-assistant');
      await expect(line).toHaveAttribute('data-assistant', 'agt_1');
      await expect(line).toHaveText(/written by assistant Model X for .+/);
      await expect(rows.nth(i).locator('.de-review-head')).toHaveAccessibleName(
        /written by assistant Model X for/,
      );
    }
  });

  test('an agent whose name is no longer registered is shown as an assistant', async ({ page }) => {
    await openEmbed(page);
    await mount(page, { agent: 'agt_gone' });
    await suggest(page);
    expect(await open(page)).toBe(true);
    const rows = page.locator(`${HOST} .de-pane[data-pane="review"] li[data-suggestion]`);
    await expect(rows.first().locator('.de-review-assistant')).toHaveText(
      /written by an assistant for .+/,
    );
  });

  test('a suggestion a person made shows no assistant line', async ({ page }) => {
    await openEmbed(page);
    await mount(page, {});
    await suggest(page);
    expect(await open(page)).toBe(true);
    const rows = page.locator(`${HOST} .de-pane[data-pane="review"] li[data-suggestion]`);
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.de-review-head time')).toHaveAttribute('datetime', TIME);
    await expect(rows.locator('.de-review-assistant')).toHaveCount(0);
  });
});
