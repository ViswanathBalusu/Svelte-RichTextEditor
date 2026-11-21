/**
 * FE-005 criteria 3 and 4 (02 §2.1) in a browser, with the real core and shell on the embed page
 * (`pages/embed.html`, in-memory backend).
 *
 * The counters of FE-006 (`fe-006-counters.ts`) wrap the page's event targets, observers, timers,
 * workers and IndexedDB. Each test reads them before the element mounts, while it runs, while it is
 * suspended and after it has come back, so what the element holds at each moment is measured, not
 * assumed.
 *
 * What a suspended element may still hold (criterion 3 as reworded by owner decision 181):
 * - the `selectionchange` listener that the editing library puts on `document` for each view, until
 *   the view is destroyed;
 * - the delegated-event handlers that the UI framework puts on `document` at `mount`, until
 *   `unmount`: one function registered for several event types;
 * - the editing library's own observer of its editing surface (a `MutationObserver` on nodes inside
 *   the shadow root), which is part of the view that is kept;
 * - the open journal (IndexedDB) and the timer of the grace period.
 * Everything else is gone: the element's own listeners on `document`, `window`, the visual viewport
 * and the page's font set, the shell's observers and its colour-scheme listener, the layout worker,
 * a PDF viewer's frame document, and the channel.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-005-suspend-resume.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { FILTERED_BROWSERS, bodyText, mountEditor, openEmbed } from './embed-helpers.ts';
import {
  installCounters,
  readCounters,
  readListeners,
  type Held,
  type HeldListener,
} from './fe-006-counters.ts';
import { record } from './helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;

interface Reading {
  held: Held;
  listeners: HeldListener[];
}

async function read(page: Page): Promise<Reading> {
  return { held: await readCounters(page), listeners: await readListeners(page) };
}

/** What the page holds now and did not hold at `before`. */
interface Taken {
  /** Listeners that are not event delegation, as `target:type`, sorted. */
  own: string[];
  /** The event types of the delegated-event handlers on `document`. */
  delegation: string[];
  observers: string[];
  workers: number;
  timers: string[];
  idb: string[];
  channels: string[];
}

function taken(before: Reading, now: Reading): Taken {
  const key = (l: HeldListener) => `${l.target}:${l.type}:${String(l.capture)}:${l.fn}`;
  const old = new Set(before.listeners.map(key));
  const added = now.listeners.filter((l) => !old.has(key(l)));
  // One function registered on `document` for three event types or more is a delegation handler
  // (the framework's; the build is minified, so it is not told by name).
  const uses = new Map<number, number>();
  for (const l of now.listeners)
    if (l.target === 'document') uses.set(l.fn, (uses.get(l.fn) ?? 0) + 1);
  const delegated = (l: HeldListener) => l.target === 'document' && (uses.get(l.fn) ?? 0) >= 3;
  const minus = (a: string[], b: string[]): string[] => {
    const left = [...b];
    return a.filter((x) => {
      const i = left.indexOf(x);
      if (i < 0) return true;
      left.splice(i, 1);
      return false;
    });
  };
  return {
    own: added
      .filter((l) => !delegated(l))
      .map((l) => `${l.target}:${l.type}`)
      .sort(),
    delegation: added
      .filter(delegated)
      .map((l) => l.type)
      .sort(),
    observers: minus(now.held.observers, before.held.observers).sort(),
    workers: now.held.workers - before.held.workers,
    timers: now.held.timers.filter((t) => !before.held.timers.includes(t)),
    idb: minus(now.held.idb, before.held.idb),
    channels: minus(now.held.channels, before.held.channels),
  };
}

interface Hooks {
  internals(el: Element): {
    root: ShadowRoot;
    editor: {
      core: {
        connection: { get(): string };
        pastePlainText(text: string): boolean;
        syncSnapshot(): { inflight: unknown; queue: unknown[] };
      };
    } | null;
    suspended: boolean;
    graceScheduled: boolean;
  };
  backend(sub: string, role: string): unknown;
  docId: string;
  openPdf(
    el: Element,
    source: { url: string },
  ): Promise<{ frame: HTMLIFrameElement; isolation: string; pages: number; worker: boolean }>;
  useEndpoint(): void;
  issueToken(sub: string, role?: string): string;
  endpointCalls: unknown[];
}

/** Takes the element out of the document, keeps it on `window.__held_el`, and waits for the suspension. */
async function detach(page: Page, name: string): Promise<void> {
  await page.evaluate(async (sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const w = window as unknown as Record<string, unknown>;
    w['__held_el'] = el;
    w['__parent'] = el.parentElement;
    w['__core'] =
      (window as unknown as { __embed: Hooks }).__embed.internals(el).editor?.core ?? null;
    el.remove();
    await new Promise((r) => setTimeout(r, 100));
  }, editor(name));
}

async function reattach(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, HTMLElement>;
    w['__parent']!.append(w['__held_el']!);
    await new Promise((r) => setTimeout(r, 100));
  });
}

const held = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const e = (window as unknown as { __embed: Hooks }).__embed;
    const i = e.internals(w['__held_el'] as Element);
    return {
      suspended: i.suspended,
      graceScheduled: i.graceScheduled,
      sameCore: i.editor !== null && i.editor.core === w['__core'],
      connection: i.editor?.core.connection.get() ?? null,
    };
  });

test.describe('FE-005 suspend and resume', () => {
  test('a suspended element holds nothing of its own on the page, and keeps its core and journal', async ({
    page,
  }) => {
    await openEmbed(page);
    await installCounters(page);
    const before = await read(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    // Let what the mount scheduled run: the first frames, the journal open, the first save.
    await page.waitForTimeout(1500);
    const running = taken(before, await read(page));
    // Not vacuous: a running element does hold listeners on the page, observers and the journal.
    expect(running.own).toEqual([
      'document:pointerdown',
      'document:selectionchange',
      'document:visibilitychange',
      'mediaQueryList:change',
      'visualViewport:resize',
      'window:resize',
    ]);
    expect(running.delegation.length).toBeGreaterThan(0);
    expect(running.observers.filter((o) => o === 'ResizeObserver').length).toBeGreaterThan(0);
    expect(running.idb).toEqual(['docedit-journal']);

    await detach(page, 'one');
    const suspended = taken(before, await read(page));
    const state = await held(page);
    record('fe-005-suspend', { running, suspended, state });

    // The editing core is the same one, with no channel; the grace period runs.
    expect(state).toEqual({
      suspended: true,
      graceScheduled: true,
      sameCore: true,
      connection: 'offline',
    });
    // Listeners: only the editing library's `selectionchange` and the framework's delegation stay
    // on `document` (owner decision 181). Nothing stays on `window`, the visual viewport, the font
    // set or a media query.
    expect(suspended.own).toEqual(['document:selectionchange']);
    expect(suspended.delegation).toEqual(running.delegation);
    // Observers: the shell's are stopped. What stays observes the editing surface inside the
    // shadow root and belongs to the view that is kept.
    expect(suspended.observers.filter((o) => o !== 'MutationObserver')).toEqual([]);
    expect(suspended.observers.length).toBeLessThan(running.observers.length);
    // No worker, no channel; the journal stays open; the only timer is the grace period's.
    expect(suspended.workers).toBe(0);
    expect(suspended.channels).toEqual([]);
    expect(suspended.idb).toEqual(['docedit-journal']);
    expect(suspended.timers.filter((t) => t.startsWith('interval'))).toEqual([]);
    expect(suspended.timers.filter((t) => t.startsWith('timeout 30000ms'))).toHaveLength(1);
  });

  test('a reconnected element observes again, reopens its channel and sends what waited', async ({
    page,
  }) => {
    await openEmbed(page);
    await installCounters(page);
    const before = await read(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    const surface = page.locator(`${editor('one')} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Typed-before');
    await expect.poll(() => bodyText(page, 'two')).toContain('Typed-before');
    await page.waitForTimeout(1000);
    const running = taken(before, await read(page));

    await detach(page, 'one');
    expect((await held(page)).connection).toBe('offline');
    // A local edit made while suspended: there is no channel, so it waits, unconfirmed.
    const waiting = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const core = (window as unknown as { __embed: Hooks }).__embed.internals(
        w['__held_el'] as Element,
      ).editor!.core;
      const pasted = core.pastePlainText(' Made-while-suspended');
      const s = core.syncSnapshot();
      return { pasted, unconfirmed: s.inflight !== null || s.queue.length > 0 };
    });
    expect(waiting).toEqual({ pasted: true, unconfirmed: true });
    await page.waitForTimeout(300);
    expect(await bodyText(page, 'two')).not.toContain('Made-while-suspended');

    await reattach(page);
    await expect.poll(async () => (await held(page)).connection).toBe('online');
    expect(await held(page)).toEqual({
      suspended: false,
      graceScheduled: false,
      sameCore: true,
      connection: 'online',
    });
    // The edit made while suspended is still in this editor and now reaches the other one.
    expect(await bodyText(page, 'one')).toContain('Typed-before Made-while-suspended');
    await expect.poll(() => bodyText(page, 'two')).toContain('Made-while-suspended');
    // The listeners and observers are back as they were.
    const resumed = taken(before, await read(page));
    expect(resumed.own).toEqual(running.own);
    expect(resumed.delegation).toEqual(running.delegation);
    expect(resumed.observers).toEqual(running.observers);
    // And typing goes on through the reopened channel.
    await page
      .locator(`${editor('one')} .de-editing-surface p`, { hasText: 'Typed-before' })
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Typed-after');
    await expect.poll(() => bodyText(page, 'two')).toContain('Typed-after');
  });

  test('the page view stops listening to the font set and its layout worker stops; both return', async ({
    page,
  }, info) => {
    // Firefox is not offered the page view (kernel-fallback.ts); the web view is shown there.
    test.skip(info.project.name === 'firefox', 'the page view is not offered in Firefox');
    await openEmbed(page);
    await installCounters(page);
    const before = await read(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { view: 'print' } });
    await expect(page.locator(`${editor('one')} .de-page-view .de-page`).first()).toBeVisible();
    // The layout worker is created with the request for the page view (WASM-004).
    await expect.poll(async () => taken(before, await read(page)).workers).toBe(1);
    const running = taken(before, await read(page));
    expect(running.own).toContain('fonts:loadingdone');
    const pagesBefore = await page.locator(`${editor('one')} .de-page-view .de-page`).count();

    await detach(page, 'one');
    const suspended = taken(before, await read(page));
    record('fe-005-suspend-page-view', { running, suspended });
    expect(suspended.own).toEqual(['document:selectionchange']);
    expect(suspended.workers).toBe(0);
    expect(suspended.observers.filter((o) => o !== 'MutationObserver')).toEqual([]);

    await reattach(page);
    await expect.poll(async () => (await held(page)).connection).toBe('online');
    const resumed = taken(before, await read(page));
    expect(resumed.own).toEqual(running.own);
    // The same page view, still mounted with its pages, takes typing through its bridge.
    await expect(page.locator(`${editor('one')} .de-page-view .de-page`)).toHaveCount(pagesBefore);
    await page
      .locator(`${editor('one')} .de-page-view .de-page`)
      .first()
      .click();
    await page.keyboard.type('Typed-in-pages ');
    await expect.poll(() => bodyText(page, 'one')).toContain('Typed-in-pages');
  });

  test('a PDF viewer frame of a suspended element has no document, so its worker has ended', async ({
    page,
  }, info) => {
    test.skip(
      FILTERED_BROWSERS.has(info.project.name),
      'PDF responses are filtered for this browser on this machine (spike S2 §2)',
    );
    const requested: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    await openEmbed(page);
    await mountEditor(page, {
      name: 'one',
      sub: 'ada',
      // The viewer on another origin, the recommended deployment: PDF.js then has its worker.
      config: {
        pdfViewerUrl: `http://localhost:${new URL(page.url()).port}/lib/viewer/pdf-viewer.html`,
      },
    });
    const opened = await page.evaluate(async (sel) => {
      const e = (window as unknown as { __embed: Hooks }).__embed;
      const el = document.querySelector(sel)!;
      const r = await e.openPdf(el, { url: `${location.origin}/exports/sample.pdf` });
      (window as unknown as { __frame: HTMLIFrameElement }).__frame = r.frame;
      return {
        isolation: r.isolation,
        pages: r.pages,
        worker: r.worker,
        hasWindow: r.frame.contentWindow !== null,
        connected: r.frame.isConnected,
      };
    }, editor('one'));
    expect(opened).toEqual({
      isolation: 'cross-origin',
      pages: 1,
      worker: true,
      hasWindow: true,
      connected: true,
    });
    expect(requested.some((p) => /\/lib\/viewer\/assets\/pdf\.worker[\w.-]*\.m?js$/.test(p))).toBe(
      true,
    );

    await detach(page, 'one');
    expect((await held(page)).suspended).toBe(true);
    // The browser discards the document of a frame that leaves the page, and with it the workers
    // that document started: the frame has no window any more.
    const frame = await page.evaluate(() => {
      const f = (window as unknown as { __frame: HTMLIFrameElement }).__frame;
      return { connected: f.isConnected, hasWindow: f.contentWindow !== null };
    });
    expect(frame).toEqual({ connected: false, hasWindow: false });
  });
});

/** The read view's mock export (as e2e/fe-072-read-view.spec.ts): one `compiling` report, then the end. */
const EXPORTS = `
  (function () {
    const w = window;
    w.__exportRequests = 0;
    w.__backendCloses = 0;
    w.__withExports = function (backend) {
      const connect = backend.connect.bind(backend);
      backend.connect = async function () {
        await connect();
        backend.features = new Set([...backend.features, 'exports']);
      };
      const close = backend.close.bind(backend);
      backend.close = async function () {
        w.__backendCloses++;
        return close();
      };
      let polls = 0;
      const job = function (state) {
        return {
          id: 'job-fe005-' + w.__exportRequests,
          docId: w.__embed.docId,
          state: state,
          progress: state === 'compiling' ? 0.5 : null,
          target: 'pdf',
          result: state === 'completed' ? { url: location.origin + '/exports/sample.pdf', pages: 1 } : null,
          diagnostics: [],
        };
      };
      backend.exports = {
        request: async function () { w.__exportRequests++; polls = 0; return job('queued'); },
        get: async function () { polls += 1; return job(polls === 1 ? 'compiling' : 'completed'); },
        cancel: async function () {},
      };
      return backend;
    };
  })();
`;

interface ReadState {
  views: number;
  frames: number;
  status: string;
  exportRequests: number;
  backendCloses: number;
  suspended: boolean;
  graceScheduled: boolean;
}

const readState = (page: Page, name: string): Promise<ReadState> =>
  page.evaluate((n) => {
    const w = window as unknown as {
      __embed: Hooks;
      __exportRequests: number;
      __backendCloses: number;
      __held_el?: Element;
    };
    const el = document.querySelector(`doc-editor[data-test="${n}"]`) ?? w.__held_el!;
    const i = w.__embed.internals(el);
    return {
      views: i.root.querySelectorAll('.de-read-view').length,
      frames: i.root.querySelectorAll('.de-read-pages iframe').length,
      status: i.root.querySelector('.de-read-status')?.textContent ?? '',
      exportRequests: w.__exportRequests,
      backendCloses: w.__backendCloses,
      suspended: i.suspended,
      graceScheduled: i.graceScheduled,
    };
  }, name);

/** Mounts `<doc-editor view="read">` with the host's backend (and its mock export). */
async function mountRead(page: Page, name: string): Promise<void> {
  await page.evaluate(EXPORTS);
  await page.evaluate((n) => {
    const w = window as unknown as {
      __embed: Hooks;
      __withExports(backend: unknown): unknown;
    };
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      config: unknown;
    };
    el.dataset['test'] = n;
    el.setAttribute('view', 'read');
    el.setAttribute('doc-id', w.__embed.docId);
    el.config = { pdfViewerUrl: `${location.origin}/lib/viewer/pdf-viewer.html` };
    el.backend = w.__withExports(w.__embed.backend('ada', 'editor'));
    document.getElementById('mount')!.append(el);
  }, name);
}

test.describe('FE-005 the read view', () => {
  test('a suspended read view is closed, with the grace period running, and comes back with a new export', async ({
    page,
  }, info) => {
    const drawn = !FILTERED_BROWSERS.has(info.project.name);
    await openEmbed(page);
    await installCounters(page);
    const before = await read(page);
    await mountRead(page, 'read');
    // Where PDF responses are filtered the viewer cannot draw; the read view then says so, and the
    // rest of this test is the same.
    const settled = async (): Promise<boolean> => {
      const s = await readState(page, 'read');
      return drawn ? s.frames === 1 && s.status === '' : s.status.includes('could not be made');
    };
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    expect((await readState(page, 'read')).exportRequests).toBe(1);

    await detach(page, 'read');
    const suspended = await readState(page, 'read');
    // No editing core to keep: the view and its frame are gone, and the element will destroy itself.
    expect(suspended).toMatchObject({
      views: 0,
      frames: 0,
      suspended: true,
      graceScheduled: true,
    });
    // A backend the host passed is the host's: it is not closed.
    expect(suspended.backendCloses).toBe(0);
    const held = taken(before, await read(page));
    expect(held.own).toEqual([]);
    expect(held.workers).toBe(0);
    expect(held.observers).toEqual([]);

    await reattach(page);
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    const back = await readState(page, 'read');
    expect(back).toMatchObject({ views: 1, suspended: false, graceScheduled: false });
    // The read view is shown again from a new export, as the document may have changed meanwhile.
    expect(back.exportRequests).toBe(2);
  });

  test('a backend the element opened for the read view is closed on suspension and opened again', async ({
    page,
  }) => {
    await openEmbed(page);
    await page.evaluate(EXPORTS);
    const calls = () =>
      page.evaluate(() => (window as unknown as { __embed: Hooks }).__embed.endpointCalls.length);
    await page.evaluate(() => {
      const w = window as unknown as {
        __embed: Hooks;
        __withExports(backend: unknown): unknown;
      };
      // `endpoint` and `getToken`: the element makes the backend itself, so it owns it. Each one the
      // page's factory makes is given the mock export and counted when it is closed.
      w.__embed.useEndpoint();
      const sample = w.__embed.backend('ada', 'editor') as object;
      const proto = Object.getPrototypeOf(sample) as {
        connect(this: unknown): Promise<void>;
      };
      const connect = proto.connect;
      const prepared = new WeakSet<object>();
      proto.connect = function (this: object): Promise<void> {
        if (!prepared.has(this)) {
          prepared.add(this);
          w.__withExports(this);
          return (this as { connect(): Promise<void> }).connect();
        }
        return connect.call(this);
      };
      const token = w.__embed.issueToken('ada', 'editor');
      const el = document.createElement('doc-editor') as HTMLElement & {
        getToken: unknown;
        config: unknown;
      };
      el.dataset['test'] = 'owned';
      el.setAttribute('view', 'read');
      el.setAttribute('endpoint', 'https://dep.example.test');
      el.setAttribute('doc-id', w.__embed.docId);
      el.config = { pdfViewerUrl: `${location.origin}/lib/viewer/pdf-viewer.html` };
      el.getToken = async () => token;
      document.getElementById('mount')!.append(el);
    });
    await expect.poll(async () => (await readState(page, 'owned')).views).toBe(1);
    await expect.poll(async () => (await readState(page, 'owned')).exportRequests).toBe(1);
    expect(await calls()).toBe(1);
    expect((await readState(page, 'owned')).backendCloses).toBe(0);

    await detach(page, 'owned');
    // The element opened this backend, so the suspension closes it: its socket goes with it.
    await expect.poll(async () => (await readState(page, 'owned')).backendCloses).toBe(1);
    expect(await readState(page, 'owned')).toMatchObject({ views: 0, suspended: true });

    await reattach(page);
    await expect.poll(async () => (await readState(page, 'owned')).views).toBe(1);
    await expect.poll(calls).toBe(2);
    await expect.poll(async () => (await readState(page, 'owned')).exportRequests).toBe(2);
  });

  test('a move in one task keeps the read view and draws its PDF again in a new frame', async ({
    page,
  }, info) => {
    test.skip(
      FILTERED_BROWSERS.has(info.project.name),
      'PDF responses are filtered for this browser on this machine (spike S2 §2)',
    );
    const pdfRequests: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/exports/sample.pdf') pdfRequests.push(r.url());
    });
    await openEmbed(page);
    await mountRead(page, 'read');
    await expect
      .poll(async () => (await readState(page, 'read')).frames, { timeout: 30_000 })
      .toBe(1);
    await expect.poll(async () => (await readState(page, 'read')).status).toBe('');
    await expect.poll(() => pdfRequests.length).toBe(1);

    const moved = await page.evaluate(async () => {
      const el = document.querySelector('doc-editor[data-test="read"]') as HTMLElement;
      const root = (window as unknown as { __embed: Hooks }).__embed.internals(el).root;
      const frameBefore = root.querySelector('.de-read-pages iframe');
      // What a framework's keyed list does: out and back in, in one task.
      const other = document.getElementById('mount-2')!;
      el.remove();
      other.append(el);
      const frameAfter = root.querySelector('.de-read-pages iframe');
      await new Promise((r) => setTimeout(r, 50));
      const i = (window as unknown as { __embed: Hooks }).__embed.internals(el);
      return {
        suspended: i.suspended,
        graceScheduled: i.graceScheduled,
        newFrame: frameAfter !== null && frameAfter !== frameBefore,
        frames: root.querySelectorAll('.de-read-pages iframe').length,
        views: root.querySelectorAll('.de-read-view').length,
      };
    });
    expect(moved).toEqual({
      suspended: false,
      graceScheduled: false,
      newFrame: true,
      frames: 1,
      views: 1,
    });
    // The new frame fetched the same signed URL and drew it: no new export was needed.
    await expect.poll(() => pdfRequests.length, { timeout: 30_000 }).toBe(2);
    const after = await readState(page, 'read');
    expect(after.exportRequests).toBe(1);
    expect(after.status).toBe('');
    expect(
      await page.evaluate(() => {
        const el = document.querySelector('doc-editor[data-test="read"]')!;
        const root = (window as unknown as { __embed: Hooks }).__embed.internals(el).root;
        return (
          (root.querySelector('.de-read-pages iframe') as HTMLIFrameElement).contentWindow !== null
        );
      }),
    ).toBe(true);
  });

  test('a move in one task while the PDF is still opening ends with the PDF drawn in the new frame', async ({
    page,
  }, info) => {
    test.skip(
      FILTERED_BROWSERS.has(info.project.name),
      'PDF responses are filtered for this browser on this machine (spike S2 §2)',
    );
    // The PDF is held at the network, so the first frame cannot finish opening it before the move.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let pdfRequests = 0;
    await page.route('**/exports/sample.pdf', async (route) => {
      pdfRequests++;
      await held;
      // The first frame is gone by then; its request has nothing left to answer.
      await route.continue().catch(() => {});
    });
    await openEmbed(page);
    await mountRead(page, 'read');
    // The export is complete and the first frame has asked for the PDF.
    await expect.poll(() => pdfRequests, { timeout: 30_000 }).toBe(1);
    const opening = await readState(page, 'read');
    expect(opening).toMatchObject({ frames: 1, exportRequests: 1 });
    expect(opening.status).not.toBe('');

    const moved = await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="read"]') as HTMLElement;
      const root = (window as unknown as { __embed: Hooks }).__embed.internals(el).root;
      const frameBefore = root.querySelector('.de-read-pages iframe');
      el.remove();
      document.getElementById('mount-2')!.append(el);
      const frameAfter = root.querySelector('.de-read-pages iframe');
      return {
        newFrame: frameAfter !== null && frameAfter !== frameBefore,
        frames: root.querySelectorAll('.de-read-pages iframe').length,
        views: root.querySelectorAll('.de-read-view').length,
      };
    });
    expect(moved).toEqual({ newFrame: true, frames: 1, views: 1 });
    // The new frame asks for the same signed URL. Nothing is drawn while the PDF is held, and the
    // view does not report a failure for the frame the browser unloaded.
    await expect.poll(() => pdfRequests, { timeout: 30_000 }).toBe(2);
    expect((await readState(page, 'read')).status).not.toContain('could not be made');

    release();
    // The export's outcome follows the new frame: the status line is cleared only when it is shown.
    await expect
      .poll(async () => (await readState(page, 'read')).status, { timeout: 30_000 })
      .toBe('');
    const after = await readState(page, 'read');
    expect(after).toMatchObject({ views: 1, frames: 1, exportRequests: 1, suspended: false });
    expect(
      await page.evaluate(() => {
        const el = document.querySelector('doc-editor[data-test="read"]')!;
        const root = (window as unknown as { __embed: Hooks }).__embed.internals(el).root;
        return (
          (root.querySelector('.de-read-pages iframe') as HTMLIFrameElement).contentWindow !== null
        );
      }),
    ).toBe(true);
  });
});
