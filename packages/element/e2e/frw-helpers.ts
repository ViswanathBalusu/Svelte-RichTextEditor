/**
 * Helpers for the FRW suites of the element (lane w4): the form document of the embed page
 * (demo/embed-page.ts `fieldsDocument`: two roles, three fields of the tenant and one of the
 * landlord), opened by an author or by a participant who may only fill.
 */
import { type Locator, type Page, expect } from '@playwright/test';

export const FIELD_IDS = {
  tenant: 'role_tenant',
  landlord: 'role_landlord',
  amount: 'fAmount000000001',
  name: 'fName00000000001',
  email: 'fEmail0000000001',
  landlordName: 'fLandlord0000001',
} as const;

export interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}

export const editorOf = (name: string): string => `doc-editor[data-test="${name}"]`;

/**
 * Mounts the form document. With `fill`, for a participant who holds the tenant's role and may
 * only fill, in the fill mode; else for `sub` with the document role `role`.
 */
export async function mountFields(
  page: Page,
  opts: { name?: string; sub?: string; role?: string; fill?: boolean; limit?: boolean } = {},
): Promise<void> {
  const name = opts.name ?? 'one';
  await page.evaluate(
    async ({ name, sub, role, fill, limit }) => {
      const e = (window as unknown as { __embed: Record<string, unknown> }).__embed as unknown as {
        fillBackend(sub: string): unknown;
        backend(sub: string, role: string, docs: string[]): unknown;
        fieldsDocId: string;
        fieldLimitDocId(): string;
      };
      // `limit`: the document one field short of the limit of form fields, not the form document.
      const docId = limit ? e.fieldLimitDocId() : e.fieldsDocId;
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      if (fill) el.setAttribute('mode', 'fill');
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = fill ? e.fillBackend(sub) : e.backend(sub, role, [docId]);
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    {
      name,
      sub: opts.sub ?? 'ada',
      role: opts.role ?? 'editor',
      fill: opts.fill ?? false,
      limit: opts.limit ?? false,
    },
  );
  await expect(page.locator(`${editorOf(name)} .de-editing-surface`)).toBeVisible();
}

/** The control of the form field with `id` in the editing surface of the editor `name`. */
export function control(page: Page, id: string, name = 'one'): Locator {
  return page.locator(
    `${editorOf(name)} .de-form-field[data-field="${id}"] .de-form-field-control`,
  );
}

/** The confirmed document of the editor `name`: what the service has acknowledged. */
export async function confirmed(page: Page, name = 'one'): Promise<Node> {
  const json = await page.evaluate((n) => {
    const e = (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { core: { confirmedContent(): { doc: unknown } } } };
        };
      }
    ).__embed;
    const el = document.querySelector(`doc-editor[data-test="${n}"]`)!;
    return JSON.stringify(e.internals(el).editor.core.confirmedContent().doc);
  }, name);
  return JSON.parse(json) as Node;
}

export function nodes(root: Node, type: string): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    if (n.type === type) out.push(n);
    for (const child of n.content ?? []) walk(child);
  };
  walk(root);
  return out;
}

/** Opens a pane of the editor `name` by the command search, by the command's label. */
export async function openPaneBySearch(
  page: Page,
  name: string,
  label: string,
  pane: string,
): Promise<Locator> {
  const editor = editorOf(name);
  await page.locator(`${editor} .de-editing-surface p`).first().click();
  await page.keyboard.press('Alt+q');
  await expect(page.locator(`${editor} [role="combobox"]`)).toBeFocused();
  await page.keyboard.type(label);
  await expect(page.locator(`${editor} [role="option"]`).first()).toContainText(label);
  await page.keyboard.press('Enter');
  const locator = page.locator(`${editor} .de-pane[data-pane="${pane}"]`);
  await expect(locator).toBeVisible();
  return locator;
}
