/**
 * FE-101 criterion 5 (lane w1): in the editable page view a form field is the web view's own control,
 * set in the overlay of its page (FE-093) over the room the layout left for it. Run from the
 * repository root with
 * `DOCEDIT_DEMO_PORT=57102 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-101-page-view-fields.spec.ts`.
 *
 * The page view is not offered in Firefox (owner decision 247), so the suite is skipped there.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { FIELD_IDS, confirmed, control, editorOf, mountFields, nodes } from './frw-helpers.ts';

const EDITOR = editorOf('one');
const VIEW = `${EDITOR} .de-page-view`;

/** A desktop pointer: some machines with a touch screen answer `any-pointer: coarse` (FE-113). */
async function desktopPointer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      original(query.includes('any-pointer: coarse') ? 'not all' : query);
  });
}

/** Shows the page view and scrolls to the paragraph of fields, which is the last block. */
async function showFields(page: Page): Promise<void> {
  await page.evaluate((sel) => document.querySelector(sel)!.setAttribute('view', 'print'), EDITOR);
  await expect(page.locator(`${VIEW} .de-line`).first()).toBeVisible();
  await page.evaluate((sel) => {
    const scroller = document.querySelector(sel)!.shadowRoot!.querySelector('.de-page-scroller')!;
    scroller.scrollTop = scroller.scrollHeight;
  }, EDITOR);
  await expect(page.locator(`${VIEW} .de-overlay .de-control`)).toHaveCount(4);
}

const pageControl = (page: Page, id: string) =>
  page.locator(`${VIEW} .de-overlay .de-control[data-field="${id}"] .de-form-field-control`);

const fieldValue = async (page: Page, id: string): Promise<unknown> =>
  nodes(await confirmed(page, 'one'), 'form_field').find((f) => f.attrs?.['id'] === id)?.attrs?.[
    'value'
  ];

test.describe('form fields in the page view (FE-101 criterion 5; FE-093)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName === 'firefox', 'the page view is not offered in Firefox (decision 247)');
  });

  test('each field is a control in the overlay, on the room its line left for it', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await desktopPointer(page);
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'ada', role: 'editor' });
    await showFields(page);

    const facts = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      const view = root.querySelector('.de-page-view')!;
      return [...view.querySelectorAll<HTMLElement>('.de-overlay .de-control[data-field]')].map(
        (c) => {
          const id = c.dataset['field']!;
          const room = view.querySelector<HTMLElement>(`.de-inline-box[data-field="${id}"]`)!;
          const line = room.closest<HTMLElement>('.de-line')!.getBoundingClientRect();
          const r = c.getBoundingClientRect();
          const w = room.getBoundingClientRect();
          return {
            id,
            // The control's box and the room the browser laid out for it.
            dx: Math.abs(r.left - w.left),
            dw: Math.abs(r.width - w.width),
            // The control sits on the line that holds the field.
            insideLine: r.top >= line.top - 1 && r.bottom <= line.bottom + 1,
            // The overlay itself takes no pointer events; the control does.
            controlPointer: getComputedStyle(c).pointerEvents,
            overlayPointer: getComputedStyle(c.parentElement!).pointerEvents,
            hasControl: c.querySelector('.de-form-field-control') !== null,
            shown: r.width > 20,
          };
        },
      );
    }, EDITOR);
    expect(facts.map((f) => f.id).sort()).toEqual(
      [FIELD_IDS.amount, FIELD_IDS.name, FIELD_IDS.email, FIELD_IDS.landlordName].sort(),
    );
    for (const f of facts) {
      expect(f.dx, `${f.id} left`).toBeLessThan(1.5);
      expect(f.dw, `${f.id} width`).toBeLessThan(1.5);
      expect(f.insideLine, `${f.id} on its line`).toBe(true);
      expect(f.controlPointer).toBe('auto');
      expect(f.overlayPointer).toBe('none');
      expect(f.hasControl).toBe(true);
      expect(f.shown).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  test('a control is named, required and checked as the web view has it (FRW-004)', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'ada', role: 'editor' });
    await showFields(page);
    const name = pageControl(page, FIELD_IDS.name);
    await expect(name).toHaveAttribute('aria-label', 'Name');
    await expect(name).toHaveAttribute('aria-required', 'true');
    // An entry that fails its check is flagged while it is typed.
    const amount = pageControl(page, FIELD_IDS.amount);
    await amount.fill('5000');
    await expect(amount).toHaveAttribute('aria-invalid', 'true');
  });

  test('an entry goes to the one core, the page view stays and the focus is kept', async ({
    page,
  }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'ada', role: 'editor' });
    await showFields(page);
    const name = pageControl(page, FIELD_IDS.name);
    await name.click();
    await page.keyboard.type('Ada Lovelace');
    // Tab commits the entry and moves to the next control.
    await page.keyboard.press('Tab');
    await expect.poll(() => fieldValue(page, FIELD_IDS.name)).toBe('Ada Lovelace');
    // The pages are drawn again after the change; the control shows the entry, and the focus is on a control.
    await expect(page.locator(`${VIEW} .de-overlay .de-control`)).toHaveCount(4);
    await expect(pageControl(page, FIELD_IDS.name)).toHaveValue('Ada Lovelace');
    const focused = await page.evaluate((sel) => {
      const active = document.querySelector(sel)!.shadowRoot!.activeElement;
      return active?.closest('.de-control')?.getAttribute('data-field') ?? null;
    }, EDITOR);
    expect(focused).toBe(FIELD_IDS.email);

    // The web view behind has the same entry: one core.
    await page.evaluate((sel) => document.querySelector(sel)!.setAttribute('view', 'web'), EDITOR);
    await expect(control(page, FIELD_IDS.name)).toHaveValue('Ada Lovelace');
  });

  test('a checked entry of the web view shows in the page view (one core)', async ({ page }) => {
    await desktopPointer(page);
    await openEmbed(page);
    await mountFields(page, { name: 'one', sub: 'ada', role: 'editor' });
    await control(page, FIELD_IDS.email).fill('ada@example.org');
    await control(page, FIELD_IDS.email).blur();
    await expect.poll(() => fieldValue(page, FIELD_IDS.email)).toBe('ada@example.org');
    await showFields(page);
    await expect(pageControl(page, FIELD_IDS.email)).toHaveValue('ada@example.org');
  });
});
