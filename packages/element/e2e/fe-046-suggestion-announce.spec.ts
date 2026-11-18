/**
 * FE-046 criterion 3 (lane w1): a suggestion that has the caret is announced as an insertion, a
 * deletion or a formatting change with its author. The shell gives each suggestion run the words
 * `Inserted by <name>` (`data-suggestion-label`, set through `setSuggestionLabel`), drawn out of sight
 * before the run (`element.css`).
 *
 * `bob` joins as a suggester, so what he types is recorded as an `ins` he authored; then he deletes a
 * word, which records a `del`. In every browser the words are the generated content of the run, as the
 * browser computes it. In Chromium the accessibility tree is read as well (the Chrome DevTools
 * Protocol, `Accessibility.getFullAXTree`): the `ins` element has the role `insertion`, the `del`
 * element the role `deletion`, and the words are text in the run's subtree, which is what a screen
 * reader is given. No screen reader is run.
 *
 * Run with `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/fe-046-suggestion-announce.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

/** The generated content of the run's `::before`, as the browser computes it. */
function wordsOf(page: Page, selector: string): Promise<string | null> {
  return page.evaluate(
    ({ sel, ed }) => {
      const root = document.querySelector(ed)!.shadowRoot!;
      const el = root.querySelector(sel);
      return el ? getComputedStyle(el, '::before').content : null;
    },
    { sel: selector, ed: editor },
  );
}

interface AxNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  childIds?: string[];
  ignored?: boolean;
  backendDOMNodeId?: number;
}

/** The text of the accessibility subtree under a node, children in order. */
function subtreeText(nodes: Map<string, AxNode>, id: string): string {
  const node = nodes.get(id);
  if (!node) return '';
  const own =
    node.role?.value === 'StaticText' || node.role?.value === 'InlineTextBox'
      ? (node.name?.value ?? '')
      : '';
  return own + (node.childIds ?? []).map((c) => subtreeText(nodes, c)).join('');
}

test.describe('FE-046 criterion 3: a suggestion is announced with its kind and author', () => {
  test('an insertion and a deletion carry their words, and in Chromium the roles and the words are in the accessibility tree', async ({
    page,
  }, info) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'bob', role: 'suggester' });
    // The host names the author, as a host does (`resolveUsers`, 13 §2).
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement & { resolveUsers: unknown };
      el.resolveUsers = async (ids: readonly string[]) =>
        ids.map((id) => ({ id, name: `Host name of ${id}` }));
    }, editor);

    const surface = page.locator(`${editor} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    // Delete the word before the caret: a baseline word, so it is recorded as a `del`; then type.
    await page.keyboard.press('Control+Backspace');
    await page.keyboard.type(' Typed');

    await expect(surface.locator('ins')).not.toHaveCount(0);
    await expect(surface.locator('del')).not.toHaveCount(0);

    // Every browser: the run has the kind and the author as generated content.
    const inserted = await wordsOf(page, '.de-editing-surface .de-suggest-ins');
    const deleted = await wordsOf(page, '.de-editing-surface .de-suggest-del');
    expect(inserted).toMatch(/Inserted by Host name of bob/);
    expect(deleted).toMatch(/Deleted by Host name of bob/);

    if (info.project.name !== 'chromium') return;

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] };
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const roleNodes = (role: string) => nodes.filter((n) => !n.ignored && n.role?.value === role);
    const insertions = roleNodes('insertion');
    const deletions = roleNodes('deletion');
    expect(insertions.length).toBeGreaterThan(0);
    expect(deletions.length).toBeGreaterThan(0);
    expect(insertions.map((n) => subtreeText(byId, n.nodeId)).join(' | ')).toMatch(
      /Inserted by Host name of bob/,
    );
    expect(deletions.map((n) => subtreeText(byId, n.nodeId)).join(' | ')).toMatch(
      /Deleted by Host name of bob/,
    );
  });
});
