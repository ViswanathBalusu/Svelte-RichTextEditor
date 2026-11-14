/**
 * Lane V-PRO-069-085: the two criteria that the element's own suites could not prove.
 *
 * - PRO-074 criterion 2: when the host changes `doc-id`, the previous document's session is closed
 *   before the new one loads.
 * - PRO-076 criterion 3: after `destroy()` no listener, observer or timer that the element added to
 *   the host page remains. The page is instrumented before it loads (addInitScript) so that every
 *   add and remove on `document` and `window`, every MutationObserver and ResizeObserver, and every
 *   pending timer is visible; what the element added after the baseline must be gone afterwards.
 *
 * Run from the repository root:
 *   pnpm exec playwright test -c packages/element/playwright.config.ts e2e/pro-074-076-lifecycle.spec.ts
 */
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const editor = '[data-test="one"]';

test.describe('PRO-074 criterion 2 (V-PRO-069-085): a doc-id change closes the previous session', () => {
  test('the session of the previous document is closed before the new one reports de-ready', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page);
    const r = await page.evaluate(async (sel) => {
      const e = (
        window as unknown as {
          __embed: {
            secondDocId: string;
            internals(el: Element): { session: { closed: boolean; docId?: string } | null };
          };
        }
      ).__embed;
      const el = document.querySelector(sel) as HTMLElement;
      const before = e.internals(el).session;
      const errors: string[] = [];
      el.addEventListener('de-error', (ev) =>
        errors.push(JSON.stringify((ev as CustomEvent).detail)),
      );
      let closedAtReady: boolean | null = null;
      let oldSessionClosedWhenReady: boolean | null = null;
      const ready = new Promise<CustomEvent>((resolve) =>
        el.addEventListener(
          'de-ready',
          (ev) => {
            closedAtReady = before ? before.closed : null;
            oldSessionClosedWhenReady = before ? before.closed : null;
            resolve(ev as CustomEvent);
          },
          { once: true },
        ),
      );
      el.setAttribute('doc-id', e.secondDocId);
      const detail = (await ready).detail;
      const after = e.internals(el).session;
      return {
        detail,
        expectedDocId: e.secondDocId,
        hadBefore: before !== null,
        oldClosed: before ? before.closed : null,
        closedAtReady,
        oldSessionClosedWhenReady,
        newSession: after !== null && after !== before,
        errors,
      };
    }, editor);
    expect(r.hadBefore).toBe(true);
    expect(r.detail).toEqual({ docId: r.expectedDocId, seq: 0 });
    expect(r.oldClosed).toBe(true);
    expect(r.closedAtReady).toBe(true);
    expect(r.newSession).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

test.describe('PRO-076 criterion 3 (V-PRO-069-085): destroy() releases what the element added to the host page', () => {
  test('after destroy() no document or window listener, observer or pending timer added after mount remains', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      type Entry = { target: 'document' | 'window'; type: string; fn: unknown; cap: boolean };
      const w = window as unknown as Record<string, unknown>;
      const listeners: Entry[] = [];
      const capOf = (opts: unknown) =>
        typeof opts === 'boolean'
          ? opts
          : Boolean((opts as { capture?: boolean } | undefined)?.capture);
      const targetName = (t: unknown): 'document' | 'window' | null =>
        t === document ? 'document' : t === window ? 'window' : null;
      const origAdd = EventTarget.prototype.addEventListener;
      const origRemove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        type: string,
        fn: EventListenerOrEventListenerObject | null,
        opts?: boolean | AddEventListenerOptions,
      ) {
        const name = targetName(this);
        if (name && fn) {
          const cap = capOf(opts);
          if (
            !listeners.some(
              (e) => e.target === name && e.type === type && e.fn === fn && e.cap === cap,
            )
          )
            listeners.push({ target: name, type, fn, cap });
        }
        return origAdd.call(this, type, fn, opts);
      } as typeof origAdd;
      EventTarget.prototype.removeEventListener = function (
        this: EventTarget,
        type: string,
        fn: EventListenerOrEventListenerObject | null,
        opts?: boolean | EventListenerOptions,
      ) {
        const name = targetName(this);
        if (name && fn) {
          const cap = capOf(opts);
          const i = listeners.findIndex(
            (e) => e.target === name && e.type === type && e.fn === fn && e.cap === cap,
          );
          if (i >= 0) listeners.splice(i, 1);
        }
        return origRemove.call(this, type, fn, opts);
      } as typeof origRemove;
      w['__liveListeners'] = listeners;

      const observers = new Set<object>();
      for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver'] as const) {
        const Orig = w[name] as new (...a: unknown[]) => { disconnect(): void };
        if (!Orig) continue;
        const Wrapped = class extends Orig {
          constructor(...a: unknown[]) {
            super(...a);
            observers.add(this);
          }
          override disconnect() {
            observers.delete(this);
            super.disconnect();
          }
        };
        w[name] = Wrapped;
      }
      w['__liveObservers'] = observers;

      const timers = new Map<number, { delay: number; stack: string }>();
      const origSet = window.setTimeout;
      const origClear = window.clearTimeout;
      window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        const id = (origSet as (...a: unknown[]) => number).call(
          window,
          (...cbArgs: unknown[]) => {
            timers.delete(id as unknown as number);
            if (typeof fn === 'function') (fn as (...x: unknown[]) => void)(...cbArgs);
          },
          delay,
          ...args,
        ) as unknown as number;
        timers.set(id, { delay: Number(delay ?? 0), stack: 'setTimeout' });
        return id;
      }) as typeof window.setTimeout;
      window.clearTimeout = ((id?: number) => {
        if (id !== undefined) timers.delete(id);
        return origClear.call(window, id as unknown as number);
      }) as typeof window.clearTimeout;
      w['__pendingTimers'] = timers;
    });

    await openEmbed(page);
    // The baseline: what the host page and the demo hooks hold before the element exists.
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w['__baselineListeners'] = [...(w['__liveListeners'] as unknown[])];
      w['__baselineObservers'] = [...(w['__liveObservers'] as Set<object>)];
      w['__baselineTimers'] = [...(w['__pendingTimers'] as Map<number, unknown>).keys()];
    });
    await mountEditor(page);
    // Some work so that the element has listeners, observers and timers of its own.
    await page.locator(`doc-editor${editor} .de-editing-surface`).click();
    await page.keyboard.type('x');

    const before = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return (w['__liveListeners'] as unknown[]).length;
    });
    expect(before).toBeGreaterThan(0);

    await page.evaluate(async (sel) => {
      const el = document.querySelector(sel) as HTMLElement & { destroy(): void };
      el.destroy();
    }, editor);
    await page.waitForTimeout(400);

    const leftovers = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const baseL = w['__baselineListeners'] as Array<{
        target: string;
        type: string;
        fn: unknown;
        cap: boolean;
      }>;
      const liveL = w['__liveListeners'] as Array<{
        target: string;
        type: string;
        fn: unknown;
        cap: boolean;
      }>;
      const baseO = w['__baselineObservers'] as object[];
      const liveO = w['__liveObservers'] as Set<object>;
      const baseT = new Set(w['__baselineTimers'] as number[]);
      const timers = w['__pendingTimers'] as Map<number, { delay: number }>;
      return {
        listeners: liveL
          .filter(
            (e) =>
              !baseL.some(
                (b) =>
                  b.target === e.target && b.type === e.type && b.fn === e.fn && b.cap === e.cap,
              ),
          )
          .map((e) => `${e.target}:${e.type}`),
        observers: [...liveO].filter((o) => !baseO.includes(o)).length,
        timers: [...timers.entries()].filter(([id]) => !baseT.has(id)).map(([, t]) => t.delay),
      };
    });
    expect(leftovers.listeners).toEqual([]);
    expect(leftovers.observers).toBe(0);
    expect(leftovers.timers).toEqual([]);
  });
});
