/**
 * Helpers for the embedding suites (e2e/element.spec.ts, e2e/pdf-viewer.spec.ts): the demo pages
 * `embed.html` (element from source with test hooks, demo/embed-page.ts) and `lib.html` (the
 * library build, demo/lib-page.ts).
 */
import { type Page, expect } from '@playwright/test';

export interface Recorded {
  name: string;
  target: string;
  /** The `data-test` name of the element that raised it. */
  element: string | null;
  detail: unknown;
  composed: boolean;
  bubbles: boolean;
}

export async function openEmbed(page: Page, query = ''): Promise<void> {
  await page.goto(`/pages/embed.html${query}`);
  await page.waitForFunction(() => 'customElements' in window && '__embed' in window);
}

export async function openLib(page: Page): Promise<void> {
  await page.goto('/pages/lib.html');
  await page.waitForFunction(() => '__lib' in window);
}

/** Events the embed page recorded on the document. */
export function events(page: Page, name?: string): Promise<Recorded[]> {
  return page.evaluate((n) => {
    const all = (window as unknown as { __embed: { events: Recorded[] } }).__embed.events;
    return n ? all.filter((e) => e.name === n) : [...all];
  }, name);
}

/**
 * Creates `<doc-editor>` with the embed page's backend for `sub` and mounts it into `#mount` (or
 * `target`), then waits for `de-ready`. Returns nothing; the element is `document.querySelector`-able
 * by `data-test`.
 */
export async function mountEditor(
  page: Page,
  opts: {
    sub?: string;
    role?: string;
    name?: string;
    target?: string;
    doc?: 'first' | 'second' | 'regions' | 'rtl' | 'rtl-regions';
    /** The `mode` attribute, set before the element connects (05 §8.1). */
    mode?: string;
    /** Further attributes, set before the element connects (for example `toolbar`, `theme`). */
    attributes?: Record<string, string>;
  } = {},
): Promise<void> {
  await page.evaluate(
    async ({ sub, role, name, target, doc, mode, attributes }) => {
      const e = (window as unknown as { __embed: Record<string, never> }).__embed as unknown as {
        backend(sub: string, role: string): unknown;
        docId: string;
        secondDocId: string;
        regionsDocId: string;
        rtlDocId: string;
        rtlRegionsDocId: string;
      };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      if (mode !== null) el.setAttribute('mode', mode);
      for (const [attr, value] of Object.entries(attributes ?? {})) el.setAttribute(attr, value);
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          {
            once: true,
          },
        );
      });
      el.backend = e.backend(sub, role);
      el.setAttribute(
        'doc-id',
        doc === 'second'
          ? e.secondDocId
          : doc === 'regions'
            ? e.regionsDocId
            : doc === 'rtl'
              ? e.rtlDocId
              : doc === 'rtl-regions'
                ? e.rtlRegionsDocId
                : e.docId,
      );
      document.getElementById(target)!.append(el);
      await ready;
    },
    {
      sub: opts.sub ?? 'ada',
      role: opts.role ?? 'editor',
      name: opts.name ?? 'one',
      target: opts.target ?? 'mount',
      doc: opts.doc ?? 'first',
      mode: opts.mode ?? null,
      attributes: opts.attributes ?? {},
    },
  );
  await expect(
    page.locator(`doc-editor[data-test="${opts.name ?? 'one'}"] .de-editing-surface`),
  ).toBeVisible();
}

/**
 * Runs a toolbar command by its `data-command` name. A command the toolbar has no room for is in
 * its "More" menu (the shell lays the toolbar out by width, and a backend with more features
 * offers more commands), so the menu is opened and the same command is chosen there.
 */
export async function clickToolbarCommand(page: Page, command: string): Promise<void> {
  const direct = page.locator(`doc-editor button[data-command="${command}"]`);
  await direct.waitFor({ state: 'attached' });
  if (await direct.isVisible()) {
    await direct.click();
    return;
  }
  const id = await direct.getAttribute('data-command-id');
  await page.locator('doc-editor [data-command-id="toolbar.more"]').click();
  await page.locator(`doc-editor [data-menu-item][data-command-id="${id}"]`).click();
}

/** Text of the body of the editor named `name`, through the spike harness. */
export function bodyText(page: Page, name = 'one'): Promise<string> {
  return page.evaluate(async (n) => {
    const el = document.querySelector(`doc-editor[data-test="${n}"]`)!;
    const e = (
      window as unknown as { __embed: { harness(el: Element): Promise<{ bodyText(): string }> } }
    ).__embed;
    return (await e.harness(el)).bodyText();
  }, name);
}

/** The XOR-encoded bytes of an export, decoded in the page (the filtered browsers; spike S2 §2). */
export const FILTERED_BROWSERS = new Set(['firefox', 'msedge']);
