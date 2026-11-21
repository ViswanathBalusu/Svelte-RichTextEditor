/**
 * FE-032 criterion 5 (02 §5.2; 07 §7; owner decision 4 of 2026-11-15): Select all selects the whole
 * body, also when the caret is inside a region. 07 §7 clamps a selection that starts inside a region
 * to the region; Select all is not such a selection.
 *
 * The real element on the embed page (`pages/embed.html`), with the keyboard:
 * - a person who may change the region, a person who may only read it, and a viewer;
 * - a region that is the last block of the body, and an open region in the middle of it;
 * - the same command through the element's `exec`, and in the page view through its input bridge;
 * - what the selection then holds, read through the public `getSelectionContent()`.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-032-select-all-region.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';
import { SPIKE_IDS } from './helpers.ts';

interface Selected {
  type: string;
  from: number;
  to: number;
  body: { start: number; end: number };
}

interface Harness {
  caretIn(id: string, at: 'start' | 'end'): void;
  selection(): Selected;
}

interface Hooks {
  harness(el: Element): Promise<Harness>;
}

const editor = (name: string) => `doc-editor[data-test="${name}"]`;

/** Puts the caret at the end of the block `id` and gives the editing surface the focus. */
async function caretIn(page: Page, name: string, id: string): Promise<void> {
  await page.evaluate(
    async ({ sel, id }) => {
      const e = (window as unknown as { __embed: Hooks }).__embed;
      (await e.harness(document.querySelector(sel)!)).caretIn(id, 'end');
    },
    { sel: editor(name), id },
  );
}

function selection(page: Page, name: string): Promise<Selected> {
  return page.evaluate(async (sel) => {
    const e = (window as unknown as { __embed: Hooks }).__embed;
    return (await e.harness(document.querySelector(sel)!)).selection();
  }, editor(name));
}

/** The text of the selection, as a host reads it: the fragment of the public API, flattened. */
function selectedText(page: Page, name: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as unknown as { getSelectionContent(): unknown };
    const parts: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const node = n as { text?: unknown; content?: unknown[] };
      if (typeof node.text === 'string') parts.push(node.text);
      node.content?.forEach(walk);
    };
    walk(el.getSelectionContent());
    return parts.join('|');
  }, editor(name));
}

/** The whole body is selected: from its first position to its last, as one body selection. */
async function expectWholeBody(page: Page, name: string): Promise<void> {
  const sel = await selection(page, name);
  expect(sel.type).toBe('body');
  expect([sel.from, sel.to]).toEqual([sel.body.start, sel.body.end]);
}

test.describe('FE-032 criterion 5: Select all from inside a region selects the whole body', () => {
  test('for a person who may change the region: the body, not the region', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await caretIn(page, 'one', SPIKE_IDS.legal);
    // Not vacuous: the caret is inside the region before the command.
    const before = await selection(page, 'one');
    expect(before.type).toBe('text');
    await page.keyboard.press('ControlOrMeta+a');
    await expectWholeBody(page, 'one');
    // What is selected holds the text before the region, the region's and the text after it.
    const text = await selectedText(page, 'one');
    expect(text).toContain('Scope');
    expect(text).toContain('Liability is limited to ');
    expect(text).toContain('Last paragraph.');
    // The hook that clamps a selection to its region leaves this one alone: after a key that
    // changes nothing, which makes the editor look at the browser's selection again, the selection
    // is still the whole body.
    await page.keyboard.press('Shift');
    await expectWholeBody(page, 'one');
  });

  test('for a person who may only read the region, and for a viewer: the body as well', async ({
    page,
  }) => {
    await openEmbed(page);
    // Bob is an editor without the grant on the restricted region; Vic may only read the document.
    await mountEditor(page, { name: 'bob', sub: 'bob' });
    await caretIn(page, 'bob', SPIKE_IDS.legal);
    await page.keyboard.press('ControlOrMeta+a');
    await expectWholeBody(page, 'bob');
    expect(await selectedText(page, 'bob')).toContain('Last paragraph.');

    // A viewer's surface is not editable and takes no keyboard focus, so the command reaches it
    // from the shell or the host, not from a key.
    await mountEditor(page, { name: 'vic', sub: 'vic', role: 'viewer', target: 'mount-2' });
    await caretIn(page, 'vic', SPIKE_IDS.legal);
    const outcome = await page.evaluate(
      (sel) =>
        (
          document.querySelector(sel) as unknown as {
            exec(name: string): { ok: boolean; reason?: string };
          }
        ).exec('edit.selectAll'),
      editor('vic'),
    );
    expect(outcome).toMatchObject({ ok: true });
    await expectWholeBody(page, 'vic');
  });

  test('from a region that ends the body, and from an open region in the middle of it', async ({
    page,
  }) => {
    await openEmbed(page);
    // demo/embed-page.ts `regionDocument`: an open region in the middle of the body and one as its
    // last block but for the paragraph that always follows a region.
    await mountEditor(page, { name: 'one', sub: 'ada', doc: 'regions' });
    for (const inside of ['pRegionFirst0001', 'pRegionLast00001', 'pEndText00000001']) {
      await caretIn(page, 'one', inside);
      expect((await selection(page, 'one')).type, inside).toBe('text');
      await page.keyboard.press('ControlOrMeta+a');
      await expectWholeBody(page, 'one');
      const text = await selectedText(page, 'one');
      expect(text, inside).toContain('Before region.');
      expect(text, inside).toContain('End region text.');
    }
  });

  test('through the element’s exec, by the registry’s name and by the core’s', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    for (const command of ['selectAll', 'edit.selectAll']) {
      await caretIn(page, 'one', SPIKE_IDS.legal);
      const outcome = await page.evaluate(
        ({ sel, command }) =>
          (
            document.querySelector(sel) as unknown as {
              exec(name: string): { ok: boolean; reason?: string };
            }
          ).exec(command),
        { sel: editor('one'), command },
      );
      expect(outcome, command).toMatchObject({ ok: true });
      await expectWholeBody(page, 'one');
    }
  });

  test('in the page view, through its input bridge', async ({ page }, info) => {
    // Firefox is not offered the page view (kernel-fallback.ts); the web view is shown there.
    test.skip(info.project.name === 'firefox', 'the page view is not offered in Firefox');
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { view: 'print' } });
    await expect(page.locator(`${editor('one')} .de-page-view .de-page`).first()).toBeVisible();
    await caretIn(page, 'one', SPIKE_IDS.legal);
    const bridge = page.locator(`${editor('one')} .de-page-bridge`);
    await bridge.focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expectWholeBody(page, 'one');
  });
});
