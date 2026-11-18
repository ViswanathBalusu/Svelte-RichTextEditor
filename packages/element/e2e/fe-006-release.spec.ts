/**
 * FE-006 criterion 3 (02 §2.1; lane w1): when `destroy()` is called, or the grace period of a
 * removed element ends, the shell is unmounted, the editing core is destroyed, and every timer,
 * frame, observer, listener on a long-lived target, worker, IndexedDB handle and channel that the
 * editor took is released. The check is by counters installed in the page (`fe-006-counters.ts`) and
 * read back after the destroy; it does not wait for garbage collection.
 *
 * The counters are compared with a baseline taken before the editor mounts, so what the page itself
 * holds is not counted. The result before the destroy must be non-empty, or the check is vacuous.
 *
 * Run with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts fe-006-release
 */
import { expect, test, type Page } from '@playwright/test';
import { installCounters, readCounters, type Held } from './fe-006-counters.ts';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

interface EmbedHooks {
  internals(el: Element): { editor: { core: object } | null; root: ShadowRoot };
}

/** What the editor took, as the difference between two readings. */
function taken(before: Held, after: Held): Held {
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
    listeners: minus(after.listeners, before.listeners),
    observers: minus(after.observers, before.observers),
    timers: after.timers.filter((t) => !before.timers.includes(t)),
    frames: Math.max(0, after.frames - before.frames),
    workers: Math.max(0, after.workers - before.workers),
    idb: minus(after.idb, before.idb),
    channels: minus(after.channels, before.channels),
    acquired: {
      listeners: after.acquired.listeners - before.acquired.listeners,
      observers: after.acquired.observers - before.acquired.observers,
      timers: after.acquired.timers - before.acquired.timers,
      frames: after.acquired.frames - before.acquired.frames,
      workers: after.acquired.workers - before.acquired.workers,
      idb: after.acquired.idb - before.acquired.idb,
      channels: after.acquired.channels - before.acquired.channels,
    },
  };
}

const shellMounted = (page: Page): Promise<{ shell: boolean; core: boolean }> =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return { shell: false, core: false };
    const e = (window as unknown as { __embed: EmbedHooks }).__embed;
    const i = e.internals(el);
    return { shell: i.root.querySelector('.de-shell') !== null, core: i.editor !== null };
  }, editor);

async function mountWithCounters(page: Page): Promise<{ before: Held; during: Held }> {
  await page.clock.install();
  await openEmbed(page);
  await installCounters(page);
  const before = await readCounters(page);
  await mountEditor(page, { name: 'one', sub: 'ada' });
  // Let what the mount scheduled run: the first frames, the journal open, the first save.
  await page.clock.runFor(2_000);
  const during = taken(before, await readCounters(page));
  return { before, during };
}

test.describe('FE-006 criterion 3: the counters see a leak', () => {
  test('a listener, an interval, an observer and an open database show up, and go when released', async ({
    page,
  }) => {
    await page.clock.install();
    await openEmbed(page);
    await installCounters(page);
    const before = await readCounters(page);
    await page.evaluate(async () => {
      const w = window as unknown as { __leak: Record<string, unknown> };
      const onResize = (): void => {};
      window.addEventListener('resize', onResize);
      const timer = window.setInterval(() => {}, 1000);
      const observer = new ResizeObserver(() => {});
      observer.observe(document.body);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('fe-006-control');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      w.__leak = { onResize, timer, observer, db };
    });
    const held = taken(before, await readCounters(page));
    expect(held.listeners).toEqual(['window:resize:false']);
    expect(held.observers).toEqual(['ResizeObserver']);
    expect(held.timers).toHaveLength(1);
    expect(held.idb).toEqual(['fe-006-control']);

    await page.evaluate(() => {
      const leak = (window as unknown as { __leak: Record<string, never> }).__leak as unknown as {
        onResize: () => void;
        timer: number;
        observer: ResizeObserver;
        db: IDBDatabase;
      };
      window.removeEventListener('resize', leak.onResize);
      clearInterval(leak.timer);
      leak.observer.disconnect();
      leak.db.close();
      indexedDB.deleteDatabase('fe-006-control');
    });
    expect(taken(before, await readCounters(page))).toMatchObject({
      listeners: [],
      observers: [],
      timers: [],
      idb: [],
    });
  });
});

test.describe('FE-006 criterion 3: what a destroyed editor releases', () => {
  test('destroy() unmounts the shell and the core and releases every resource it took', async ({
    page,
  }) => {
    const { before, during } = await mountWithCounters(page);

    // Not vacuous: the editor took resources of the kinds that the story names.
    expect(during.acquired.listeners).toBeGreaterThan(0);
    expect(during.acquired.observers).toBeGreaterThan(0);
    expect(during.acquired.timers).toBeGreaterThan(0);
    expect(during.acquired.idb).toBeGreaterThan(0);
    expect(await shellMounted(page)).toEqual({ shell: true, core: true });
    test.info().annotations.push({
      type: 'held while mounted',
      description: JSON.stringify({
        listeners: during.listeners.length,
        observers: during.observers.length,
        timers: during.timers.length,
        frames: during.frames,
        workers: during.workers,
        idb: during.idb,
        channels: during.channels,
      }),
    });

    await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLElement & { destroy(): void }).destroy(),
      editor,
    );
    // The close of the session is asynchronous; the fake clock does not move, so nothing is
    // released by a timer running out.
    await expect.poll(() => shellMounted(page)).toEqual({ shell: false, core: false });
    await expect
      .poll(async () => taken(before, await readCounters(page)), { timeout: 10_000 })
      .toMatchObject({
        listeners: [],
        observers: [],
        timers: [],
        frames: 0,
        workers: 0,
        idb: [],
        channels: [],
      });
  });

  test('the end of the grace period releases the same, with the element removed', async ({
    page,
  }) => {
    const { before, during } = await mountWithCounters(page);
    expect(during.acquired.listeners).toBeGreaterThan(0);
    expect(during.acquired.idb).toBeGreaterThan(0);

    await page.evaluate((sel) => document.querySelector(sel)!.remove(), editor);
    // Past the default 30-second grace period: the element destroys itself.
    await page.clock.runFor(31_000);
    await expect
      .poll(async () => taken(before, await readCounters(page)), { timeout: 10_000 })
      .toMatchObject({
        listeners: [],
        observers: [],
        timers: [],
        frames: 0,
        workers: 0,
        idb: [],
        channels: [],
      });
  });
});
