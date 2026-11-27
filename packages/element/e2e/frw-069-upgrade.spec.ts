/**
 * FRW-069 criterion 6, as worded after owner decision 266 (docs/owner-decisions-2026-11-26.md):
 * "given the properties are set, and the attribute `mode` is present, before the element is
 * upgraded, then they take effect when it is; given the methods are called before a document is
 * loaded, then they answer that nothing applies and do not throw."
 *
 * The first half runs in the library build (`pages/lib.html`), which a host loads on demand: the
 * element is in the page, with `mode="fill"`, `doc-id` and the `backend` property, before the class
 * is defined. After the import it is upgraded, loads the document through the captured property,
 * and its body is read-only as the attribute asks. An element made the same way without `mode` edits.
 * The second half (no document: nothing applies, nothing thrown) is in test/frw-069-methods.test.ts
 * (Node.js), and here, on the upgraded element before any backend is given.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-069-upgrade.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import { openLib } from './embed-helpers.ts';
import { editorOf } from './frw-helpers.ts';

test('properties and the mode attribute set before the upgrade take effect on it (criterion 6)', async ({
  page,
}) => {
  await openLib(page);

  const before = await page.evaluate(() => {
    interface Lib {
      fieldsDocId: string;
      backendFor(sub: string, docIds: string[]): unknown;
    }
    const lib = (window as unknown as { __lib: Lib }).__lib;
    const make = (name: string, mode: string | null): void => {
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      el.setAttribute('doc-id', lib.fieldsDocId);
      if (mode !== null) el.setAttribute('mode', mode);
      el.backend = lib.backendFor('bob', [lib.fieldsDocId]);
      document.body.append(el);
    };
    make('asked-fill', 'fill');
    make('asked-nothing', null);
    const el = document.querySelector('doc-editor[data-test="asked-fill"]') as unknown as Record<
      string,
      unknown
    >;
    return {
      defined: customElements.get('doc-editor') !== undefined,
      // Before the class is defined there are no methods to call.
      methods: typeof el['getFieldValues'],
    };
  });
  expect(before).toEqual({ defined: false, methods: 'undefined' });

  // The import defines the class; both elements are upgraded, take the backend they were given,
  // and load the document.
  await page.evaluate(async () => {
    const lib = (window as unknown as { __lib: { load(): Promise<unknown> } }).__lib;
    const ready = ['asked-fill', 'asked-nothing'].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const el = document.querySelector(`doc-editor[data-test="${name}"]`)!;
          el.addEventListener('de-ready', () => resolve(), { once: true });
          el.addEventListener(
            'de-error',
            (e) => reject(new Error(JSON.stringify((e as CustomEvent).detail))),
            { once: true },
          );
        }),
    );
    await lib.load();
    await Promise.all(ready);
  });

  // The attribute took effect: the body of the first is read-only, and the second edits.
  await expect(page.locator(`${editorOf('asked-fill')} .de-editing-surface`)).toHaveAttribute(
    'contenteditable',
    'false',
  );
  await expect(page.locator(`${editorOf('asked-nothing')} .de-editing-surface`)).toHaveAttribute(
    'contenteditable',
    'true',
  );
  // The methods exist now, and answer from the document the captured backend gave.
  const after = await page.evaluate(() => {
    const el = document.querySelector('doc-editor[data-test="asked-fill"]') as unknown as {
      getFieldValues(): Record<string, unknown>;
      focusField(key: string): boolean;
    };
    return {
      values: Object.keys(el.getFieldValues()).length,
      unknown: el.focusField('no.such.key'),
    };
  });
  expect(after.values).toBeGreaterThan(0);
  expect(after.unknown).toBe(false);
});

test('methods called on an upgraded element with no document answer that nothing applies (criterion 6)', async ({
  page,
}) => {
  await openLib(page);
  const answers = await page.evaluate(async () => {
    const lib = (window as unknown as { __lib: { load(): Promise<unknown> } }).__lib;
    await lib.load();
    const el = document.createElement('doc-editor') as HTMLElement & {
      nextField(): boolean;
      focusField(key: string): boolean;
      getFieldValues(): Record<string, unknown>;
      validateFields(): unknown[];
      setFieldValue(key: string, value: unknown): Promise<{ ok: boolean; code?: string }>;
    };
    document.body.append(el);
    return {
      next: el.nextField(),
      focus: el.focusField('tenant.name'),
      values: el.getFieldValues(),
      invalid: el.validateFields(),
      set: await el.setFieldValue('tenant.name', 'Ada'),
    };
  });
  expect(answers).toEqual({
    next: false,
    focus: false,
    values: {},
    invalid: [],
    set: { ok: false, code: 'unavailable', message: expect.any(String) },
  });
});
