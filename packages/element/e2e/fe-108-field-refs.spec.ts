/**
 * FE-108 criterion 3: a field control and its label share a root, in the web view and in the page
 * view (FE-093 overlay). On the embed page, with a document of form fields, every reference from an
 * element of the editor's shadow root (`aria-labelledby`, `aria-describedby`, `aria-controls`,
 * `aria-owns`, `aria-activedescendant`, and `for` of a label) must resolve to an element of that
 * same root, and each field control must have an accessible name that is found in the root: its own
 * `aria-label`, or the text of the labels its references name. Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57108 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-108-field-refs.spec.ts`.
 *
 * The page view is not offered in Firefox (owner decision 247), so its test is skipped there.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { FIELD_IDS, editorOf, mountFields } from './frw-helpers.ts';

const EDITOR = editorOf('one');

interface Facts {
  /** References whose target is not in the editor's shadow root. */
  readonly broken: string[];
  readonly refs: number;
  /** Each field control found, with where its name comes from. */
  readonly controls: Array<{ id: string; via: string; name: string; inRoot: boolean }>;
}

/** Every reference in the root, and the name of each field control. */
function inspect(page: Page, scope: string): Promise<Facts> {
  return page.evaluate(
    ({ sel, scopeSel }) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const attrs = [
        'aria-labelledby',
        'aria-describedby',
        'aria-controls',
        'aria-owns',
        'aria-activedescendant',
      ];
      const broken: string[] = [];
      let refs = 0;
      for (const el of root.querySelectorAll('*')) {
        const ids: Array<[string, string]> = [];
        for (const attr of attrs)
          for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean))
            ids.push([attr, id]);
        if (el.tagName === 'LABEL' && el.hasAttribute('for'))
          ids.push(['for', el.getAttribute('for')!]);
        for (const [attr, id] of ids) {
          refs++;
          if (root.getElementById(id) === null)
            broken.push(`${el.tagName.toLowerCase()} ${attr}="${id}"`);
        }
      }
      const controls: Facts['controls'] = [];
      const scoped = root.querySelector(scopeSel) ?? root;
      for (const el of scoped.querySelectorAll<HTMLElement>('.de-form-field-control')) {
        const holder = el.closest<HTMLElement>('[data-field]');
        const id = holder?.dataset['field'] ?? el.id;
        const label = el.getAttribute('aria-label');
        if (label !== null && label.trim() !== '') {
          controls.push({ id, via: 'aria-label', name: label, inRoot: true });
          continue;
        }
        const by = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
        const named = by.map((i) => root.getElementById(i));
        const forLabel =
          el.id === '' ? null : root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const text = [...named, forLabel]
          .filter((n): n is HTMLElement => n !== null)
          .map((n) => n.textContent ?? '')
          .join(' ')
          .trim();
        controls.push({
          id,
          via: by.length > 0 ? 'aria-labelledby' : forLabel ? 'label for' : 'none',
          name: text,
          inRoot: named.every((n) => n !== null),
        });
      }
      return { broken, refs, controls };
    },
    { sel: EDITOR, scopeSel: scope },
  );
}

test.describe('field controls and their labels share a root (FE-108 criterion 3)', () => {
  test('in the web view every reference resolves in the root and every field control is named there', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'ada', role: 'editor' });
    await expect(page.locator(`${EDITOR} >> .de-form-field-control`).first()).toBeVisible();
    const facts = await inspect(page, '.de-editing-surface');
    expect(facts.controls.length).toBeGreaterThanOrEqual(4);
    expect(facts.broken).toEqual([]);
    for (const c of facts.controls) {
      expect(c.name.trim(), `${c.id} is named`).not.toBe('');
      expect(c.inRoot, `${c.id} label in the root`).toBe(true);
    }
  });

  test('in the page view the overlay controls and their labels are in the root', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', 'the page view is not offered in Firefox (decision 247)');
    // A desktop pointer: some machines with a touch screen answer `any-pointer: coarse` (FE-113).
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        original(query.includes('any-pointer: coarse') ? 'not all' : query);
    });
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'ada', role: 'editor' });
    await page.evaluate(
      (sel) => document.querySelector(sel)!.setAttribute('view', 'print'),
      EDITOR,
    );
    await expect(page.locator(`${EDITOR} .de-page-view .de-line`).first()).toBeVisible();
    await page.evaluate((sel) => {
      const scroller = document.querySelector(sel)!.shadowRoot!.querySelector('.de-page-scroller')!;
      scroller.scrollTop = scroller.scrollHeight;
    }, EDITOR);
    await expect(page.locator(`${EDITOR} .de-page-view .de-overlay .de-control`)).toHaveCount(4);
    const facts = await inspect(page, '.de-page-view');
    expect(facts.controls.map((c) => c.id).sort()).toEqual(
      [FIELD_IDS.amount, FIELD_IDS.name, FIELD_IDS.email, FIELD_IDS.landlordName].sort(),
    );
    expect(facts.broken).toEqual([]);
    for (const c of facts.controls) {
      expect(c.name.trim(), `${c.id} is named`).not.toBe('');
      expect(c.inRoot, `${c.id} label in the root`).toBe(true);
    }
  });

  test('the check can fail: a reference to an ID outside the root is reported', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'ada', role: 'editor' });
    await expect(page.locator(`${EDITOR} >> .de-form-field-control`).first()).toBeVisible();
    await page.evaluate((sel) => {
      const outside = document.createElement('span');
      outside.id = 'fe-108-outside-the-root';
      document.body.append(outside);
      document
        .querySelector(sel)!
        .shadowRoot!.querySelector('.de-form-field-control')!
        .setAttribute('aria-labelledby', 'fe-108-outside-the-root');
    }, EDITOR);
    const facts = await inspect(page, '.de-editing-surface');
    expect(facts.broken.some((b) => b.includes('fe-108-outside-the-root'))).toBe(true);
  });
});
