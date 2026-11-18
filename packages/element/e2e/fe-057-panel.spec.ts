/**
 * FE-057 in a real browser, through the element's own shell: the header and footer panel offers the
 * variants the page setup uses (criterion 1), opens the story each names and creates the story a
 * variant has none of (criterion 2); it is operated by keyboard with an accessible name and a
 * visible focus, and focus returns to the body on close (criterion 4); a remote edit of the open
 * story appears in the panel (criterion 5).
 *
 * Run with `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-057-panel.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { SPIKE_IDS, harness, openS1 } from './helpers.ts';

interface Panel {
  kind: string;
  id: string;
  part?: string;
  variant?: string | null;
}

/** The spike's page setup `ps1` uses the first-page variant from here on (the core's own command). */
async function useFirstPage(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    const core = (window as unknown as { h: { core: { run(n: string, a: unknown): boolean } } }).h
      .core;
    return core.run('setPageSetup', {
      pageSetup: { id: 'ps1', changes: { differentFirstPage: true } },
    });
  });
  expect(ok).toBe(true);
}

const panelOf = (page: Page): Promise<Panel | null> =>
  page.evaluate(() =>
    (window as unknown as { h: { core: { panel: { get(): Panel | null } } } }).h.core.panel.get(),
  );

const surfaceName = (page: Page): Promise<string | null> =>
  page.locator('doc-editor .de-sub-editor').getAttribute('aria-label');

async function openHeaderPanel(page: Page): Promise<void> {
  // The command the toolbar's Edit header button runs; the button can sit in the overflow menu.
  expect(await harness(page).openHeader()).toBe(true);
  await page.locator('doc-editor .de-panel-variants').waitFor();
}

const variantButtons = (page: Page) => page.locator('doc-editor .de-panel-variants button');

test.describe('the header and footer panel (FE-057)', () => {
  test('offers the variants of the page setup, and opens the story each names', async ({
    page,
  }) => {
    const h = await openS1(page, '?model=paragraph');
    await useFirstPage(page);
    await openHeaderPanel(page);

    // The parts, then the variants the page setup uses for the open part.
    await expect(variantButtons(page)).toHaveText(['Header', 'Footer', 'Every page', 'First page']);
    await expect(variantButtons(page).nth(2)).toHaveAttribute('aria-pressed', 'true');
    expect((await panelOf(page))?.id).toBe(SPIKE_IDS.header);
    expect(await surfaceName(page)).toBe('Header');

    // The first-page header is its own story; the panel shows it and typing goes into it.
    await variantButtons(page).nth(3).click();
    await expect.poll(async () => (await panelOf(page))?.variant).toBe('first');
    const first = await panelOf(page);
    expect(first?.part).toBe('header');
    expect(first?.id).not.toBe(SPIKE_IDS.header);
    await expect(variantButtons(page).nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => h.subMounted()).toBe(true);
    await page.locator('doc-editor .de-sub-editor').click();
    await page.keyboard.type('First');
    await expect.poll(() => h.subText()).toBe('First');
    expect(await h.nodeText(SPIKE_IDS.header)).toBe('Header text 1');
    expect((await h.validate()).violations).toEqual([]);
  });

  test('creates the footer of a variant that has none, and names it in the panel', async ({
    page,
  }) => {
    const h = await openS1(page, '?model=paragraph');
    await openHeaderPanel(page);
    const footers = () =>
      page.evaluate(
        () =>
          (
            window as unknown as { h: { doc(): { content: Array<{ attrs?: { kind?: string } }> } } }
          ).h
            .doc()
            .content.filter((n) => n.attrs?.kind === 'footer').length,
      );
    // The spike document has a header and no footer.
    expect(await footers()).toBe(0);
    await variantButtons(page).nth(1).click();
    await expect.poll(async () => (await panelOf(page))?.part).toBe('footer');
    const panel = await panelOf(page);
    expect(panel?.variant).toBe('default');
    // The story was created when the user chose to edit it, and the page setup names it.
    expect(await footers()).toBe(1);
    expect(await surfaceName(page)).toBe('Footer');
    await expect(page.locator('doc-editor .de-panel-head span')).toHaveText('Footer');
    await expect.poll(() => h.subMounted()).toBe(true);
    await page.keyboard.type('Page footer');
    await expect.poll(() => h.subText()).toBe('Page footer');
    expect((await h.validate()).violations).toEqual([]);
  });

  test('is operated by keyboard, shows its focus, and gives focus back to the body on close', async ({
    page,
  }) => {
    const h = await openS1(page, '?model=paragraph');
    await useFirstPage(page);
    await openHeaderPanel(page);
    await expect.poll(() => h.subMounted()).toBe(true);

    // The sub-editor has focus; its focus ring is drawn (a visible outline, not removed).
    const ring = () =>
      page.evaluate(() => {
        const el = document.querySelector('doc-editor')!.shadowRoot!.activeElement!;
        const s = getComputedStyle(el);
        return {
          cls: el.className,
          style: s.outlineStyle,
          width: parseFloat(s.outlineWidth),
        };
      });
    await page.keyboard.press('Shift+Tab');
    // Shift+Tab from the editing surface reaches the last variant button.
    await expect(page.locator('doc-editor .de-panel-variants button').last()).toBeFocused();
    const onButton = await ring();
    expect(onButton.style).not.toBe('none');
    expect(onButton.width).toBeGreaterThan(0);

    // Enter on a variant button opens that variant; no pointer is used.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await panelOf(page))?.variant).toBe('default');
    await variantButtons(page).last().focus();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await panelOf(page))?.variant).toBe('first');

    // Choosing a variant moves focus into its editing surface, which shows its own focus ring.
    await expect(page.locator('doc-editor .de-sub-editor')).toBeFocused();
    const onEditor = await ring();
    expect(onEditor.cls).toContain('de-sub-editor');
    expect(onEditor.style).not.toBe('none');
    expect(onEditor.width).toBeGreaterThan(0);

    // The Close button, reached and pressed by keyboard, returns focus to the body.
    await page.locator('doc-editor .de-panel-head button').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('doc-editor .de-panel')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector('doc-editor')!
            .shadowRoot!.querySelector('.de-editing-surface')!
            .contains(document.querySelector('doc-editor')!.shadowRoot!.activeElement),
        ),
      )
      .toBe(true);
  });

  test('shows a remote edit of the open header, and of the open first-page header', async ({
    page,
  }) => {
    const h = await openS1(page, '?model=paragraph');
    await useFirstPage(page);
    await openHeaderPanel(page);
    await expect.poll(() => h.subMounted()).toBe(true);

    await h.remoteInsert({ node: SPIKE_IDS.header, at: 'end', text: ' by Bob', mode: 'map' });
    await expect.poll(() => h.subText()).toBe('Header text 1 by Bob');
    await expect(page.locator('doc-editor .de-sub-editor')).toContainText('by Bob');

    await variantButtons(page).last().click();
    await expect.poll(async () => (await panelOf(page))?.variant).toBe('first');
    const id = (await panelOf(page))!.id;
    // The new story's editing surface is mounted and has taken focus.
    await expect(page.locator('doc-editor .de-sub-editor')).toBeFocused();
    // The server holds the first-page story only once the local change is confirmed; the stand-in
    // remote of the harness maps its steps back through changes that are not confirmed yet.
    await h.confirm();
    const how = await h.remoteInsert({ node: id, at: 'end', text: 'Cover', mode: 'map' });
    expect({ how, text: await h.nodeText(id) }).toEqual({ how: 'applied', text: 'Cover' });
    await expect.poll(() => h.subText()).toBe('Cover');
    await expect(page.locator('doc-editor .de-sub-editor')).toContainText('Cover');
    expect((await h.validate()).violations).toEqual([]);
  });
});
