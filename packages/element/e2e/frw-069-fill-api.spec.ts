/**
 * FRW-069 (lane w4): the attribute `mode="fill"` and the field methods of the embedding API, called
 * on the real `<doc-editor>` element from the page, against the in-memory backend of the embed page
 * (which runs the real authority). The participant (`vic`) holds the tenant's role and may only
 * fill; the form document has the tenant's amount, name and e-mail and the landlord's name.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-069-fill-api.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import {
  FIELD_IDS as IDS,
  confirmed,
  control,
  editorOf,
  mountFields,
  nodes,
} from './frw-helpers.ts';

const FILL = editorOf('fill');
const mountFill = (page: Page): Promise<void> =>
  mountFields(page, { name: 'fill', sub: 'vic', fill: true });

/** Calls a method of the element `fill` in the page and returns what it returned. */
function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ method, args }) => {
      const el = document.querySelector('doc-editor[data-test="fill"]') as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      return (await el[method]!(...args)) as never;
    },
    { method, args },
  );
}

/** Whether the editor `name` has a commit in flight: sent to the room, not yet answered. */
const inflight = (page: Page, name: string): Promise<boolean> =>
  page.evaluate((n) => {
    const e = (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { core: { syncSnapshot(): { inflight: unknown } } } };
        };
      }
    ).__embed;
    const el = document.querySelector(`doc-editor[data-test="${n}"]`)!;
    return e.internals(el).editor.core.syncSnapshot().inflight !== null;
  }, name);

const activeField = (page: Page): Promise<string | null> =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel)!.shadowRoot!;
    return (
      (root.activeElement as HTMLElement | null)
        ?.closest('[data-field]')
        ?.getAttribute('data-field') ?? null
    );
  }, FILL);

test('mode="fill" makes the body read-only and the participant’s fields editable (criterion 1)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);
  expect(await page.locator(FILL).getAttribute('mode')).toBe('fill');
  await expect(page.locator(`${FILL} .de-editing-surface`)).toHaveAttribute(
    'contenteditable',
    'false',
  );
  await expect(control(page, IDS.name, 'fill')).toBeEditable();
  await expect(control(page, IDS.landlordName, 'fill')).not.toBeEditable();
});

test('the server’s permissions still apply whatever the attribute says (criterion 1)', async ({
  page,
}) => {
  await openEmbed(page);
  // A viewer who asks for the fill mode fills nothing: the effective mode is the view.
  await mountFields(page, { name: 'viewer', sub: 'ada', role: 'viewer' });
  await page.evaluate(() => {
    document.querySelector('doc-editor[data-test="viewer"]')!.setAttribute('mode', 'fill');
  });
  await expect(control(page, IDS.name, 'viewer')).not.toBeEditable();
  await expect(control(page, IDS.email, 'viewer')).not.toBeEditable();
  const effective = await page.evaluate(() => {
    const e = (
      window as unknown as {
        __embed: {
          internals(el: Element): {
            editor: { core: { mode: { get(): { requested: string; effective: string } } } };
          };
        };
      }
    ).__embed;
    return e
      .internals(document.querySelector('doc-editor[data-test="viewer"]')!)
      .editor.core.mode.get();
  });
  expect(effective).toEqual({ requested: 'fill', effective: 'view' });
});

test('focusField(key) and nextField() move focus, and an unknown key is reported, not thrown (criterion 2)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);
  expect(await call<boolean>(page, 'focusField', 'tenant.email')).toBe(true);
  expect(await activeField(page)).toBe(IDS.email);
  expect(await call<boolean>(page, 'focusField', 'no.such.key')).toBe(false);
  // Focus stays where it was.
  expect(await activeField(page)).toBe(IDS.email);

  // The next fillable field after the e-mail: none (the landlord's field is not the participant's).
  expect(await call<boolean>(page, 'nextField')).toBe(false);
  expect(await call<boolean>(page, 'focusField', 'tenant.amount')).toBe(true);
  expect(await call<boolean>(page, 'nextField')).toBe(true);
  expect(await activeField(page)).toBe(IDS.name);
  expect(await call<boolean>(page, 'nextField')).toBe(true);
  expect(await activeField(page)).toBe(IDS.email);
  // A field of another role is read-only but it has a control: focusField(key) reaches it, and
  // nextField() never stops there (open question of the story, see its Notes).
  expect(await call<boolean>(page, 'focusField', 'landlord.name')).toBe(true);
  expect(await activeField(page)).toBe(IDS.landlordName);
  expect(await call<boolean>(page, 'nextField')).toBe(false);
});

test('getFieldValues() returns the current values by key (criterion 3)', async ({ page }) => {
  await openEmbed(page);
  await mountFill(page);
  expect(await call(page, 'getFieldValues')).toEqual({
    'tenant.amount': null,
    'tenant.name': null,
    'tenant.email': null,
    'landlord.name': null,
  });
  await control(page, IDS.name, 'fill').fill('Ada');
  await control(page, IDS.name, 'fill').press('Tab');
  expect(await call<Record<string, unknown>>(page, 'getFieldValues')).toMatchObject({
    'tenant.name': 'Ada',
  });
});

test('setFieldValue(key, value) fills as the user, and a rejection comes back with its code (criterion 4)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);

  expect(await call(page, 'setFieldValue', 'tenant.name', 'Ada')).toEqual({
    ok: true,
    confirmed: true,
  });
  await expect(control(page, IDS.name, 'fill')).toHaveValue('Ada');
  const field = nodes(await confirmed(page, 'fill'), 'form_field').find(
    (n) => n.attrs?.['id'] === IDS.name,
  );
  expect(field?.attrs?.['value']).toBe('Ada');

  // P7: a field of another role.
  expect(await call(page, 'setFieldValue', 'landlord.name', 'Grace')).toMatchObject({
    ok: false,
    code: 'permission_denied',
  });
  // I15: a value that does not fit the kind, refused by the service.
  expect(await call(page, 'setFieldValue', 'tenant.amount', 'twelve')).toMatchObject({
    ok: false,
    code: 'field_invalid',
  });
  expect(await call(page, 'setFieldValue', 'no.such.key', 'x')).toMatchObject({
    ok: false,
    code: 'not_found',
  });

  // P9: the author's fill is stored first; the participant's fill of the same field, made from the
  // older base, is rejected with conflict.
  await mountFields(page, { name: 'author', sub: 'ada', role: 'editor' });
  await page.evaluate(() => {
    const e = (
      window as unknown as {
        __embed: { service: { holdWrites(id: string): unknown }; fieldsDocId: string };
      }
    ).__embed;
    (window as unknown as { __held: unknown }).__held = e.service.holdWrites(e.fieldsDocId);
  });
  await control(page, IDS.email, 'author').fill('ada@example.org');
  await control(page, IDS.email, 'author').press('Tab');
  // The author's commit is with the room (in flight, its answer held) before the participant fills.
  await expect.poll(() => inflight(page, 'author')).toBe(true);
  const pending = page.evaluate(() => {
    const el = document.querySelector('doc-editor[data-test="fill"]') as unknown as {
      setFieldValue(k: string, v: unknown): Promise<unknown>;
    };
    return el.setFieldValue('tenant.email', 'vic@example.org');
  });
  // The room answers the participant's fill at once, from the older base: conflict. Then the
  // author's answer is let go.
  const outcome = await pending;
  await page.evaluate(() =>
    (window as unknown as { __held: { release(): Promise<void> } }).__held.release(),
  );
  expect(outcome).toMatchObject({ ok: false, code: 'conflict' });
});

test('validateFields() returns the required and invalid fields and changes nothing (criterion 5)', async ({
  page,
}) => {
  await openEmbed(page);
  await mountFill(page);
  const first = await call<Array<{ key: string; problems: Array<{ code: string }> }>>(
    page,
    'validateFields',
  );
  expect(first.map((r) => [r.key, r.problems.map((p) => p.code)])).toEqual([
    ['tenant.name', ['required']],
    ['tenant.email', ['required']],
    ['landlord.name', ['required']],
  ]);
  const before = JSON.stringify(await confirmed(page, 'fill'));
  await control(page, IDS.email, 'fill').fill('not-an-address');
  await control(page, IDS.email, 'fill').press('Tab');
  const second = await call<Array<{ key: string; problems: Array<{ code: string }> }>>(
    page,
    'validateFields',
  );
  expect(second.find((r) => r.key === 'tenant.email')?.problems.map((p) => p.code)).not.toContain(
    'required',
  );
  // The typed value reaches the server on its own, a moment after the field loses focus. Wait for
  // that, so that the reads below compare the stored value with itself and not with the typing.
  await expect
    .poll(async () => JSON.stringify(await confirmed(page, 'fill')), {
      message: 'the typed value is stored',
    })
    .toContain('not-an-address');
  // Calling it again, however often, changes no stored value and sends no commit.
  const stored = JSON.stringify(await confirmed(page, 'fill'));
  await call(page, 'validateFields');
  await call(page, 'validateFields');
  expect(JSON.stringify(await confirmed(page, 'fill'))).toBe(stored);
  void before;
});

test('before a document is loaded the methods answer that nothing applies (criterion 6, after the upgrade)', async ({
  page,
}) => {
  await openEmbed(page);
  const answers = await page.evaluate(async () => {
    const el = document.createElement('doc-editor') as unknown as {
      nextField(): boolean;
      focusField(k: string): boolean;
      getFieldValues(): unknown;
      setFieldValue(k: string, v: unknown): Promise<unknown>;
      validateFields(): unknown;
    };
    return {
      next: el.nextField(),
      focus: el.focusField('tenant.name'),
      values: el.getFieldValues(),
      set: await el.setFieldValue('tenant.name', 'Ada'),
      validate: el.validateFields(),
    };
  });
  expect(answers).toMatchObject({
    next: false,
    focus: false,
    values: {},
    set: { ok: false, code: 'unavailable' },
    validate: [],
  });
});
