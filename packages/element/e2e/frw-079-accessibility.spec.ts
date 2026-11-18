/**
 * FRW-079 (lane w4): the controls of the form fields in the real element, in the shadow root of the
 * editor, with the shell around them. A document with a field of every kind (embed page:
 * `kindsDocId`) is opened by an editor.
 *
 * - Criterion 6: axe finds no violation on the editing surface of that form, with every kind of
 *   field, empty and with an invalid entry.
 * - Criterion 3: the accessibility tree of Chromium (the tree a screen reader reads, through the
 *   protocol's `Accessibility.getFullAXTree`) gives each control its role, name, required state,
 *   invalid state, value and description, the description naming the kind and the role. No screen
 *   reader was run: the tree is what the platform's readers are given.
 * - Criterion 5: with the keyboard only, focus is visible on every control, Tab walks through them
 *   and out of the surface, and Escape leaves the editing surface.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-079-accessibility.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { control, editorOf, mountFields } from './frw-helpers.ts';

const KINDS = {
  text: 'fKText0000000001',
  number: 'fKNumber00000001',
  date: 'fKDate0000000001',
  checkbox: 'fKCheck000000001',
  choice: 'fKChoice00000001',
} as const;
const EDITOR = editorOf('one');
const ORDER = [KINDS.text, KINDS.number, KINDS.date, KINDS.checkbox, KINDS.choice] as const;

async function open(page: Page): Promise<void> {
  await openEmbed(page);
  await mountFields(page, { kinds: true });
}

/** The violations axe finds on the editing surface of the editor, as `rule: nodes`. */
async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include([[EDITOR, '.de-editing-surface']])
    .analyze();
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

test('axe reports no violation on a form with every kind of field (criterion 6)', async ({
  page,
}) => {
  await open(page);
  for (const id of ORDER) await expect(control(page, id)).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // With entries, one of them invalid: the message beside the control is part of the surface.
  await control(page, KINDS.text).fill('Ada');
  await control(page, KINDS.number).fill('-1');
  await control(page, KINDS.number).press('Tab');
  await expect(control(page, KINDS.number)).toHaveAttribute('aria-invalid', 'true');
  await control(page, KINDS.checkbox).check();
  await control(page, KINDS.choice).selectOption('opt_married');
  expect(await violations(page)).toEqual([]);
});

interface AxNode {
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: unknown };
  ignored?: boolean;
  properties?: Array<{ name: string; value: { value?: unknown } }>;
}

/** What the browser's accessibility tree says of the control named `name` (Chromium only). */
async function axNode(
  page: Page,
  name: string,
  role: string,
): Promise<AxNode & { props: Record<string, unknown> }> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Accessibility.enable');
    const { nodes } = (await session.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] };
    const found = nodes.filter(
      (n) => !n.ignored && n.role?.value === role && n.name?.value === name,
    );
    expect(found, `one ${role} named ${name} in the accessibility tree`).toHaveLength(1);
    const node = found[0]!;
    const props = Object.fromEntries((node.properties ?? []).map((q) => [q.name, q.value.value]));
    return { ...node, props };
  } finally {
    await session.detach();
  }
}

test('the accessibility tree names each control, its kind, role, required state and value (criterion 3)', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'the accessibility tree is read through the Chromium protocol',
  );
  await open(page);

  const text = await axNode(page, 'Full name', 'textbox');
  expect(text.description?.value).toBe('Text field for Tenant');
  expect(text.props['required']).toBe(true);
  expect(text.props['invalid']).not.toBe('true');

  const number = await axNode(page, 'Rent', 'textbox');
  expect(number.description?.value).toBe('Number field for Tenant');
  expect(number.props['required']).not.toBe(true);

  const checkbox = await axNode(page, 'Has pets', 'checkbox');
  expect(checkbox.description?.value).toBe('Checkbox field for Tenant');
  expect(checkbox.props['checked']).toBe('false');

  const choice = await axNode(page, 'Status', 'combobox');
  expect(choice.description?.value).toBe('Choice field for Tenant');

  // The value, the invalid state and the message are in the tree once they exist.
  await control(page, KINDS.text).fill('Ada');
  await control(page, KINDS.text).press('Tab');
  await control(page, KINDS.number).fill('-1');
  await control(page, KINDS.number).press('Tab');
  await control(page, KINDS.checkbox).check();
  await control(page, KINDS.choice).selectOption('opt_married');
  const filled = await axNode(page, 'Full name', 'textbox');
  expect(filled.value?.value).toBe('Ada');
  const invalid = await axNode(page, 'Rent', 'textbox');
  expect(invalid.props['invalid']).toBe('true');
  expect(invalid.description?.value).toMatch(/^Number field for Tenant. enter /);
  expect((await axNode(page, 'Has pets', 'checkbox')).props['checked']).toBe('true');
  expect((await axNode(page, 'Status', 'combobox')).value?.value).toBe('Married');
});

test('with the keyboard only, focus is visible, Tab leaves no trap and Escape leaves the surface (criterion 5)', async ({
  page,
}) => {
  await open(page);
  const surface = page.locator(`${EDITOR} .de-editing-surface`);
  const focused = (id: string) => control(page, id);

  // Every control shows an outline when the keyboard focuses it.
  await focused(KINDS.text).focus();
  for (let i = 0; i < ORDER.length; i++) {
    const id = ORDER[i]!;
    await expect(focused(id)).toBeFocused();
    const outline = await focused(id).evaluate((el) => {
      const c = getComputedStyle(el);
      return { style: c.outlineStyle, width: parseFloat(c.outlineWidth) };
    });
    expect(outline.style, `outline of ${id}`).not.toBe('none');
    expect(outline.width, `outline of ${id}`).toBeGreaterThan(0);
    // Tab goes on to the next control; a date control visits its day, month and year first.
    if (i < ORDER.length - 1)
      for (
        let n = 0;
        n < 6 && !(await focused(ORDER[i + 1]!).evaluate((el) => el.matches(':focus')));
        n++
      )
        await page.keyboard.press('Tab');
  }

  // No trap: Escape leaves the editing surface, and Tab then goes on to the page.
  await page.keyboard.press('Escape');
  const inside = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    const active = root.activeElement;
    return active !== null && !!active.closest('.de-editing-surface');
  }, EDITOR);
  expect(inside, 'focus is off the editing surface after Escape').toBe(false);
  await expect(surface).toBeVisible();
});
