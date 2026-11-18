/**
 * The assistant pane in the production element (UX-045; lane w3). A backend that carries an
 * assistant port makes the pane available; the author asks a question, the real core builds the
 * request from the document, the answer shows in the pane and the document text does not change.
 * A backend without the port has no pane. The port is a scripted fake: no provider is called.
 * Run with
 * `DOCEDIT_DEMO_PORT=57272 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-045-assistant-pane.spec.ts --project=<browser>`.
 */
import { type Page, expect, test } from '@playwright/test';
import { bodyText, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';
const PANE = `${EDITOR} .de-pane[data-pane="assistant"]`;

/** Mounts the element with the embed page's backend, with a scripted assistant port when asked. */
async function mount(page: Page, withPort: boolean): Promise<void> {
  await page.evaluate(async (port) => {
    const w = window as unknown as {
      __embed: { backend(sub: string, role: string): Record<string, unknown>; docId: string };
      __assistantRequests: unknown[];
    };
    w.__assistantRequests = [];
    const backend = w.__embed.backend('ada', 'editor');
    if (port)
      backend['assistant'] = {
        async *request(request: unknown) {
          w.__assistantRequests.push(request);
          yield { kind: 'text', text: 'Scripted ' };
          yield { kind: 'text', text: 'answer' };
          yield { kind: 'done', agent: 'agt-test' };
        },
      };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'one';
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = backend;
    el.setAttribute('doc-id', w.__embed.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, withPort);
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

/** Opens a pane through the element's shell, as the pane command does; resolves to whether it opened. */
function openPane(page: Page, id: string): Promise<boolean> {
  return page.evaluate(
    ({ sel, pane }) => {
      const embed = (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } | null };
          };
        }
      ).__embed;
      return embed.internals(document.querySelector(sel)!).editor!.openPane(pane);
    },
    { sel: EDITOR, pane: id },
  );
}

/** The suggestions the element's core lists, as kind and text. */
function suggestions(page: Page): Promise<Array<{ kind: string; text: string }>> {
  return page.evaluate((sel) => {
    const embed = (
      window as unknown as {
        __embed: {
          internals(el: Element): {
            editor: {
              core: { suggestionItems(): Array<{ kind: string; text: string }> };
            } | null;
          };
        };
      }
    ).__embed;
    return embed
      .internals(document.querySelector(sel)!)
      .editor!.core.suggestionItems()
      .map((s) => ({ kind: s.kind, text: s.text }));
  }, EDITOR);
}

test.describe('the assistant pane in the element (UX-045)', () => {
  test('a backend without an assistant port has no pane', async ({ page }) => {
    await openEmbed(page);
    await mount(page, false);
    expect(await openPane(page, 'assistant')).toBe(false);
    await expect(page.locator(PANE)).toHaveCount(0);
  });

  test('with a port the pane shows the answer, the request carries the document and the text is unchanged', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, true);
    const before = await bodyText(page);
    expect(await openPane(page, 'assistant')).toBe(true);
    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    await pane.getByRole('textbox').fill('What is this?');
    await pane.locator('[data-ask="question"]').click();
    await expect(pane.locator('[data-assistant-state="shown"]')).toHaveText('Scripted answer');
    const requests = await page.evaluate(
      () => (window as unknown as { __assistantRequests: unknown[] }).__assistantRequests,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ task: 'answer', prompt: 'What is this?' });
    expect((requests[0] as { docId: string }).docId).not.toBe('');
    expect(
      (requests[0] as { context: { blocks: unknown[] } }).context.blocks.length,
    ).toBeGreaterThan(0);
    expect(await bodyText(page)).toBe(before);
  });

  test('approving the answer puts it in the real document as an insertion suggestion, never as plain text (UX-046 criterion 1)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, true);
    expect(await openPane(page, 'assistant')).toBe(true);
    const pane = page.locator(PANE);
    await pane.getByRole('textbox').fill('Draft a line');
    await pane.locator('[data-ask="draft"]').click();
    await expect(pane.locator('[data-assistant-state="shown"]')).toHaveText('Scripted answer');
    const before = await suggestions(page);
    expect(before).toEqual([]);
    await pane.locator('[data-assistant-insert]').click();
    await expect(pane.locator('[data-assistant-state="inserted"]')).toBeVisible();
    const after = await suggestions(page);
    expect(after).toEqual([{ kind: 'ins', text: 'Scripted answer' }]);
  });
});
