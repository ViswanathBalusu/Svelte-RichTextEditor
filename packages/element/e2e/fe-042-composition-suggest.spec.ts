/**
 * FE-042 criterion 6, input-method composition (lane U-FE-033-048): in suggestion mode, a
 * composition that completes inserts its text once, and the inserted text carries an `ins` mark
 * naming the suggester. Chromium only: the DevTools protocol drives the composition
 * (`Input.imeSetComposition` for each update, `Input.insertText` to commit), as in
 * e2e/s1-composition.spec.ts. Ada is an editor in review mode, so her typing is recorded as
 * suggestions in the editor's local document.
 *
 * Run with `pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/fe-042-composition-suggest.spec.ts --project=chromium --workers=1`.
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS } from '@docedit/engine/spike-document';
import { mountEditor, openEmbed } from './embed-helpers.ts';

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'The DevTools protocol exists only in Chromium and Edge',
);

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

/** The text of a node's children, with each run marked `ins` by a suggester, in document order. */
function insRuns(node: Node, inside = false, out: Array<{ text: string; user: unknown }> = []) {
  if (node.type === 'text' && node.text) {
    const ins = (node.marks ?? []).find((m) => m.type === 'ins');
    if (ins && inside) out.push({ text: node.text, user: ins.attrs?.['user'] });
    return out;
  }
  for (const child of node.content ?? []) insRuns(child, inside, out);
  return out;
}

/** Finds the paragraph with `id` in a document and returns it. */
function findNode(node: Node, id: string): Node | null {
  if (node.attrs?.['id'] === id) return node;
  for (const child of node.content ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

test('FE-042 criterion 6: a composition in suggestion mode inserts once, with an ins mark naming the suggester', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { name: 'one', sub: 'ada', mode: 'review' });
  const id = SPIKE_IDS.last;
  const before = await page.evaluate(async (node) => {
    const el = document.querySelector('doc-editor[data-test="one"]')!;
    const h = await (
      window as unknown as {
        __embed: {
          harness(el: Element): Promise<{
            caretIn(id: string, at: 'end'): void;
            nodeText(id: string): string | null;
          }>;
        };
      }
    ).__embed.harness(el);
    h.caretIn(node, 'end');
    return h.nodeText(node);
  }, id);
  expect(before).not.toBeNull();

  const cdp = await page.context().newCDPSession(page);
  const committed = 'かな';
  for (const steps of [['か'], ['かな']]) {
    await cdp.send('Input.imeSetComposition', {
      text: steps[0]!,
      selectionStart: steps[0]!.length,
      selectionEnd: steps[0]!.length,
    });
  }
  await cdp.send('Input.insertText', { text: committed });

  // The text appears once, after the text before the caret.
  await expect
    .poll(() =>
      page.evaluate(async (node) => {
        const el = document.querySelector('doc-editor[data-test="one"]')!;
        const h = await (
          window as unknown as {
            __embed: { harness(el: Element): Promise<{ nodeText(id: string): string | null }> };
          }
        ).__embed.harness(el);
        return h.nodeText(node);
      }, id),
    )
    .toBe(`${before}${committed}`);

  // The local document: the committed text carries one `ins` mark, naming the suggester.
  const doc = await page.evaluate(async () => {
    const el = document.querySelector('doc-editor[data-test="one"]')!;
    const h = await (
      window as unknown as {
        __embed: { harness(el: Element): Promise<{ doc(): unknown }> };
      }
    ).__embed.harness(el);
    return h.doc();
  });
  const paragraph = findNode(doc as Node, id);
  expect(paragraph, 'the paragraph in the local document').not.toBeNull();
  const runs = insRuns(paragraph!, true);
  const insText = runs.map((r) => r.text).join('');
  expect(insText, 'the inserted text, once').toBe(committed);
  expect(new Set(runs.map((r) => r.user)).size, 'one suggester').toBe(1);
  expect(runs[0]?.user).toBe('ada');
});
