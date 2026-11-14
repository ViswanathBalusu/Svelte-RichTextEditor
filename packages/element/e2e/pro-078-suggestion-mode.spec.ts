/**
 * PRO-078 criteria 1 and 3 (lane V-PRO-069-085): `mode="review"` with `edit` turns suggestion mode on,
 * and typing then records suggestions naming the editor; a user who has `suggest` but not `edit` in
 * the scope keeps suggestion mode on in an editing mode, whatever the host asks for.
 *
 * The embed page with the in-memory backend (`pages/embed.html`). Typing uses the page keyboard, so it
 * runs in every browser. Run with `DOCEDIT_DEMO_PORT=57130 pnpm exec playwright test -c
 * packages/element/playwright.config.ts packages/element/e2e/pro-078-suggestion-mode.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { SPIKE_IDS } from '@docedit/engine/spike-document';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;

interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}
interface Node {
  type?: string;
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
  content?: Node[];
}

/** The text of the runs marked `ins` inside a node, with the suggester named on each run. */
function insRuns(node: Node, out: Array<{ text: string; user: unknown }> = []) {
  if (node.type === 'text' && node.text) {
    const ins = (node.marks ?? []).find((m) => m.type === 'ins');
    if (ins) out.push({ text: node.text, user: ins.attrs?.['user'] });
    return out;
  }
  for (const child of node.content ?? []) insRuns(child, out);
  return out;
}

function findNode(node: Node, id: string): Node | null {
  if (node.attrs?.['id'] === id) return node;
  for (const child of node.content ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

interface SuggestionInfo {
  on: boolean;
  locked: boolean;
  reason: string | null;
}

/** The core's suggestion-mode state at the selection (FE-041). */
function suggestionState(page: Page, name = 'one'): Promise<SuggestionInfo> {
  return page.evaluate((sel) => {
    const e = (
      window as unknown as {
        __embed: {
          internals(el: Element): {
            editor: { core: { suggestion: { get(): SuggestionInfo } } } | null;
          };
        };
      }
    ).__embed;
    return e.internals(document.querySelector(sel)!).editor!.core.suggestion.get();
  }, editor(name));
}

/** Puts the caret at the end of the spike paragraph and focuses the editing surface. */
async function caretAtEnd(page: Page, name = 'one'): Promise<void> {
  await page.evaluate(
    async ({ sel, node }) => {
      const el = document.querySelector(sel)!;
      const h = await (
        window as unknown as {
          __embed: { harness(el: Element): Promise<{ caretIn(id: string, at: 'end'): void }> };
        }
      ).__embed.harness(el);
      h.caretIn(node, 'end');
    },
    { sel: editor(name), node: SPIKE_IDS.last },
  );
  await page.locator(`${editor(name)} .de-editing-surface`).focus();
}

/** The local document of the editor, as the harness reads it. */
function localDoc(page: Page, name = 'one'): Promise<Node> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector(sel)!;
    const h = await (
      window as unknown as { __embed: { harness(el: Element): Promise<{ doc(): unknown }> } }
    ).__embed.harness(el);
    return h.doc();
  }, editor(name)) as Promise<Node>;
}

test.describe('PRO-078 suggestion mode', () => {
  test('criterion 1: mode="review" with edit turns suggestion mode on, and typing records suggestions by the editor', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', role: 'editor', mode: 'review' });

    await expect.poll(async () => (await suggestionState(page)).on).toBe(true);
    expect((await suggestionState(page)).locked).toBe(false);

    await caretAtEnd(page);
    const typed = 'PRO078';
    await page.keyboard.type(typed);

    await expect
      .poll(async () => {
        const doc = await localDoc(page);
        const paragraph = findNode(doc, SPIKE_IDS.last);
        return paragraph
          ? insRuns(paragraph)
              .map((r) => r.text)
              .join('')
          : '';
      })
      .toContain(typed);
    const doc = await localDoc(page);
    const runs = insRuns(findNode(doc, SPIKE_IDS.last)!);
    expect(runs.every((r) => r.user === 'ada')).toBe(true);
  });

  test('criterion 3: a suggest-only user keeps suggestion mode on in every editing mode', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'bob', role: 'suggester', mode: 'edit' });

    await expect.poll(async () => (await suggestionState(page)).on).toBe(true);
    expect(await suggestionState(page)).toMatchObject({ on: true, locked: true, reason: 'rights' });

    // The mode control offers `edit` disabled, so the user cannot choose it.
    await page.locator(`${editor()} .de-mode-button`).click();
    const edit = page.locator(`${editor()} [role="menuitemradio"][data-command-id="mode.edit"]`);
    await expect(edit).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    // The host asks for each editing mode in turn; suggestion mode stays on, scoped to the body.
    // `fill` is left out: its behaviour is FRW-007, which is not built (PRO-077 criterion 4).
    for (const mode of ['edit', 'review']) {
      await page.evaluate(([sel, m]) => document.querySelector(sel)!.setAttribute('mode', m), [
        editor(),
        mode,
      ] as const);
      await expect
        .poll(async () => (await suggestionState(page)).on, { message: `after mode=${mode}` })
        .toBe(true);
      expect(await suggestionState(page), `after mode=${mode}`).toMatchObject({
        on: true,
        reason: 'rights',
      });
    }
  });
});
