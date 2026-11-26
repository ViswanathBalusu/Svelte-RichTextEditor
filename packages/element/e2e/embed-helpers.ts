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
    /** The `config` property, set before the element connects (05 §8.1; PRO-081). */
    config?: Record<string, unknown>;
    /** Backend features announced in addition to the mock backend's own (05 §1 rule 4), for the shell's controls. */
    announce?: string[];
    /** Optional ports added to the mock backend (stand-ins that only exist; the shell offers a control for a port that is there). */
    ports?: ('exports' | 'proofing' | 'assistant')[];
  } = {},
): Promise<void> {
  await page.evaluate(
    async ({ sub, role, name, target, doc, mode, attributes, config, announce, ports }) => {
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
      if (config !== null) (el as unknown as { config: unknown }).config = config;
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
      const backend = e.backend(sub, role) as { features: ReadonlySet<string> };
      // A wrapper that answers `features` with more names and passes the rest through.
      el.backend =
        announce.length > 0 || ports.length > 0
          ? new Proxy(backend, {
              get: (target, key) => {
                if (key === 'features') return new Set([...target.features, ...announce]);
                if (key === 'exports' && ports.includes('exports')) return {};
                if (key === 'assistant' && ports.includes('assistant')) return {};
                if (key === 'proofing' && ports.includes('proofing'))
                  return { check: () => Promise.resolve([]), addWord: () => Promise.resolve() };
                const value = Reflect.get(target, key, target) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
              },
            })
          : backend;
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
      config: opts.config ?? null,
      announce: opts.announce ?? [],
      ports: opts.ports ?? [],
    },
  );
  const name = opts.name ?? 'one';
  // `view="read"` with `config.readPages` paints the pages read-only, as `print` does (FE-095).
  const paged =
    opts.attributes?.['view'] === 'print' ||
    (opts.attributes?.['view'] === 'read' && opts.config?.['readPages'] === true);
  if (paged) {
    await editorShown(page, name);
    return;
  }
  await expect(page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`)).toBeVisible();
}

/**
 * Waits until the editor named `name` (its `data-test`) shows a surface to edit on, whichever view
 * it is in. The page view hides the web view's surface and shows its own pages (FE-101); where the
 * page view is not offered the web view's surface is shown. Either one being visible means the
 * editor is up, so a test of `view="print"` that is not about the view itself waits for this.
 */
export async function editorShown(page: Page, name: string): Promise<void> {
  await page.waitForFunction((n) => {
    const root = document.querySelector(`doc-editor[data-test="${n}"]`)?.shadowRoot;
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    return [...(root?.querySelectorAll('.de-editing-surface, .de-page-view .de-page') ?? [])].some(
      shown,
    );
  }, name);
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

/**
 * Waits until the editor has taken the selection the browser made. The editor reads a native
 * selection change (a click, Home, Shift+End, a double click) on `selectionchange`, in a later task
 * (S1 §4.2), and a key or a command sent before that acts on the earlier selection, which can be
 * stale by a whole word. The browser moves its own selection while the key is dispatched, so this
 * compares the editor's anchor and head with the positions of the browser's selection in the body.
 * Waiting on that state, not on a fixed delay, holds on a slow runner too.
 */
export async function selectionSynced(page: Page, name = 'one'): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (n) => {
          const el = document.querySelector(`doc-editor[data-test="${n}"]`)!;
          const e = (
            window as unknown as {
              __embed: {
                harness(el: Element): Promise<{
                  view: {
                    state: { selection: { anchor: number; head: number } };
                    domSelectionRange(): {
                      anchorNode: Node | null;
                      anchorOffset: number;
                      focusNode: Node | null;
                      focusOffset: number;
                    };
                    posAtDOM(node: Node, offset: number): number;
                  };
                }>;
              };
            }
          ).__embed;
          const { view } = await e.harness(el);
          const dom = view.domSelectionRange();
          if (!dom.anchorNode || !dom.focusNode) return false;
          try {
            return (
              view.posAtDOM(dom.anchorNode, dom.anchorOffset) === view.state.selection.anchor &&
              view.posAtDOM(dom.focusNode, dom.focusOffset) === view.state.selection.head
            );
          } catch {
            return false;
          }
        }, name),
      { message: 'the editor has taken the selection the browser made' },
    )
    .toBe(true);
}

/** The XOR-encoded bytes of an export, decoded in the page (the filtered browsers; spike S2 §2). */
export const FILTERED_BROWSERS = new Set(['firefox', 'msedge']);
