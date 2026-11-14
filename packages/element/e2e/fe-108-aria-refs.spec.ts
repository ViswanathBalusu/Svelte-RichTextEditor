/**
 * ARIA references stay inside the element's shadow root (FE-108 criteria 1 and 3; lane
 * U-FE-097-112). In a real browser on the embed page, every `aria-labelledby`, `aria-describedby`,
 * `aria-controls`, `aria-owns`, `aria-activedescendant` and `for` reference in the element's shadow
 * root must resolve to an element of that same root. The states checked are the ones this test
 * reaches (the default editor, and the editor with the toolbar and the status bar on); the references
 * of states it does not reach are not checked.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fe-108-aria-refs.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

interface Ref {
  attr: string;
  owner: string;
  id: string;
  resolvedInRoot: boolean;
  resolvedInDocument: boolean;
}

/** Every reference from an element of the editor's shadow root, and where its target resolves. */
function collectRefs(page: Page): Promise<Ref[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    const attrs = [
      'aria-labelledby',
      'aria-describedby',
      'aria-controls',
      'aria-owns',
      'aria-activedescendant',
    ];
    const out: Array<{
      attr: string;
      owner: string;
      id: string;
      resolvedInRoot: boolean;
      resolvedInDocument: boolean;
    }> = [];
    const add = (attr: string, el: Element, id: string) => {
      out.push({
        attr,
        owner: `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`,
        id,
        resolvedInRoot: root.getElementById(id) !== null,
        resolvedInDocument: document.getElementById(id) !== null,
      });
    };
    for (const el of root.querySelectorAll('*')) {
      for (const attr of attrs) {
        const value = el.getAttribute(attr);
        if (value === null) continue;
        for (const id of value.split(/\s+/).filter(Boolean)) add(attr, el, id);
      }
      if (el.tagName === 'LABEL' && el.hasAttribute('for')) add('for', el, el.getAttribute('for')!);
    }
    return out;
  }, editor);
}

test.describe('ARIA references resolve in the shadow root (FE-108)', () => {
  test('every reference of the default editor resolves to its own root', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const refs = await collectRefs(page);
    test.info().annotations.push({ type: 'refs', description: String(refs.length) });
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !r.resolvedInRoot)).toEqual([]);
  });

  test('every reference of the editor with the toolbar and the status bar resolves in its root', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { toolbar: 'full' } });
    const refs = await collectRefs(page);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !r.resolvedInRoot)).toEqual([]);
    // Recorded for the report: how many references the reached states hold.
    test.info().annotations.push({ type: 'refs', description: String(refs.length) });
  });
});
