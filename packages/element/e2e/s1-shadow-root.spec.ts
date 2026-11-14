/**
 * Spike S1 (SPK-014): ProseMirror inside the open shadow root of `<doc-editor>`. Typing, selection
 * and deletion; the element's lifecycle (02 §2.1); the schema rules of 03 §3 and §9 in the browser
 * (definitions not rendered or selectable, "select all" and movement limited to the body, null
 * identifiers filled, the first half of a split keeping the identifier).
 * Prepares FE-004, FE-005, FE-006, FE-013, FE-030, FE-031, FE-032, FE-066, FE-122.
 */
import { expect, test } from '@playwright/test';
import { SPIKE_IDS, openS1 } from './helpers.ts';

test.describe('element and shadow root', () => {
  test('attaches an open root without delegatesFocus and mounts the Svelte application', async ({
    page,
  }) => {
    await openS1(page);
    const root = await page.evaluate(() => {
      const el = document.querySelector('doc-editor')!;
      const r = el.shadowRoot!;
      return {
        mode: r.mode,
        delegatesFocus: r.delegatesFocus,
        shell: r.querySelectorAll('.de-shell').length,
        surfaces: r.querySelectorAll('.ProseMirror').length,
        // The view's DOM is inside this shadow root, not in the light DOM.
        viewInShadow: r.querySelector('.ProseMirror')?.getRootNode() === r,
        lightChildren: el.children.length,
      };
    });
    expect(root).toEqual({
      mode: 'open',
      delegatesFocus: false,
      shell: 1,
      surfaces: 1,
      viewInShadow: true,
      lightChildren: 0,
    });
    // Playwright's locators pierce the open root without extra configuration (FE-013, FE-122).
    await expect(page.locator('doc-editor .de-editing-surface h1')).toHaveText('Scope');
  });

  test('starts with the caret in the body and renders no definitions or stories', async ({
    page,
  }) => {
    const h = await openS1(page);
    const sel = await h.selection();
    expect(sel.inBody).toBe(true);
    expect(sel.parentType).toBe('paragraph');
    const hidden = await page.evaluate(() => {
      const r = document.querySelector('doc-editor')!.shadowRoot!;
      const defs = r.querySelector('.de-defs') as HTMLElement;
      const story = r.querySelector('.de-story') as HTMLElement;
      return {
        defsHidden: defs.hidden,
        defsChildren: defs.childNodes.length,
        defsEditable: defs.contentEditable,
        storyHidden: story.hidden,
        storyChildren: story.childNodes.length,
        headerTextShown: r
          .querySelector('.de-editing-surface')!
          .textContent!.includes('Header text'),
      };
    });
    expect(hidden).toEqual({
      defsHidden: true,
      defsChildren: 0,
      defsEditable: 'false',
      storyHidden: true,
      storyChildren: 0,
      headerTextShown: false,
    });
  });

  test('types, selects and deletes inside the shadow root', async ({ page }) => {
    const h = await openS1(page);
    await h.caretIn(SPIKE_IDS.after, 'end');
    await page.keyboard.type(' typed here');
    expect(await h.nodeText(SPIKE_IDS.after)).toBe('Remote target paragraph. typed here');
    await expect(page.locator('doc-editor .de-editing-surface')).toContainText(
      'paragraph. typed here',
    );

    // Keyboard selection, then typing over it. The caret reaches the line start with Home, as a
    // user's would, rather than being set there by script.
    await h.caretIn(SPIKE_IDS.after, 'end');
    await page.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    // ProseMirror reads native selection changes on `selectionchange`, which browsers dispatch
    // in a later task: wait for it.
    await expect.poll(() => h.selectedText()).toBe('Remote');
    await page.keyboard.type('Local');
    expect(await h.nodeText(SPIKE_IDS.after)).toBe('Local target paragraph. typed here');

    // Backspace and Delete.
    await h.caretIn(SPIKE_IDS.after, 'end');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
    expect(await h.nodeText(SPIKE_IDS.after)).toBe('Local target paragraph. typed');
    await h.caretIn(SPIKE_IDS.after, 'start');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Delete');
    expect(await h.nodeText(SPIKE_IDS.after)).toBe('target paragraph. typed');

    // Mouse selection: a double click selects a word in the model.
    await page
      .locator('doc-editor p:has-text("Last paragraph.")')
      .dblclick({ position: { x: 5, y: 5 } });
    await expect.poll(() => h.selectedText()).toMatch(/^Last\s?$/);

    // A selection across two paragraphs, deleted: the paragraphs join.
    await h.caretIn(SPIKE_IDS.after, 'end');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+End');
    await expect.poll(async () => (await h.selectedText()).endsWith('Last paragraph.')).toBe(true);
    await page.keyboard.press('Delete');
    expect(await h.nodeText(SPIKE_IDS.after)).toBe('target paragraph. typed');
    expect(await h.nodeText(SPIKE_IDS.last)).toBeNull();
    expect((await h.validate()).violations).toEqual([]);
  });

  test('moving the element in one task keeps the editor; disconnecting destroys it after the grace period', async ({
    page,
  }) => {
    await openS1(page, '?grace=300');
    const moved = await page.evaluate(async () => {
      const el = document.querySelector('doc-editor') as HTMLElement & {
        mounted: boolean;
        suspended: boolean;
        spike(): Promise<{ core: object }>;
      };
      const before = (await el.spike()).core;
      const other = document.createElement('div');
      document.body.append(other);
      other.append(el); // disconnect and reconnect in the same task
      await new Promise((r) => setTimeout(r, 50));
      const after = (await el.spike()).core;
      return { same: before === after, mounted: el.mounted, suspended: el.suspended };
    });
    expect(moved).toEqual({ same: true, mounted: true, suspended: false });

    const removed = await page.evaluate(async () => {
      const el = document.querySelector('doc-editor') as HTMLElement & {
        mounted: boolean;
        suspended: boolean;
      };
      el.remove();
      await new Promise((r) => setTimeout(r, 50));
      const suspended = el.suspended;
      await new Promise((r) => setTimeout(r, 500));
      return {
        suspended,
        mounted: el.mounted,
        shell: el.shadowRoot!.querySelectorAll('.de-shell').length,
      };
    });
    expect(removed).toEqual({ suspended: true, mounted: false, shell: 0 });
  });

  test('keep-alive keeps a disconnected editor suspended past the grace period', async ({
    page,
  }) => {
    await openS1(page, '?grace=200&keepalive');
    const state = await page.evaluate(async () => {
      const el = document.querySelector('doc-editor') as HTMLElement & {
        mounted: boolean;
        suspended: boolean;
      };
      el.remove();
      await new Promise((r) => setTimeout(r, 500));
      const during = { mounted: el.mounted, suspended: el.suspended };
      document.body.append(el);
      await new Promise((r) => setTimeout(r, 50));
      return { during, after: { mounted: el.mounted, suspended: el.suspended } };
    });
    expect(state).toEqual({
      during: { mounted: true, suspended: true },
      after: { mounted: true, suspended: false },
    });
  });
});

test.describe('schema rules in the browser (03 §3, §9)', () => {
  test('select all covers the body only; deleting it leaves definitions and stories unchanged', async ({
    page,
  }) => {
    const h = await openS1(page);
    const outside = await h.outsideBody();
    await h.caretIn(SPIKE_IDS.legal, 'end'); // inside the region
    await page.keyboard.press('ControlOrMeta+a');
    const sel = await h.selection();
    expect(sel.type).toBe('body');
    expect([sel.from, sel.to]).toEqual([sel.body.start, sel.body.end]);
    await page.keyboard.press('Delete');
    expect(await h.outsideBody()).toEqual(outside);
    expect(await h.bodyText()).toBe('');
    await page.keyboard.type('New body');
    expect(await h.bodyText()).toBe('New body');
    expect(await h.outsideBody()).toEqual(outside);
    expect((await h.validate()).violations).toEqual([]);
  });

  test('Ctrl+Home, Ctrl+End, arrows and Backspace never leave the body', async ({ page }) => {
    const h = await openS1(page);
    const outside = await h.outsideBody();
    await h.caretIn(SPIKE_IDS.after, 'start');
    await page.keyboard.press('ControlOrMeta+Home');
    let sel = await h.selection();
    expect(sel.inBody).toBe(true);
    expect(sel.from).toBe(sel.body.start + 1);
    for (const key of ['ArrowUp', 'ArrowLeft', 'Home', 'PageUp']) {
      await page.keyboard.press(key);
      sel = await h.selection();
      expect(sel.inBody, key).toBe(true);
    }
    await page.keyboard.press('Backspace');
    expect(await h.outsideBody()).toEqual(outside);
    expect(await h.nodeText(SPIKE_IDS.title)).toBe('Scope');
    await page.keyboard.type('X');
    expect(await h.nodeText(SPIKE_IDS.title)).toBe('XScope');

    await page.keyboard.press('ControlOrMeta+End');
    sel = await h.selection();
    expect(sel.to).toBe(sel.body.end - 1);
    for (const key of ['ArrowDown', 'ArrowRight', 'End', 'PageDown']) {
      await page.keyboard.press(key);
      sel = await h.selection();
      expect(sel.inBody, key).toBe(true);
    }
    await page.keyboard.press('Delete');
    expect(await h.outsideBody()).toEqual(outside);
  });

  test('a DOM selection on the hidden definition wrapper is clamped into the body', async ({
    page,
  }) => {
    const h = await openS1(page);
    await page.evaluate(() => {
      const r = document.querySelector('doc-editor')!.shadowRoot!;
      const surface = r.querySelector('.ProseMirror') as HTMLElement;
      surface.focus();
      // Offset 0 of the editing surface is before the hidden `defs` wrapper.
      document.getSelection()!.setBaseAndExtent(surface, 0, surface, 1);
    });
    await expect.poll(async () => (await h.selection()).inBody).toBe(true);
    await page.keyboard.type('Y');
    const outsideHasY = JSON.stringify(await h.outsideBody()).includes('"Y');
    expect(outsideHasY).toBe(false);
  });

  test('Enter fills identifiers: the first half of a split keeps its id, Enter at the start gives the new empty paragraph a fresh one', async ({
    page,
  }) => {
    const h = await openS1(page);
    await h.selectText('Remote target', 6); // after "Remote"
    await page.keyboard.press('Enter');
    await h.caretIn(SPIKE_IDS.last, 'start');
    await page.keyboard.press('Enter');
    const DEFINITIONS = new Set([
      'style_def',
      'numbering_def',
      'page_setup',
      'role_def',
      'rule_def',
    ]);
    const ids = (await h.ids()).filter((i) => !DEFINITIONS.has(i.type));
    expect(ids.every((i) => typeof i.id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(i.id))).toBe(
      true,
    );
    // 12 since CDM-001 chose `paragraph+` for footnotes: the footnote's paragraph has one too.
    expect(ids).toHaveLength(12);
    expect(new Set(ids.map((i) => i.id)).size).toBe(ids.length);
    expect(await h.nodeText(SPIKE_IDS.after)).toBe('Remote');
    expect(await h.nodeText(SPIKE_IDS.last)).toBe('Last paragraph.');
    expect((await h.validate()).violations).toEqual([]);
  });
});
