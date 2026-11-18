/**
 * Host icons on the production element (UX-063, criterion 1). The `icons` property passes drawings
 * by the command's icon name to the shell: the host's drawing appears in the toolbar, a name the
 * host omits keeps the built-in drawing, a value that is not path data is ignored and reported, and
 * a change after mount takes effect without a remount. The control's name stays its label.
 * Run with
 * `DOCEDIT_DEMO_PORT=56292 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-063-icons.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { events, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';
const SQUARE = 'M4 4h16v16H4z';

/** Creates `<doc-editor>` with the icons property set before it connects, and waits for `de-ready`. */
async function mountWithIcons(page: Page, icons: unknown): Promise<void> {
  await page.evaluate(async (value) => {
    const e = (
      window as unknown as {
        __embed: { backend(sub: string, role: string): unknown; docId: string };
      }
    ).__embed;
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      icons: unknown;
    };
    el.dataset['test'] = 'one';
    el.icons = value;
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = e.backend('ada', 'editor');
    el.setAttribute('doc-id', e.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, icons as never);
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();
}

/** The `d` of each path in the icon of a toolbar command, or null when none is drawn. */
async function drawn(page: Page, command: string): Promise<string[] | null> {
  return page.evaluate(
    ([selector, id]) => {
      const root = document.querySelector(selector!)!.shadowRoot!;
      const svg = root.querySelector(`.de-toolbar [data-command-id="${id}"] svg.de-icon`);
      return svg ? [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '') : null;
    },
    [EDITOR, command] as const,
  );
}

test.describe('host icons on the element (UX-063 criterion 1)', () => {
  test('without the icons property the toolbar shows labels only', async ({ page }) => {
    await openEmbed(page);
    await mountWithIcons(page, null);
    expect(await drawn(page, 'format.bold')).toBeNull();
    await expect(
      page.locator(EDITOR).getByRole('button', { name: 'Bold', exact: true }),
    ).toBeVisible();
  });

  test('the icons property reaches the toolbar, and a name the host omits keeps the built-in icon', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithIcons(page, { bold: SQUARE });
    expect(await drawn(page, 'format.bold')).toEqual([SQUARE]);
    const italic = await drawn(page, 'format.italic');
    expect(italic).not.toBeNull();
    expect(italic).not.toEqual([SQUARE]);
    const control = page.locator(EDITOR).getByRole('button', { name: 'Bold', exact: true });
    await expect(control).toHaveAccessibleName('Bold');
  });

  test('a value that is not path data is ignored and reported, and the editor still mounts', async ({
    page,
  }) => {
    const reports: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') reports.push(m.text());
    });
    await openEmbed(page);
    await mountWithIcons(page, { bold: '<img src=x onerror=alert(1)>', italic: SQUARE });
    expect(await drawn(page, 'format.italic')).toEqual([SQUARE]);
    const bold = await drawn(page, 'format.bold');
    expect(bold).not.toBeNull();
    expect(bold).not.toEqual([SQUARE]);
    await expect.poll(() => reports.some((t) => t.includes('bold'))).toBe(true);
    const markup = await page.evaluate(
      (selector) => document.querySelector(selector)!.shadowRoot!.querySelectorAll('img').length,
      EDITOR,
    );
    expect(markup).toBe(0);
    expect(await events(page, 'de-error')).toEqual([]);
  });

  test('a change after mount takes effect without a remount, and a value that is not an object turns icons off', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithIcons(page, {});
    const builtIn = await drawn(page, 'format.bold');
    expect(builtIn).not.toBeNull();
    await page.evaluate((selector) => {
      (document.querySelector(selector) as HTMLElement & { icons: unknown }).icons = {
        bold: 'M1 1h10v10H1z',
      };
    }, EDITOR);
    await expect.poll(() => drawn(page, 'format.bold')).toEqual(['M1 1h10v10H1z']);
    const ignored = await page.evaluate((selector) => {
      const el = document.querySelector(selector) as HTMLElement & { icons: unknown };
      el.icons = 'not a set';
      return el.icons;
    }, EDITOR);
    expect(ignored).toBeNull();
    // No set: labels only.
    await expect.poll(() => drawn(page, 'format.bold')).toBeNull();
  });
});
