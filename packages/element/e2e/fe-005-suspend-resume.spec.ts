/**
 * FE-005 criteria 3 and 4 (02 §2.1) in a browser, with the real core and shell on the embed page
 * (`pages/embed.html`, in-memory backend passed by the host).
 *
 * An init script wraps `addEventListener` and `removeEventListener` of `document` and `window`, the
 * `ResizeObserver` and the `MediaQueryList` listeners, so that each test reads what is in force:
 * before the element mounts, while it runs, while it is suspended and after it has come back.
 *
 * Two kinds of listener stay on `document` during a suspension, and the first test pins them down so
 * that a change is noticed (criterion 3 is not met in full for that reason; see the story's Notes):
 * - Svelte's `mount` puts one delegated-event handler on `document` for each delegated event type
 *   and takes it off only at `unmount`. The handler is Svelte's own module function.
 * - ProseMirror's view listens to `selectionchange` on `document` until the view is destroyed.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-005-suspend-resume.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';
import { record } from './helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;

interface Probe {
  /** Listeners on `document` and `window` that are not Svelte's delegation, as `target:type`. */
  own: string[];
  /** The event types of Svelte's delegated-event listeners on `document`. */
  delegation: string[];
  /** Observers that observe something. */
  observers: number;
  /** `change` listeners on media queries. */
  media: number;
}

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners: Array<{ target: string; type: string; fn: unknown }> = [];
    for (const [name, target] of [
      ['document', document],
      ['window', window],
    ] as const) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      target.addEventListener = (type: string, fn: unknown, options?: unknown) => {
        if (fn && !listeners.some((l) => l.target === name && l.type === type && l.fn === fn))
          listeners.push({ target: name, type, fn });
        add(type, fn as EventListener, options as AddEventListenerOptions);
      };
      target.removeEventListener = (type: string, fn: unknown, options?: unknown) => {
        const i = listeners.findIndex((l) => l.target === name && l.type === type && l.fn === fn);
        if (i >= 0) listeners.splice(i, 1);
        remove(type, fn as EventListener, options as EventListenerOptions);
      };
    }
    const observing = new Set<ResizeObserver>();
    const observe = ResizeObserver.prototype.observe;
    const disconnect = ResizeObserver.prototype.disconnect;
    ResizeObserver.prototype.observe = function (...args) {
      observing.add(this);
      return observe.apply(this, args);
    };
    ResizeObserver.prototype.disconnect = function () {
      observing.delete(this);
      return disconnect.apply(this);
    };
    let media = 0;
    const addMedia = MediaQueryList.prototype.addEventListener;
    const removeMedia = MediaQueryList.prototype.removeEventListener;
    MediaQueryList.prototype.addEventListener = function (...args: unknown[]) {
      media++;
      return addMedia.apply(this, args as Parameters<typeof addMedia>);
    };
    MediaQueryList.prototype.removeEventListener = function (...args: unknown[]) {
      media--;
      return removeMedia.apply(this, args as Parameters<typeof removeMedia>);
    };
    (window as unknown as { __probe: () => unknown }).__probe = () => {
      // One function registered on `document` for three event types or more is a delegation
      // handler (Svelte's `handle_event_propagation`; the build is minified, so not told by name).
      const uses = new Map<unknown, number>();
      for (const l of listeners)
        if (l.target === 'document') uses.set(l.fn, (uses.get(l.fn) ?? 0) + 1);
      const delegated = (l: { target: string; fn: unknown }) =>
        l.target === 'document' && (uses.get(l.fn) ?? 0) >= 3;
      return {
        own: listeners
          .filter((l) => !delegated(l))
          .map((l) => `${l.target}:${l.type}`)
          .sort(),
        delegation: listeners
          .filter(delegated)
          .map((l) => l.type)
          .sort(),
        observers: observing.size,
        media,
      };
    };
  });
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => (window as unknown as { __probe: () => Probe }).__probe());

interface Hooks {
  internals(el: Element): {
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
}

/** Takes the element out of the document, keeps it on `window.__held`, and waits for the suspension. */
async function detach(page: Page, name: string): Promise<void> {
  await page.evaluate(async (sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const w = window as unknown as Record<string, unknown>;
    w['__held'] = el;
    w['__parent'] = el.parentElement;
    w['__core'] = (window as unknown as { __embed: Hooks }).__embed.internals(el).editor!.core;
    el.remove();
    await new Promise((r) => setTimeout(r, 100));
  }, editor(name));
}

async function reattach(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, HTMLElement>;
    w['__parent']!.append(w['__held']!);
    await new Promise((r) => setTimeout(r, 100));
  });
}

const held = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const e = (window as unknown as { __embed: Hooks }).__embed;
    const i = e.internals(w['__held'] as Element);
    return {
      suspended: i.suspended,
      sameCore: i.editor?.core === w['__core'],
      connection: i.editor?.core.connection.get() ?? null,
    };
  });

test.describe('FE-005 suspend and resume', () => {
  test('a suspended element takes its listeners and observers off the page and closes its channel', async ({
    page,
  }) => {
    await instrument(page);
    await openEmbed(page);
    const before = await probe(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const running = await probe(page);
    // Non-vacuity: a running element does hold listeners on the page and observers.
    expect(running.own.length).toBeGreaterThan(before.own.length);
    expect(running.own).toContain('document:pointerdown');
    expect(running.own).toContain('document:visibilitychange');
    expect(running.observers).toBeGreaterThan(before.observers);
    expect(running.media).toBeGreaterThan(before.media);

    await detach(page, 'one');
    const suspended = await probe(page);
    const state = await held(page);
    record(`fe-005-suspend-${test.info().project.name}`, { before, running, suspended, state });

    expect(state).toEqual({ suspended: true, sameCore: true, connection: 'offline' });
    // Every listener the element's own code put on `document` and `window` is gone. What stays is
    // ProseMirror's `selectionchange` listener and Svelte's delegation, both until the shell and the
    // views are destroyed.
    expect(suspended.own.filter((l) => !before.own.includes(l))).toEqual([
      'document:selectionchange',
    ]);
    expect(running.own.filter((l) => !suspended.own.includes(l))).toEqual([
      'document:pointerdown',
      'document:visibilitychange',
    ]);
    expect(suspended.delegation).toEqual(running.delegation);
    expect(suspended.delegation.length).toBeGreaterThan(0);
    expect(suspended.observers).toBe(before.observers);
    expect(suspended.media).toBe(before.media);
  });

  test('a reconnected element observes again, reopens its channel and sends what waited', async ({
    page,
  }) => {
    await instrument(page);
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    const surface = page.locator(`${editor('one')} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Typed-before');
    await expect.poll(() => bodyText(page, 'two')).toContain('Typed-before');
    const running = await probe(page);

    await detach(page, 'one');
    expect((await held(page)).connection).toBe('offline');
    // A local edit made while suspended: there is no channel, so it waits, unconfirmed.
    const waiting = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const core = (window as unknown as { __embed: Hooks }).__embed.internals(
        w['__held'] as Element,
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
    expect(await held(page)).toEqual({ suspended: false, sameCore: true, connection: 'online' });
    // The edit made while suspended is still in this editor and now reaches the other one.
    expect(await bodyText(page, 'one')).toContain('Typed-before Made-while-suspended');
    await expect.poll(() => bodyText(page, 'two')).toContain('Made-while-suspended');
    // The listeners and observers are back as they were.
    const resumed = await probe(page);
    expect(resumed.own).toEqual(running.own);
    expect(resumed.observers).toBe(running.observers);
    expect(resumed.media).toBe(running.media);
    // And typing goes on through the reopened channel.
    await page
      .locator(`${editor('one')} .de-editing-surface p`, { hasText: 'Typed-before' })
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Typed-after');
    await expect.poll(() => bodyText(page, 'two')).toContain('Typed-after');
  });
});
