/**
 * FE-018 criterion 5 (lane V-FE-017-032): `::part()` styles each documented region, and a part name
 * the element does not expose matches nothing. The documented names are header, toolbar, ruler,
 * page, sidebar, statusbar and dialog. A host rule is added for each name; the test reads the
 * computed outline of the shadow-root element that carries the part, and reports which parts the
 * page shows. The ruler (UX-102) is built, so it is styled like the others.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-018-parts-regions.spec.ts --retries=0 --output=packages/element/test-results/V-FE-017-032-fe018
 */
import { expect, test, type Page } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

const PARTS = ['header', 'toolbar', 'ruler', 'page', 'sidebar', 'statusbar', 'dialog'] as const;

/** The outline colour the test gives each part, one per part, plus a bogus name. */
const COLOUR: Record<string, string> = {
  header: 'rgb(10, 20, 30)',
  toolbar: 'rgb(40, 50, 60)',
  ruler: 'rgb(20, 90, 40)',
  page: 'rgb(70, 80, 90)',
  sidebar: 'rgb(100, 110, 120)',
  statusbar: 'rgb(130, 140, 150)',
  dialog: 'rgb(160, 170, 180)',
};

const partsPresent = (page: Page) =>
  page.evaluate((s) => {
    const root = document.querySelector(s)!.shadowRoot!;
    return [
      ...new Set(
        [...root.querySelectorAll('[part]')].flatMap((e) => e.getAttribute('part')!.split(/\s+/)),
      ),
    ].sort();
  }, editor);

test.describe('FE-018 criterion 5: ::part() styles each documented region', () => {
  test('a host rule styles each part the page shows; an undocumented name matches nothing', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const shown = await partsPresent(page);
    // Only documented names may be exposed at all.
    const documented = ['dialog', 'header', 'page', 'ruler', 'sidebar', 'statusbar', 'toolbar'];
    expect(shown.filter((p) => !documented.includes(p))).toEqual([]);
    // The page shows at least the toolbar, the ruler (UX-102) and the page region.
    expect(shown).toEqual(expect.arrayContaining(['page', 'ruler', 'toolbar']));
    console.log(`FE-018 parts shown on the embed page: ${shown.join(', ')}`);

    const rules = PARTS.map((p) => `doc-editor::part(${p}) { outline: 3px solid ${COLOUR[p]}; }`);
    rules.push('doc-editor::part(bogus) { outline: 3px solid rgb(1, 2, 3); }');
    await page.addStyleTag({ content: rules.join('\n') });

    const outlines = await page.evaluate(
      ({ s, parts }) => {
        const root = document.querySelector(s)!.shadowRoot!;
        return Object.fromEntries(
          parts.map((p) => {
            const el = root.querySelector(`[part~="${p}"]`);
            return [p, el ? getComputedStyle(el).outlineColor : null];
          }),
        );
      },
      { s: editor, parts: [...PARTS] },
    );

    for (const p of PARTS) {
      if (!shown.includes(p)) continue;
      expect(outlines[p], `part ${p}`).toBe(COLOUR[p]);
    }
    // Nothing in the element carries the bogus part, so no element shows its colour.
    const bogus = await page.evaluate((s) => {
      const root = document.querySelector(s)!.shadowRoot!;
      return [...root.querySelectorAll('*')].some(
        (e) => getComputedStyle(e).outlineColor === 'rgb(1, 2, 3)',
      );
    }, editor);
    expect(bogus).toBe(false);
  });

  test('the sidebar part styles an open pane and the dialog part an open dialog (lane w1)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    // The embed page shows neither until one is opened: a pane, as a command of the shell opens it
    // (the element's test hook), and the language dialog, through the element's own `exec`.
    await page.locator(`${editor} .de-editing-surface p`).first().click();
    const opened = await page.evaluate(async (s) => {
      const el = document.querySelector(s) as HTMLElement & {
        exec(name: string): { ok: boolean; reason?: string };
      };
      const hooks = (
        globalThis as unknown as {
          __embed: {
            internals(e: Element): { editor: { openPane(id: string): Promise<boolean> } };
          };
        }
      ).__embed;
      const pane = await hooks.internals(el).editor.openPane('outline');
      const dialog = el.exec('format.language');
      return { pane, dialog: dialog.ok };
    }, editor);
    expect(opened).toEqual({ pane: true, dialog: true });
    await expect(page.locator(`${editor} [part~="sidebar"]`).first()).toBeVisible();
    await expect(page.locator(`${editor} [part~="dialog"]`)).toBeVisible();
    const shown = await partsPresent(page);
    expect(shown).toEqual(expect.arrayContaining(['dialog', 'sidebar']));

    const rules = PARTS.map((p) => `doc-editor::part(${p}) { outline: 3px solid ${COLOUR[p]}; }`);
    await page.addStyleTag({ content: rules.join('\n') });
    const outlines = await page.evaluate(
      ({ s, parts }) => {
        const root = document.querySelector(s)!.shadowRoot!;
        return Object.fromEntries(
          parts.map((p) => [
            p,
            // Every element that carries the part takes the host's rule, not only the first.
            [...root.querySelectorAll(`[part~="${p}"]`)].map((el) => {
              const style = getComputedStyle(el);
              return `${style.outlineStyle} ${style.outlineColor}`;
            }),
          ]),
        );
      },
      { s: editor, parts: ['sidebar', 'dialog'] },
    );
    expect(outlines['sidebar']!.length).toBeGreaterThan(0);
    for (const outline of outlines['sidebar']!) expect(outline).toBe(`solid ${COLOUR['sidebar']}`);
    expect(outlines['dialog']).toEqual([`solid ${COLOUR['dialog']}`]);
    // The parts are the regions themselves: the pane's own container and the dialog element.
    const kinds = await page.evaluate((s) => {
      const root = document.querySelector(s)!.shadowRoot!;
      return {
        sidebar: [...root.querySelectorAll('[part~="sidebar"]')].map((el) => el.localName),
        dialog: [...root.querySelectorAll('[part~="dialog"]')].map((el) => el.localName),
      };
    }, editor);
    expect(kinds.sidebar.every((n) => n === 'aside')).toBe(true);
    expect(kinds.dialog).toEqual(['dialog']);
  });
});
