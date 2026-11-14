/**
 * FE-019 criterion 3 (lane V-FE-017-032): under `forced-colors: active`, each decoration the editing
 * core draws (find matches, comment ranges, suggestions) keeps a cue that is not a background colour:
 * an outline, an underline, an overline, a line-through or a border. The decoration classes are the
 * ones the core writes (`de-find-match`, `de-find-current`, `de-comment-range`, `de-suggest-ins`,
 * `de-suggest-del`, `de-suggest-fmt`; their emission is checked by the engine's own tests). Each
 * class is put in the editing surface's shadow root, and the computed style is read under the
 * Playwright `forcedColors: 'active'` emulation. The three suggestion kinds must differ by their
 * line, not by colour alone.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-019-decorations-forced.spec.ts --retries=0 --output=packages/element/test-results/V-FE-017-032-fe019-deco
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

const CLASSES = [
  'de-find-match',
  'de-find-current',
  'de-comment-range',
  'de-suggest-ins',
  'de-suggest-del',
  'de-suggest-fmt',
] as const;

test.describe('FE-019 criterion 3: decorations stay distinguishable under forced colours', () => {
  test('each decoration class has an outline, underline, overline, line-through or border', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await expect(page.locator(`${editor} .de-editing-surface`)).toHaveAttribute(
      'contenteditable',
      'true',
    );
    await page.emulateMedia({ forcedColors: 'active' });
    // The emulation is confirmed by the media query, so the checks below read the forced rules.
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);

    // The decorations go in a sibling of the editing surface inside the element's shadow root, so
    // the element's own stylesheet applies to them and the document is not changed.
    await page.evaluate(
      ({ sel, classes }) => {
        const host = document.querySelector(sel) as HTMLElement;
        const root = host.shadowRoot!;
        const surface = root.querySelector('.de-editing-surface')!;
        const box = document.createElement('div');
        box.setAttribute('data-test', 'fe-019-decorations');
        for (const cls of classes) {
          const span = document.createElement('span');
          span.className = cls;
          span.textContent = cls;
          box.append(span, ' ');
        }
        surface.parentElement!.append(box);
      },
      { sel: editor, classes: CLASSES },
    );

    const styles = await page.evaluate(
      ({ sel, classes }) => {
        const root = (document.querySelector(sel) as HTMLElement).shadowRoot!;
        return classes.map((cls) => {
          const el = root.querySelector(`[data-test="fe-019-decorations"] .${cls}`) as HTMLElement;
          const cs = getComputedStyle(el);
          return {
            cls,
            background: cs.backgroundColor,
            outline: cs.outlineStyle,
            underline: cs.textDecorationLine,
            border: cs.borderTopStyle,
          };
        });
      },
      { sel: editor, classes: CLASSES },
    );

    for (const s of styles) {
      const cue =
        s.outline !== 'none' ||
        s.underline.includes('line') ||
        s.underline.includes('overline') ||
        s.border !== 'none';
      expect(cue, `${s.cls} has a non-colour cue`).toBe(true);
    }

    // The three suggestion kinds differ by their line, not by colour.
    const line = (cls: string) => styles.find((s) => s.cls === cls)!.underline;
    const kinds = ['de-suggest-ins', 'de-suggest-del', 'de-suggest-fmt'].map(line);
    expect(new Set(kinds).size).toBe(3);

    // The current match is heavier than the other matches: its outline is a different width.
    const outlineWidth = (cls: string) =>
      page.evaluate(
        ({ sel, cls }) => {
          const root = (document.querySelector(sel) as HTMLElement).shadowRoot!;
          const el = root.querySelector(`[data-test="fe-019-decorations"] .${cls}`) as HTMLElement;
          return getComputedStyle(el).outlineWidth;
        },
        { sel: editor, cls },
      );
    expect(await outlineWidth('de-find-current')).not.toBe(await outlineWidth('de-find-match'));
  });
});
