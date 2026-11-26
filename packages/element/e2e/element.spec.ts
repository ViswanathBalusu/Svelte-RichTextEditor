/**
 * The production element in every browser (FE-001, FE-002, FE-003, FE-004, FE-007, FE-013, FE-014,
 * FE-018, FE-021, FE-022, FE-025, FE-122; PRO-074, PRO-075, PRO-076, PRO-087, PRO-088). Pages:
 * `embed.html` (the element from source with the test hooks and the in-memory backend) and
 * `lib.html` (the library build, loaded by URL as a host loads it).
 */
import { type Page, expect, test } from '@playwright/test';
import { EMBEDDING_VERSION, RELEASE } from '../src/version.ts';
import {
  bodyText,
  clickToolbarCommand,
  events,
  mountEditor,
  openEmbed,
  openLib,
  selectionSynced,
} from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;

test.describe('FE-001 registration', () => {
  test('importing the library registers doc-editor with the exported class', async ({ page }) => {
    await openLib(page);
    const r = await page.evaluate(async () => {
      const lib = (window as unknown as { __lib: { load(): Promise<Record<string, unknown>> } })
        .__lib;
      const mod = await lib.load();
      const C = mod['DocEditorElement'] as CustomElementConstructor & {
        version: string;
        release: string;
      };
      return {
        same: customElements.get('doc-editor') === C,
        extendsHTMLElement: Object.getPrototypeOf(C) === HTMLElement,
        version: C.version,
        release: C.release,
      };
    });
    expect(r).toEqual({
      same: true,
      extendsHTMLElement: true,
      version: EMBEDDING_VERSION,
      release: RELEASE,
    });
  });

  test('another version under doc-editor: one warning naming both, the other stays', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await openLib(page);
    const kept = await page.evaluate(async () => {
      const lib = (
        window as unknown as {
          __lib: { defineFake(v: string, r: string): void; load(): Promise<unknown> };
        }
      ).__lib;
      lib.defineFake('9.9', '9.9.9-other');
      const fake = customElements.get('doc-editor');
      await lib.load();
      return customElements.get('doc-editor') === fake;
    });
    expect(kept).toBe(true);
    const ours = warnings.filter((w) => w.includes('<doc-editor>'));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContain('embedding API 9.9, release 9.9.9-other');
    expect(ours[0]).toContain(`embedding API ${EMBEDDING_VERSION}, release ${RELEASE}`);
  });

  test('the same version under doc-editor: no warning, no error', async ({ page }) => {
    const warnings: string[] = [];
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await openLib(page);
    await page.evaluate(
      async ({ v, r }) => {
        const lib = (
          window as unknown as {
            __lib: { defineFake(v: string, r: string): void; load(): Promise<unknown> };
          }
        ).__lib;
        lib.defineFake(v, r);
        await lib.load();
      },
      { v: EMBEDDING_VERSION, r: RELEASE },
    );
    expect(warnings.filter((w) => w.includes('<doc-editor>'))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('under another tag name and in a scoped registry the element mounts and edits', async ({
    page,
  }) => {
    await openLib(page);
    const typed = await page.evaluate(async () => {
      const lib = (
        window as unknown as {
          __lib: {
            load(): Promise<Record<string, unknown>>;
            backend(s: string): unknown;
            docId: string;
          };
        }
      ).__lib;
      const mod = await lib.load();
      const define = mod['defineDocEditor'] as (name: string, registry?: unknown) => string;
      const result = define('my-editor');
      const el = document.createElement('my-editor') as HTMLElement & { backend: unknown };
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      el.backend = lib.backend('ada');
      el.setAttribute('doc-id', lib.docId);
      document.getElementById('mount')!.append(el);
      await ready;
      return { result, mounted: !!el.shadowRoot?.querySelector('.de-editing-surface') };
    });
    expect(typed).toEqual({ result: 'defined', mounted: true });
    await page.locator('my-editor .de-editing-surface p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed');
    await expect(page.locator('my-editor .de-editing-surface')).toContainText('typed');

    const scoped = await page.evaluate(async () => {
      const G = globalThis as unknown as { CustomElementRegistry: new () => CustomElementRegistry };
      let registry: CustomElementRegistry;
      try {
        registry = new G.CustomElementRegistry();
      } catch {
        return 'unsupported';
      }
      const lib = (
        window as unknown as {
          __lib: {
            load(): Promise<Record<string, unknown>>;
            backend(s: string): unknown;
            docId: string;
          };
        }
      ).__lib;
      const mod = await lib.load();
      (mod['defineDocEditor'] as (n: string, r: unknown) => string)('doc-editor', registry);
      const host = document.createElement('div');
      document.body.append(host);
      const root = host.attachShadow({
        mode: 'open',
        customElementRegistry: registry,
      } as ShadowRootInit);
      const create = (root as unknown as { createElement?: (n: string) => HTMLElement })
        .createElement;
      const el = (
        create
          ? create.call(root, 'doc-editor')
          : document.createElement('doc-editor', {
              customElementRegistry: registry,
            } as ElementCreationOptions)
      ) as HTMLElement & {
        backend: unknown;
      };
      if (!('backend' in el)) return 'not upgraded';
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      el.backend = lib.backend('ada');
      el.setAttribute('doc-id', lib.docId);
      root.append(el);
      await ready;
      return el.shadowRoot?.querySelector('.de-editing-surface') ? 'mounted' : 'empty';
    });
    test.skip(
      scoped === 'unsupported' || scoped === 'not upgraded',
      `scoped registries: ${scoped}`,
    );
    expect(scoped).toBe('mounted');
  });
});

test.describe('FE-002 lazy chunks of the library build', () => {
  test('opening a document loads the entry and the editor only; chunks resolve from the module', async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    await openLib(page);
    await page.evaluate(async () => {
      const lib = (
        window as unknown as {
          __lib: { load(): Promise<unknown>; backend(s: string): unknown; docId: string };
        }
      ).__lib;
      await lib.load();
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      el.backend = lib.backend('ada');
      el.setAttribute('doc-id', lib.docId);
      document.getElementById('mount')!.append(el);
      await ready;
    });
    const lib = requested.filter((p) => p.startsWith('/lib/'));
    expect(lib.some((p) => p === '/lib/doc-editor.js')).toBe(true);
    expect(lib.some((p) => /^\/lib\/chunks\/editor-[\w-]+\.js$/.test(p))).toBe(true);
    // No pane, no PDF viewer, no viewer frame, no DEP client (a backend was passed).
    expect(lib.filter((p) => /OutlinePane|viewer|dep-client|pdf/.test(p))).toEqual([]);
    // Every chunk came from the module's own directory.
    expect(
      lib.every((p) => p.startsWith('/lib/doc-editor.js') || p.startsWith('/lib/chunks/')),
    ).toBe(true);
    // A pane loads on demand.
    await clickToolbarCommand(page, 'outline');
    await expect
      .poll(() => requested.some((p) => /\/lib\/chunks\/OutlinePane-/.test(p)))
      .toBe(true);
  });

  test('no custom element of the project is nested inside the editor', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page);
    const tags = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!.shadowRoot!;
      return [
        ...new Set(
          [...root.querySelectorAll('*')].map((e) => e.localName).filter((n) => n.includes('-')),
        ),
      ];
    }, editor());
    expect(tags).toEqual([]);
  });
});

test.describe('FE-003 loading when everything is set, in any order', () => {
  test('properties set before the class is defined are captured and do not shadow the accessors', async ({
    page,
  }) => {
    await openLib(page);
    const r = await page.evaluate(async () => {
      const lib = (
        window as unknown as {
          __lib: { load(): Promise<unknown>; backend(s: string): unknown; docId: string };
        }
      ).__lib;
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      const values = {
        backend: lib.backend('ada'),
        getToken: async () => 'unused',
        config: { graceMs: 1234 },
        searchPrincipals: async () => [],
        resolveUsers: async (ids: string[]) => ids.map(() => null),
        extensions: [{ id: 'x' }],
      };
      Object.assign(el, values);
      el.setAttribute('doc-id', lib.docId);
      const ready = new Promise((resolve) =>
        el.addEventListener('de-ready', resolve, { once: true }),
      );
      document.getElementById('mount')!.append(el);
      await lib.load();
      await ready;
      const keys = Object.keys(values);
      return {
        own: keys.filter((k) => Object.prototype.hasOwnProperty.call(el, k)),
        same: keys.filter((k) => k !== 'extensions' && el[k] === values[k as keyof typeof values]),
        extensions: JSON.stringify(el['extensions']),
        root: el.shadowRoot?.mode,
      };
    });
    expect(r).toEqual({
      own: [],
      same: ['backend', 'getToken', 'config', 'searchPrincipals', 'resolveUsers'],
      extensions: '[{"id":"x"}]',
      root: 'open',
    });
  });

  for (const order of [
    ['doc-id', 'backend', 'connect'],
    ['backend', 'doc-id', 'connect'],
    ['connect', 'doc-id', 'backend'],
    ['connect', 'backend', 'doc-id'],
    ['doc-id', 'connect', 'backend'],
    ['backend', 'connect', 'doc-id'],
    ['doc-id', 'getToken', 'connect'],
    ['getToken', 'connect', 'doc-id'],
    ['connect', 'getToken', 'doc-id'],
  ]) {
    test(`loads once, in a microtask, in the order ${order.join(' → ')}`, async ({ page }) => {
      await openEmbed(page);
      const r = await page.evaluate(async (steps) => {
        const e = (window as unknown as { __embed: Record<string, unknown> })
          .__embed as unknown as {
          backend(s: string): { connect(): Promise<void> };
          issueToken(s: string): string;
          useEndpoint(): void;
          endpointCalls: unknown[];
          docId: string;
        };
        e.useEndpoint();
        let connects = 0;
        const backend = e.backend('ada');
        const connect = backend.connect.bind(backend);
        backend.connect = () => {
          connects++;
          return connect();
        };
        const token = e.issueToken('ada');
        const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
        el.setAttribute('endpoint', 'https://docs.example.test');
        let ready = 0;
        el.addEventListener('de-ready', () => ready++);
        for (const step of steps) {
          if (step === 'doc-id') el.setAttribute('doc-id', e.docId);
          if (step === 'backend') el['backend'] = backend;
          if (step === 'getToken') el['getToken'] = async () => token;
          if (step === 'connect') document.getElementById('mount')!.append(el);
        }
        const synchronous = connects + e.endpointCalls.length;
        // Wait for the first load to reach de-ready (Firefox and WebKit take longer than 400 ms),
        // then a quiet period in which a second start would show (FE-124 criterion 6).
        const until = Date.now() + 15_000;
        while (ready === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 400));
        return { synchronous, starts: connects + e.endpointCalls.length, ready };
      }, order);
      expect(r).toEqual({ synchronous: 0, starts: 1, ready: 1 });
    });
  }

  test('with only one of the two, nothing is requested and nothing is raised', async ({ page }) => {
    await openEmbed(page);
    const r = await page.evaluate(async () => {
      const e = (
        window as unknown as {
          __embed: { backend(s: string): { connect(): Promise<void> }; docId: string };
        }
      ).__embed;
      const seen: string[] = [];
      const onlyId = document.createElement('doc-editor');
      onlyId.setAttribute('doc-id', e.docId);
      const onlyBackend = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
      };
      const backend = e.backend('ada');
      let connects = 0;
      backend.connect = async () => {
        connects++;
      };
      onlyBackend.backend = backend;
      for (const el of [onlyId, onlyBackend]) {
        for (const n of ['de-ready', 'de-error', 'de-auth-required', 'de-status'])
          el.addEventListener(n, () => seen.push(n));
        document.getElementById('mount')!.append(el);
      }
      await new Promise((r) => setTimeout(r, 400));
      return { seen, connects };
    });
    expect(r).toEqual({ seen: [], connects: 0 });
  });

  test('attribute changes reach the mounted shell without a remount; doc-id loads the other document', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    const r = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const root = el.shadowRoot!;
      const shell = root.querySelector('.de-shell');
      const surface = root.querySelector('.ProseMirror');
      el.setAttribute('toolbar', 'full');
      el.setAttribute('locale', 'ar-XB');
      el.setAttribute('theme', 'dark');
      el.setAttribute('mode', 'view');
      await new Promise((r) => setTimeout(r, 300));
      return {
        sameShell: root.querySelector('.de-shell') === shell,
        sameSurface: root.querySelector('.ProseMirror') === surface,
        shellDirection: getComputedStyle(root.querySelector('.de-shell')!).direction,
        surfaceDirection: getComputedStyle(root.querySelector('.de-editing-surface')!).direction,
      };
    }, editor());
    expect(r).toEqual({
      sameShell: true,
      sameSurface: true,
      shellDirection: 'rtl',
      surfaceDirection: 'ltr',
    });
    const second = await page.evaluate(async (sel) => {
      const e = (window as unknown as { __embed: { secondDocId: string } }).__embed;
      const el = document.querySelector(sel) as HTMLElement;
      const ready = new Promise<CustomEvent>((r) =>
        el.addEventListener('de-ready', (ev) => r(ev as CustomEvent), { once: true }),
      );
      el.setAttribute('doc-id', e.secondDocId);
      return { detail: (await ready).detail, expected: e.secondDocId };
    }, editor());
    expect(second.detail).toEqual({ docId: second.expected, seq: 0 });
  });
});

test.describe('FE-004 mount once, resume on later connects', () => {
  test('one shell and one core; a move keeps both; destroy empties the root', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page);
    const r = await page.evaluate(async (sel) => {
      const e = (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { core: object } | null; suspended: boolean };
          };
        }
      ).__embed;
      const el = document.querySelector(sel) as HTMLElement & { destroy(): void };
      const root = el.shadowRoot!;
      const core = e.internals(el).editor!.core;
      const shell = root.querySelector('.de-shell');
      let ready = 0;
      el.addEventListener('de-ready', () => ready++);
      document.getElementById('mount-2')!.append(el); // disconnect and reconnect in one task
      await new Promise((r) => setTimeout(r, 100));
      const afterMove = {
        sameCore: e.internals(el).editor?.core === core,
        sameShell: root.querySelector('.de-shell') === shell,
        shells: root.querySelectorAll('.de-shell').length,
        surfaces: root.querySelectorAll('.ProseMirror').length,
        suspended: e.internals(el).suspended,
        ready,
      };
      el.destroy();
      await new Promise((r) => setTimeout(r, 50));
      return {
        afterMove,
        afterDestroy: { children: root.childElementCount, editor: e.internals(el).editor },
      };
    }, editor());
    expect(r).toEqual({
      afterMove: {
        sameCore: true,
        sameShell: true,
        shells: 1,
        surfaces: 1,
        suspended: false,
        ready: 0,
      },
      afterDestroy: { children: 0, editor: null },
    });
  });

  test('two instances have their own cores and share one constructable stylesheet (FE-014)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    const r = await page.evaluate(() => {
      const e = (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { core: object; stylePath: string } | null };
          };
        }
      ).__embed;
      const [a, b] = [...document.querySelectorAll('doc-editor')] as HTMLElement[];
      const ra = a!.shadowRoot!;
      const rb = b!.shadowRoot!;
      return {
        sheets: [ra.adoptedStyleSheets.length, rb.adoptedStyleSheets.length],
        sameSheet: ra.adoptedStyleSheets[0] === rb.adoptedStyleSheets[0],
        styleElements: ra.querySelectorAll('style').length + rb.querySelectorAll('style').length,
        cores: e.internals(a!).editor!.core !== e.internals(b!).editor!.core,
        paths: [e.internals(a!).editor!.stylePath, e.internals(b!).editor!.stylePath],
      };
    });
    expect(r).toEqual({
      sheets: [1, 1],
      sameSheet: true,
      styleElements: 0,
      cores: true,
      paths: ['adopted', 'adopted'],
    });
  });
});

test.describe('FE-013 shadow root and focus', () => {
  test('a click on the page surface focuses the editing surface; focus() restores the selection', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    const root = page.locator(editor());
    // The page surface outside the text: its top left padding.
    await root.locator('.de-page').click({ position: { x: 4, y: 4 } });
    const focused = () =>
      page.evaluate((sel) => {
        const a = document.querySelector(sel)!.shadowRoot!.activeElement as HTMLElement | null;
        return a ? `${a.localName}.${a.className}` : null;
      }, editor());
    await expect.poll(focused).toContain('de-editing-surface');
    // Put the caret after "Last", leave to the host page, come back with focus().
    await root.locator('.de-editing-surface p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    // ProseMirror reads the caret's moves on `selectionchange`, in later tasks: let it catch up.
    await page.waitForTimeout(200);
    await page.locator('#host-input').focus();
    await expect.poll(focused).toBeNull();
    await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).focus(), editor());
    await expect.poll(focused).toContain('de-editing-surface');
    await page.keyboard.type('X');
    await expect(root.locator('.de-editing-surface')).toContainText('LastX paragraph.');
  });
});

test.describe('FE-018 style isolation, --de- properties and parts', () => {
  test('broad host selectors and inherited host properties change nothing inside', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    const probe = (sel: string) =>
      page.evaluate((s) => {
        const root = document.querySelector(s)!.shadowRoot!;
        const pick = (q: string) => {
          const el = root.querySelector(q);
          if (!el) return `missing ${q}`;
          const c = getComputedStyle(el);
          return [
            c.color,
            c.fontFamily,
            c.lineHeight,
            c.direction,
            c.textAlign,
            c.margin,
            c.padding,
            c.display,
            c.backgroundColor,
          ].join('|');
        };
        return [
          '.de-shell',
          '.de-toolbar button',
          '.de-page',
          '.de-editing-surface p',
          '.de-defs',
        ].map(pick);
      }, sel);
    const before = await probe(editor());
    const sheetsBefore = await page.evaluate(() => [
      document.styleSheets.length,
      document.adoptedStyleSheets.length,
    ]);
    await page.addStyleTag({
      content: `* { color: rgb(255, 0, 0) !important; font-family: fantasy !important; line-height: 3 !important; }
        button { background: rgb(255, 0, 0) !important; } p { margin: 50px !important; } div { padding: 30px !important; }
        [hidden] { display: block !important; }
        main { direction: rtl; text-align: right; }`,
    });
    expect(await probe(editor())).toEqual(before);
    // The module itself added no rule to the host page (the test added one sheet).
    expect(sheetsBefore).toEqual([0, 0]);
  });

  test('--de- properties set on the element or an ancestor reach the editor', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page);
    const read = () =>
      page.evaluate((s) => {
        const root = document.querySelector(s)!.shadowRoot!;
        return {
          font: getComputedStyle(root.querySelector('.de-editing-surface')!).fontFamily,
          region: getComputedStyle(root.querySelector('.de-region')!).borderInlineStartColor,
          border: getComputedStyle(root.querySelector('.de-toolbar')!).borderBlockEndColor,
        };
      }, editor());
    await page.evaluate(() => {
      document.body.style.setProperty('--de-font-document', 'monospace');
      document.body.style.setProperty('--de-region', 'rgb(1, 2, 3)');
      document.body.style.setProperty('--de-border', 'rgb(4, 5, 6)');
    });
    expect(await read()).toEqual({
      font: 'monospace',
      region: 'rgb(1, 2, 3)',
      border: 'rgb(4, 5, 6)',
    });
    await page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement;
      el.style.setProperty('--de-region', 'rgb(7, 8, 9)');
      el.style.setProperty('--de-border', 'rgb(10, 11, 12)');
    }, editor());
    expect(await read()).toMatchObject({ region: 'rgb(7, 8, 9)', border: 'rgb(10, 11, 12)' });
  });

  test('::part() styles the documented parts and nothing else is exposed', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page);
    const parts = await page.evaluate((s) => {
      const root = document.querySelector(s)!.shadowRoot!;
      return [
        ...new Set(
          [...root.querySelectorAll('[part]')].flatMap((e) => e.getAttribute('part')!.split(/\s+/)),
        ),
      ].sort();
    }, editor());
    const allowed = ['dialog', 'header', 'page', 'ruler', 'sidebar', 'statusbar', 'toolbar'];
    expect(parts.filter((p) => !allowed.includes(p))).toEqual([]);
    await page.addStyleTag({
      content: `doc-editor::part(toolbar) { outline: 3px solid rgb(4, 5, 6); }
        doc-editor::part(page) { outline: 3px solid rgb(7, 8, 9); }
        doc-editor::part(bogus) { outline: 3px solid rgb(1, 1, 1); }`,
    });
    const outlines = await page.evaluate((s) => {
      const root = document.querySelector(s)!.shadowRoot!;
      return ['[part~="toolbar"]', '[part~="page"]', '.de-editing-surface'].map(
        (q) => getComputedStyle(root.querySelector(q)!).outlineColor,
      );
    }, editor());
    expect(outlines[0]).toBe('rgb(4, 5, 6)');
    expect(outlines[1]).toBe('rgb(7, 8, 9)');
    expect(outlines[2]).not.toBe('rgb(1, 1, 1)');
  });
});

test.describe('FE-021 shortcuts only from inside the editor; FE-025 order', () => {
  const boldOf = (page: Page, name = 'one') =>
    page.evaluate(async (n) => {
      const el = document.querySelector(`doc-editor[data-test="${n}"]`)!;
      const e = (
        window as unknown as { __embed: { harness(el: Element): Promise<{ doc(): unknown }> } }
      ).__embed;
      return JSON.stringify((await e.harness(el)).doc()).split('"bold"').length - 1;
    }, name);

  test('host input: no command runs and the event is not cancelled', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page);
    const before = await boldOf(page);
    await page.evaluate(() => {
      (window as unknown as { cancelled: boolean[] }).cancelled = [];
      document.addEventListener('keydown', (e) =>
        (window as unknown as { cancelled: boolean[] }).cancelled.push(e.defaultPrevented),
      );
    });
    await page.locator('#host-input').focus();
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.type('abc');
    expect(await boldOf(page)).toBe(before);
    expect(await page.locator('#host-input').inputValue()).toBe('abc');
    expect(
      await page.evaluate(() => (window as unknown as { cancelled: boolean[] }).cancelled[0]),
    ).toBe(false);
  });

  test('editing surface, footnote sub-editor and toolbar: the command runs once', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    const before = await boldOf(page);
    // The surface: the core's keymap handles it and the shell's listener skips it (FE-025: core first).
    await page
      .locator(`${editor()} .de-editing-surface p`, { hasText: 'Last paragraph.' })
      .dblclick({ position: { x: 5, y: 5 } });
    await selectionSynced(page);
    await page.keyboard.press('ControlOrMeta+b');
    await expect.poll(() => boldOf(page)).toBe(before + 1);
    // The toolbar: focus on a button, the shell routes the shortcut to the same command.
    await page.locator(`${editor()} [data-command="italic"]`).focus();
    await page.keyboard.press('ControlOrMeta+b');
    await expect.poll(() => boldOf(page)).toBe(before);
    // The footnote sub-editor.
    await page.evaluate(async (sel) => {
      const e = (
        window as unknown as {
          __embed: {
            harness(el: Element): Promise<{ openFootnote(id: string): void }>;
            SPIKE_IDS: { footnote: string };
          };
        }
      ).__embed;
      (await e.harness(document.querySelector(sel)!)).openFootnote(e.SPIKE_IDS.footnote);
    }, editor());
    const sub = page.locator(`${editor()} .de-sub-editor`);
    await sub.waitFor();
    await sub.click();
    await page.keyboard.press('ControlOrMeta+a');
    // ProseMirror reads a native selection change on `selectionchange`, in a later task (S1 §4.2).
    await page.waitForTimeout(150);
    await page.keyboard.press('ControlOrMeta+b');
    await expect.poll(() => boldOf(page)).toBe(before + 1);
  });

  test('two instances: a shortcut acts in the one the key event came from', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2', doc: 'second' });
    const [one, two] = [await boldOf(page, 'one'), await boldOf(page, 'two')];
    await page
      .locator(`${editor('one')} .de-editing-surface p`, { hasText: 'Last paragraph.' })
      .dblclick({ position: { x: 5, y: 5 } });
    await selectionSynced(page, 'one');
    await page.keyboard.press('ControlOrMeta+b');
    await expect.poll(() => boldOf(page, 'one')).toBe(one + 1);
    expect(await boldOf(page, 'two')).toBe(two);
    // The composed path decides, not document.activeElement: a key event dispatched at the second
    // editor's surface while focus is in the first acts in the second.
    await page.evaluate(async () => {
      const el = document.querySelector('doc-editor[data-test="two"]')!;
      const e = (
        window as unknown as {
          __embed: {
            harness(
              el: Element,
            ): Promise<{ selectText(t: string, o?: number, l?: number): number }>;
          };
        }
      ).__embed;
      (await e.harness(el)).selectText('Last paragraph.', 0, 4);
      const mac = /mac/i.test(navigator.platform);
      el.shadowRoot!.querySelector('.ProseMirror')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          code: 'KeyB',
          ctrlKey: !mac,
          metaKey: mac,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    });
    await expect.poll(() => boldOf(page, 'two')).toBe(two + 1);
    expect(await boldOf(page, 'one')).toBe(one + 1);
  });
});

test.describe('FE-022, PRO-087 events', () => {
  test('every event is a composed, bubbling CustomEvent with the element as target, and carries no content or token', async ({
    page,
  }) => {
    await openEmbed(page);
    const token = await page.evaluate(() => {
      const e = (
        window as unknown as { __embed: { useEndpoint(): void; issueToken(s: string): string } }
      ).__embed;
      e.useEndpoint();
      return e.issueToken('ada');
    });
    await page.evaluate(async (t) => {
      const e = (
        window as unknown as {
          __embed: { docId: string; service: { setGrants(d: string, g: unknown[]): void } };
        }
      ).__embed;
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      el.dataset['test'] = 'one';
      const onElement: string[] = [];
      for (const n of ['de-ready', 'de-status', 'de-permission-change'])
        el.addEventListener(n, () => onElement.push(n));
      (window as unknown as { onElement: string[] }).onElement = onElement;
      el.setAttribute('endpoint', 'https://docs.example.test');
      el['getToken'] = async () => t;
      el.setAttribute('doc-id', e.docId);
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      document.getElementById('mount')!.append(el);
      await ready;
      e.service.setGrants(e.docId, []);
    }, token);
    await page.locator(`${editor()} .de-editing-surface p`, { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' and more');
    await expect.poll(async () => (await events(page, 'de-change')).length).toBeGreaterThan(0);
    const all = await events(page);
    const names = new Set(all.map((e) => e.name));
    for (const n of ['de-ready', 'de-status', 'de-permission-change', 'de-change'])
      expect(names.has(n), n).toBe(true);
    for (const e of all) {
      expect(e.name).toMatch(/^de-/);
      expect([e.composed, e.bubbles, e.target]).toEqual([true, true, 'doc-editor']);
    }
    const onElement = await page.evaluate(
      () => (window as unknown as { onElement: string[] }).onElement,
    );
    expect(onElement).toEqual(
      expect.arrayContaining(['de-ready', 'de-status', 'de-permission-change']),
    );
    const text = await page.evaluate(
      () => (window as unknown as { __embed: { docText: string[] } }).__embed.docText,
    );
    const serialised = JSON.stringify(all.map((e) => e.detail));
    for (const t of [...text, 'and more', token]) expect(serialised).not.toContain(t);
    const ready = all.find((e) => e.name === 'de-ready')!.detail as { docId: string; seq: number };
    expect(Object.keys(ready).sort()).toEqual(['docId', 'seq']);
    const status = all.filter((e) => e.name === 'de-status').map((e) => e.detail);
    expect(status[0]).toEqual({ connection: 'online', sync: 'saved' });
    expect(status).toContainEqual({ connection: 'online', sync: 'saving' });
    // de-change is debounced: far fewer events than keystrokes, ending at the confirmed seq.
    const changes = all
      .filter((e) => e.name === 'de-change')
      .map((e) => (e.detail as { seq: number }).seq);
    expect(changes.length).toBeLessThan(' and more'.length);
    expect([...changes].sort((a, b) => a - b)).toEqual(changes);
  });
});

test.describe('PRO-074, PRO-075, PRO-076, PRO-088 embedding API', () => {
  test('PRO-074: forbidden and not_found end in de-error; an unreachable endpoint in unavailable', async ({
    page,
  }) => {
    await openEmbed(page);
    const r = await page.evaluate(async () => {
      const e = (
        window as unknown as {
          __embed: { backend(s: string, role: string, docs: string[]): unknown; docId: string };
        }
      ).__embed;
      const run = (setup: (el: HTMLElement & Record<string, unknown>) => void) =>
        new Promise<unknown>((resolve) => {
          const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
          el.addEventListener('de-error', (ev) => resolve((ev as CustomEvent).detail), {
            once: true,
          });
          el.addEventListener('de-ready', () => resolve('ready'), { once: true });
          setup(el);
          document.getElementById('mount')!.append(el);
        });
      const ghost = '0192f0c4-7b1e-7c3a-9a54-00000000beef';
      return {
        forbidden: await run((el) => {
          el['backend'] = e.backend('ada', 'editor', [e.docId]);
          el.setAttribute('doc-id', ghost);
        }),
        notFound: await run((el) => {
          el['backend'] = e.backend('ada', 'editor', [ghost]);
          el.setAttribute('doc-id', ghost);
        }),
        // The real DEP client (packages/backend-dep), pointed at a port where nothing listens.
        unavailable: await run((el) => {
          el.setAttribute('endpoint', 'http://127.0.0.1:9/');
          el['getToken'] = async () => 'token';
          el.setAttribute('doc-id', e.docId);
        }),
      };
    });
    expect(r).toMatchObject({
      forbidden: { code: 'forbidden', fatal: true },
      notFound: { code: 'not_found', fatal: true },
      unavailable: { code: 'unavailable', fatal: true },
    });
  });

  test('PRO-074: with a backend, endpoint is ignored and no DEP client is made', async ({
    page,
  }) => {
    await openEmbed(page);
    await page.evaluate(() =>
      (window as unknown as { __embed: { useEndpoint(): void } }).__embed.useEndpoint(),
    );
    await page.evaluate(() => {
      const holder = document.getElementById('mount')!;
      holder.dataset['endpointProbe'] = '1';
    });
    await page.evaluate(async () => {
      const e = (window as unknown as { __embed: { backend(s: string): unknown; docId: string } })
        .__embed;
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      el.setAttribute('endpoint', 'https://docs.example.test');
      el['getToken'] = async () => 'never used';
      el['backend'] = e.backend('ada');
      el.setAttribute('doc-id', e.docId);
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      document.getElementById('mount')!.append(el);
      await ready;
    });
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __embed: { endpointCalls: unknown[] } }).__embed.endpointCalls,
      ),
    ).toEqual([]);
  });

  test('PRO-075: getToken is called with { docId }; a failing token source raises de-auth-required without the token', async ({
    page,
  }) => {
    const logged: string[] = [];
    page.on('console', (m) => logged.push(m.text()));
    await openEmbed(page);
    const r = await page.evaluate(async () => {
      const e = (
        window as unknown as {
          __embed: { useEndpoint(): void; issueToken(s: string): string; docId: string };
        }
      ).__embed;
      e.useEndpoint();
      const token = e.issueToken('ada');
      const calls: unknown[] = [];
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      el.setAttribute('endpoint', 'https://docs.example.test');
      el['getToken'] = async (ctx: unknown) => {
        calls.push(ctx);
        return token;
      };
      el.setAttribute('doc-id', e.docId);
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      document.getElementById('mount')!.append(el);
      await ready;
      const failing = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      const auth = new Promise<unknown>((r) =>
        failing.addEventListener('de-auth-required', (ev) => r((ev as CustomEvent).detail), {
          once: true,
        }),
      );
      failing.setAttribute('endpoint', 'https://docs.example.test');
      failing['getToken'] = async () => {
        throw new Error('the host signed the user out');
      };
      failing.setAttribute('doc-id', e.docId);
      document.getElementById('mount-2')!.append(failing);
      const stores = JSON.stringify([
        { ...localStorage },
        { ...sessionStorage },
        document.cookie,
        location.href,
        'databases' in indexedDB ? await indexedDB.databases() : [],
      ]);
      return { calls, auth: await auth, docId: e.docId, token, leaked: stores.includes(token) };
    });
    expect(r.calls).toEqual([{ docId: r.docId }]);
    expect(r.auth).toEqual({ docId: r.docId, code: 'unauthenticated' });
    expect(JSON.stringify(r.auth)).not.toContain(r.token);
    expect(r.leaked).toBe(false);
    // Nor in the console (10 §3.1: not in logs).
    expect(logged.filter((l) => l.includes(r.token))).toEqual([]);
  });

  test('PRO-076: load(docId), load(), focus(), destroy() and the static version', async ({
    page,
  }) => {
    await openLib(page);
    const version = await page.evaluate(async () => {
      const lib = (
        window as unknown as { __lib: { load(): Promise<Record<string, { version: string }>> } }
      ).__lib;
      return (await lib.load())['DocEditorElement']!.version;
    });
    expect(version).toBe(EMBEDDING_VERSION);
    await openEmbed(page);
    await mountEditor(page);
    const r = await page.evaluate(async (sel) => {
      const e = (
        window as unknown as {
          __embed: {
            secondDocId: string;
            docId: string;
            service: { setGrants(d: string, g: unknown[]): void };
            internals(el: Element): { graceScheduled: boolean; session: unknown };
          };
        }
      ).__embed;
      const el = document.querySelector(sel) as HTMLElement & {
        load(id?: string): void;
        destroy(): void;
      };
      const next = () =>
        new Promise<unknown>((r) =>
          el.addEventListener('de-ready', (ev) => r((ev as CustomEvent).detail), { once: true }),
        );
      let p = next();
      el.load(e.secondDocId);
      const other = await p;
      p = next();
      el.load();
      const reloaded = await p;
      el.focus();
      const focused = el.shadowRoot!.activeElement?.classList.contains('de-editing-surface');
      document.getElementById('mount-2')!.append(el);
      el.remove(); // disconnected: a grace timer starts after one microtask
      await new Promise((r) => setTimeout(r, 20));
      const grace = e.internals(el).graceScheduled;
      document.getElementById('mount')!.append(el);
      const after: string[] = [];
      for (const n of ['de-ready', 'de-status', 'de-permission-change', 'de-error', 'de-change'])
        el.addEventListener(n, () => after.push(n));
      el.destroy();
      e.service.setGrants(e.secondDocId, []);
      await new Promise((r) => setTimeout(r, 300));
      return {
        other,
        reloaded,
        focused,
        grace,
        after,
        timer: e.internals(el).graceScheduled,
        session: e.internals(el).session,
      };
    }, editor());
    expect(r.other).toEqual({ docId: expect.any(String), seq: 0 });
    expect(r.reloaded).toEqual(r.other);
    expect([r.focused, r.grace, r.after, r.timer, r.session]).toEqual([
      true,
      true,
      [],
      false,
      null,
    ]);
  });

  test('PRO-088: de-permission-change on open and once per perm.changed, without a reload', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { sub: 'bob' });
    // The owner's grant changes, made through the service as a host's back end would.
    const grant = (grants: unknown[]) =>
      page.evaluate((g) => {
        const e = (
          window as unknown as {
            __embed: {
              docId: string;
              SPIKE_IDS: { region: string };
              service: { setGrants(d: string, g: unknown[]): void };
            };
          }
        ).__embed;
        e.service.setGrants(
          e.docId,
          g.map((x) => ({ ...(x as object), region: e.SPIKE_IDS.region })),
        );
      }, grants);
    await grant([{ principal: 'user:bob', role: 'editor' }]);
    await expect.poll(async () => (await events(page, 'de-permission-change')).length).toBe(2);
    await grant([]);
    await expect.poll(async () => (await events(page, 'de-permission-change')).length).toBe(3);
    const changes = (await events(page, 'de-permission-change')).map(
      (e) => e.detail as { rev: number; scopes: Record<string, string[]> },
    );
    const region = await page.evaluate(
      () =>
        (window as unknown as { __embed: { SPIKE_IDS: { region: string } } }).__embed.SPIKE_IDS
          .region,
    );
    expect(changes.map((c) => c.scopes[`region:${region}`]?.includes('edit'))).toEqual([
      false,
      true,
      false,
    ]);
    expect(new Set(changes.map((c) => c.rev)).size).toBe(3);
  });
});

test.describe('PRO-083, PRO-084, PRO-085 the element methods on the mounted editor', () => {
  type Methods = HTMLElement & {
    getContent(): Promise<{ seq: number; cdm: number; doc: unknown }>;
    flush(opts?: { timeoutMs?: number }): Promise<void>;
    exec(command: string): { ok: boolean; reason: string | null };
    queryCommand(command: string): { enabled: boolean; active: boolean };
  };

  test('getContent, queryCommand, exec and flush reach the core of the mounted editor', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'victor', role: 'viewer', target: 'mount-2' });
    const loaded = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as Methods;
      const c = await el.getContent();
      return { seq: c.seq, cdm: c.cdm, text: JSON.stringify(c.doc) };
    }, editor('one'));
    expect(loaded.seq).toBe(0);
    expect(loaded.cdm).toEqual(expect.any(Number));
    expect(loaded.text).toContain('Last paragraph.');

    const one = page.locator(`${editor('one')} .de-editing-surface`);
    await one.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    const commands = await page.evaluate(
      ({ a, b }) => {
        const one = document.querySelector(a) as Methods;
        const two = document.querySelector(b) as Methods;
        const before = one.queryCommand('bold');
        const ran = one.exec('bold');
        return {
          before,
          ran,
          after: one.queryCommand('bold'),
          viewer: two.queryCommand('bold'),
          viewerRan: two.exec('bold'),
        };
      },
      { a: editor('one'), b: editor('two') },
    );
    expect(commands).toEqual({
      before: { enabled: true, active: false },
      ran: { ok: true, reason: null },
      after: { enabled: true, active: true },
      viewer: { enabled: false, active: false },
      viewerRan: { ok: false, reason: 'no-access' },
    });

    await page.keyboard.type(' Typed');
    const saved = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as Methods;
      await el.flush({ timeoutMs: 10_000 });
      const c = await el.getContent();
      return { seq: c.seq, text: JSON.stringify(c.doc) };
    }, editor('one'));
    expect(saved.seq).toBeGreaterThan(loaded.seq);
    expect(saved.text).toContain('Typed');
  });
});

test.describe('PRO-080 people through the host directory', () => {
  test('presence shows the host’s name for a peer; the host gets identifiers only; without a callback the service’s name stays', async ({
    page,
  }) => {
    await openEmbed(page);
    await page.evaluate(() => {
      (window as unknown as { asked: unknown[] }).asked = [];
    });
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="two"]') as HTMLElement & {
        resolveUsers: unknown;
      };
      el.resolveUsers = async (ids: readonly string[]) => {
        (window as unknown as { asked: unknown[] }).asked.push([...ids]);
        return ids.map((id) => ({ id, name: `Host name of ${id}` }));
      };
    });
    // Ada's selection is published as presence once she is in the document.
    await page
      .locator(`${editor('one')} .de-editing-surface p`, { hasText: 'Last paragraph.' })
      .click();
    const peer = page.locator(`${editor('two')} .de-person[data-user="ada"]`);
    await expect(peer).toContainText('Host name of ada');
    const asked = await page.evaluate(() => (window as unknown as { asked: unknown[] }).asked);
    expect(asked.length).toBeGreaterThan(0);
    for (const call of asked as string[][]) for (const id of call) expect(id).toMatch(/^[a-z]+$/);
    // Ada's own element has no resolveUsers: Bob shows with the name the service reported.
    await page
      .locator(`${editor('two')} .de-editing-surface p`, { hasText: 'Remote target paragraph.' })
      .click();
    await expect(page.locator(`${editor('one')} .de-person[data-user="bob"]`)).toContainText('Bob');
  });
});

test.describe('FE-007 save state', () => {
  const statusOf = (page: Page, name: string) =>
    page.evaluate((n) => {
      const e = (
        window as unknown as {
          __embed: { internals(el: Element): { editor: { status: { get(): unknown } } | null } };
        }
      ).__embed;
      return e
        .internals(document.querySelector(`doc-editor[data-test="${n}"]`)!)
        .editor!.status.get();
    }, name);

  test('saving while work is queued or in flight, saved when acknowledged; readonly for a viewer; offline after revocation', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'vic', role: 'viewer', target: 'mount-2' });
    expect(await statusOf(page, 'one')).toEqual({ connection: 'online', sync: 'saved' });
    // A local change, then the state read in the same task: the steps are queued (04 §8).
    const during = await page.evaluate(async () => {
      const e = (
        window as unknown as {
          __embed: {
            harness(
              el: Element,
            ): Promise<{ selectText(t: string, o?: number, l?: number): number }>;
            internals(el: Element): {
              editor: { core: { run(c: string): boolean }; status: { get(): unknown } } | null;
            };
          };
        }
      ).__embed;
      const el = document.querySelector('doc-editor[data-test="one"]')!;
      (await e.harness(el)).selectText('Last paragraph.', 0, 4);
      const editor = e.internals(el).editor!;
      editor.core.run('bold');
      return editor.status.get();
    });
    expect(during).toEqual({ connection: 'online', sync: 'saving' });
    await expect.poll(() => statusOf(page, 'one')).toEqual({ connection: 'online', sync: 'saved' });
    // The event follows the state a little later (WebKit read the list once between the two).
    await expect
      .poll(
        async () =>
          (await events(page, 'de-status')).filter((e) => e.element === 'one').at(-1)?.detail,
      )
      .toEqual({ connection: 'online', sync: 'saved' });
    expect(await statusOf(page, 'two')).toEqual({ connection: 'online', sync: 'readonly' });
    expect(
      (await events(page, 'de-status')).filter((e) => e.element === 'two').map((e) => e.detail),
    ).toEqual([{ connection: 'online', sync: 'readonly' }]);
    // The host revokes Ada's sessions: the connection goes offline; the save state is untouched.
    await page.evaluate(() =>
      (
        window as unknown as { __embed: { service: { revokeSessions(s: string): void } } }
      ).__embed.service.revokeSessions('ada'),
    );
    await expect
      .poll(async () => ((await statusOf(page, 'one')) as { connection: string }).connection)
      .toBe('offline');
    expect(((await statusOf(page, 'one')) as { sync: string }).sync).toBe('saved');
    await expect
      .poll(
        async () =>
          (await events(page, 'de-status')).filter((e) => e.element === 'one').at(-1)?.detail,
      )
      .toEqual({ connection: 'offline', sync: 'saved' });
    await expect
      .poll(async () =>
        (await events(page, 'de-auth-required')).map((e) => (e.detail as { code: string }).code),
      )
      .toContain('revoked');
  });
});

test.describe('FE-122 smoke', () => {
  test('types, selects, undoes; two sessions with different grants edit at once', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    const one = page.locator(`${editor('one')} .de-editing-surface`);
    // Type, select, undo.
    await one.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Ada');
    // Typing within 500 ms joins one undo step (prosemirror-history's newGroupDelay): wait past it.
    await page.waitForTimeout(700);
    await page.keyboard.press('Shift+Home');
    await page.keyboard.type('Replaced');
    await expect(one).toContainText('Replaced');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(one).toContainText('Last paragraph. Ada');
    // Ada may edit the restricted region (a grant); the other session sees her change.
    await one.locator('p', { hasText: 'Liability is limited to' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' (Ada)');
    await expect.poll(() => bodyText(page, 'two')).toContain('damages. (Ada)');
    // Bob has no grant on the region: his typing there is refused and the text stays.
    const two = page.locator(`${editor('two')} .de-editing-surface`);
    await two.locator('p', { hasText: 'Liability is limited to' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('Bob');
    await page.waitForTimeout(300);
    expect(await bodyText(page, 'one')).not.toContain('Bob');
    expect(await bodyText(page, 'two')).not.toContain('(Ada)Bob');
  });
});
