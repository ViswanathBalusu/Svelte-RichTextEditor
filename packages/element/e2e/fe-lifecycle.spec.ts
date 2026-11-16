/**
 * Lifecycle of the production element when a host moves or removes it (02 §2.1): FE-005 (suspend
 * and resume instead of destroy) and FE-006 (destroy after the grace period). Uses the embed page
 * (`pages/embed.html`) and its in-memory backend, as element.spec.ts does.
 *
 * Not covered here, and left unticked in the stories: the selection after a move (not checked
 * here, see FE-005 Notes), listeners removed on suspend, the socket closed on suspend, the resume of
 * the channel (FE-005 criteria 3 and 4; see fe-005-suspend-resume.spec.ts and
 * tests/V-FE-113-128/fe-122-two-tabs.spec.ts), instrumented release counters and the 100-route memory
 * check (FE-006 criteria 3 and 5), and the journal (FE-006 criterion 4, FE-008).
 */
import { expect, test } from '@playwright/test';
import { bodyText, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = (name = 'one') => `doc-editor[data-test="${name}"]`;

interface EmbedHooks {
  internals(el: Element): {
    editor: { core: object } | null;
    suspended: boolean;
    graceScheduled: boolean;
    session: unknown;
  };
}

test.describe('FE-005 survive being moved in the DOM', () => {
  test('a move in one task keeps the unconfirmed typing and the core', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const surface = page.locator(`${editor('one')} .de-editing-surface`);
    await surface.locator('p', { hasText: 'Last paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Unconfirmed');
    // Objects do not survive page.evaluate, so identity is compared inside the page, with the core
    // kept on window between the two evaluations.
    await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el =
        (window as unknown as Record<string, HTMLElement>)['__held'] ??
        document.querySelector(sel)!;
      (window as unknown as Record<string, unknown>)['__core'] = e.internals(
        el as HTMLElement,
      ).editor!.core;
    }, editor());
    // Moved to the other container in one task: the microtask after the move sees the element
    // connected. The wait lets that microtask and any grace timer run.
    const after = await page.evaluate(async (sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el = document.querySelector(sel) as HTMLElement;
      const parent = el.parentElement!;
      const other = document.getElementById(parent.id === 'mount' ? 'mount-2' : 'mount')!;
      other.append(el);
      await new Promise((r) => setTimeout(r, 50));
      return {
        sameCore:
          e.internals(el).editor?.core === (window as unknown as Record<string, unknown>)['__core'],
        suspended: e.internals(el).suspended,
        graceScheduled: e.internals(el).graceScheduled,
      };
    }, editor());
    expect(after).toEqual({ sameCore: true, suspended: false, graceScheduled: false });
    expect(await bodyText(page, 'one')).toContain('Last paragraph. Unconfirmed');
  });

  test('connectedMoveCallback: a native move keeps the element connected and does nothing', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const supported = await page.evaluate(() => typeof Element.prototype.moveBefore === 'function');
    test.skip(!supported, 'Element.moveBefore is not available in this browser');
    const r = await page.evaluate(async (sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el = document.querySelector(sel) as HTMLElement;
      const C = customElements.get('doc-editor') as unknown as {
        prototype: Record<string, (...a: unknown[]) => unknown>;
      };
      const counts = { connect: 0, disconnect: 0, move: 0 };
      const wrap = (
        name: 'connectedCallback' | 'disconnectedCallback' | 'connectedMoveCallback',
        key: keyof typeof counts,
      ) => {
        const original = C.prototype[name];
        C.prototype[name] = function (this: unknown, ...args: unknown[]) {
          counts[key]++;
          return original?.apply(this, args);
        };
      };
      wrap('connectedCallback', 'connect');
      wrap('disconnectedCallback', 'disconnect');
      wrap('connectedMoveCallback', 'move');
      const core = e.internals(el).editor!.core;
      const target = document.getElementById('mount-2')! as HTMLElement & {
        moveBefore(n: Node, c: Node | null): void;
      };
      target.moveBefore(el, null);
      await new Promise((r) => setTimeout(r, 50));
      return {
        counts,
        sameCore: e.internals(el).editor?.core === core,
        suspended: e.internals(el).suspended,
        connected: el.isConnected,
        inTarget: el.parentElement?.id === 'mount-2',
      };
    }, editor());
    expect(r.connected).toBe(true);
    expect(r.inTarget).toBe(true);
    expect(r.sameCore).toBe(true);
    expect(r.suspended).toBe(false);
    expect(r.counts.disconnect).toBe(0);
    expect(r.counts.connect).toBe(0);
  });

  test('fifty reorders in separate tasks keep the same editing core', async ({ page }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    const r = await page.evaluate(async (sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el = document.querySelector(sel) as HTMLElement;
      const core = e.internals(el).editor!.core;
      const containers = [document.getElementById('mount')!, document.getElementById('mount-2')!];
      let suspensions = 0;
      for (let i = 0; i < 50; i++) {
        containers[(i + 1) % 2]!.append(el);
        await new Promise((r) => setTimeout(r, 0));
        if (e.internals(el).suspended) suspensions++;
      }
      return {
        sameCore: e.internals(el).editor?.core === core,
        suspensions,
        shells: el.shadowRoot!.querySelectorAll('.de-shell').length,
      };
    }, editor());
    expect(r).toEqual({ sameCore: true, suspensions: 0, shells: 1 });
  });
});

test.describe('FE-006 destroy after the grace period', () => {
  test('a removed editor is destroyed after the default 30 seconds, not before', async ({
    page,
  }) => {
    await page.clock.install();
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      (window as unknown as Record<string, HTMLElement>)['__held'] = el;
      el.remove();
    }, editor());
    // 27 seconds: inside the default grace period, with three seconds to spare for real time.
    await page.clock.runFor(27_000);
    const early = await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el =
        (window as unknown as Record<string, HTMLElement>)['__held'] ??
        document.querySelector(sel)!;
      return {
        suspended: e.internals(el as HTMLElement).suspended,
        shells: (el as HTMLElement).shadowRoot!.querySelectorAll('.de-shell').length,
      };
    }, editor());
    expect(early).toEqual({ suspended: true, shells: 1 });
    await page.clock.runFor(3_500);
    const late = await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el =
        (window as unknown as Record<string, HTMLElement>)['__held'] ??
        document.querySelector(sel)!;
      return {
        session: e.internals(el as HTMLElement).session,
        shells: (el as HTMLElement).shadowRoot!.querySelectorAll('.de-shell').length,
        graceScheduled: e.internals(el as HTMLElement).graceScheduled,
      };
    }, editor());
    expect(late).toEqual({ session: null, shells: 0, graceScheduled: false });
  });

  test('keep-alive keeps a removed editor suspended and mounted past the grace period', async ({
    page,
  }) => {
    await page.clock.install();
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      el.setAttribute('keep-alive', '');
      (window as unknown as Record<string, HTMLElement>)['__held'] = el;
      el.remove();
    }, editor());
    await page.clock.runFor(60_000);
    const during = await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el =
        (window as unknown as Record<string, HTMLElement>)['__held'] ??
        document.querySelector(sel)!;
      return {
        suspended: e.internals(el as HTMLElement).suspended,
        graceScheduled: e.internals(el as HTMLElement).graceScheduled,
        shells: (el as HTMLElement).shadowRoot!.querySelectorAll('.de-shell').length,
      };
    }, editor());
    expect(during).toEqual({ suspended: true, graceScheduled: false, shells: 1 });
    // Connecting again resumes the same editor.
    await page.evaluate(() => {
      document
        .getElementById('mount')!
        .append((window as unknown as Record<string, HTMLElement>)['__held']!);
    });
    const resumed = await page.evaluate((sel) => {
      const e = (window as unknown as { __embed: EmbedHooks }).__embed;
      const el = document.querySelector(sel) as HTMLElement;
      return {
        suspended: e.internals(el).suspended,
        shells: el.shadowRoot!.querySelectorAll('.de-shell').length,
      };
    }, editor());
    expect(resumed).toEqual({ suspended: false, shells: 1 });
  });
});
