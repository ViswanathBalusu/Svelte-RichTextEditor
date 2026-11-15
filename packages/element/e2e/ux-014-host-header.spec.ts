/**
 * UX-014 criterion 5 (lane w3): a host that hides the built-in header with `header="none"` draws its
 * own from the element's events and its `headerState` property (proposed, ADR 0361). The host
 * header is a plain element of the embed page, outside the shadow root. It shows the save and
 * connection state (`de-status`), the mode in effect (`de-mode-change`), the other sessions
 * (`de-presence`) and the counts (`de-counts`). The core has no source for the counts yet, so the
 * test sets them on the core through the embed page's test hook; everything else comes from the
 * in-memory backend. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/ux-014-host-header.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { events, mountEditor, openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';

interface HostHeader {
  sync: string | null;
  connection: string | null;
  mode: string | null;
  requested: string | null;
  peers: string | null;
  comments: string | null;
  catchUp: string | null;
}

/** Draws a host header that follows the element's events; its first values come from `headerState`. */
async function installHostHeader(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    interface State {
      status: { connection: string; sync: string } | null;
      mode: { mode: string; requested: string };
      presence: { peers: { session: string; user: string; status: string }[] };
      counts: { comments: number | null; catchUp: number | null };
    }
    const el = document.querySelector(sel) as HTMLElement & { headerState: State | null };
    const header = document.createElement('header');
    header.id = 'host-header';
    document.body.prepend(header);
    const set = (name: string, value: string): void => {
      header.dataset[name] = value;
    };
    const count = (n: number | null): string => (n === null ? 'unknown' : String(n));
    const drawStatus = (d: { connection: string; sync: string }): void => {
      set('sync', d.sync);
      set('connection', d.connection);
    };
    const drawMode = (d: State['mode']): void => {
      set('mode', d.mode);
      set('requested', d.requested);
    };
    const drawPeers = (d: State['presence']): void =>
      set('peers', d.peers.map((p) => `${p.user}:${p.status}`).join(','));
    const drawCounts = (d: State['counts']): void => {
      set('comments', count(d.comments));
      set('catchUp', count(d.catchUp));
    };
    const now = el.headerState;
    if (now) {
      if (now.status) drawStatus(now.status);
      drawMode(now.mode);
      drawPeers(now.presence);
      drawCounts(now.counts);
    }
    const detail = <T>(ev: Event): T => (ev as CustomEvent<T>).detail;
    el.addEventListener('de-status', (ev) => drawStatus(detail(ev)));
    el.addEventListener('de-mode-change', (ev) => drawMode(detail(ev)));
    el.addEventListener('de-presence', (ev) => drawPeers(detail(ev)));
    el.addEventListener('de-counts', (ev) => drawCounts(detail(ev)));
  }, editor);
}

function hostHeader(page: Page): Promise<HostHeader> {
  return page.evaluate(() => {
    const d = document.getElementById('host-header')!.dataset;
    return {
      sync: d['sync'] ?? null,
      connection: d['connection'] ?? null,
      mode: d['mode'] ?? null,
      requested: d['requested'] ?? null,
      peers: d['peers'] ?? null,
      comments: d['comments'] ?? null,
      catchUp: d['catchUp'] ?? null,
    };
  });
}

test.describe('UX-014 a host draws its own header', () => {
  test('header="none" hides the built-in header, and the host header follows the editor', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada', attributes: { header: 'none' } });
    await expect(page.locator(`${editor} .de-header`)).toHaveCount(0);

    // The state when the editor became live was raised as events, each composed and bubbling.
    for (const name of ['de-mode-change', 'de-presence', 'de-counts']) {
      const raised = (await events(page, name)).filter((e) => e.element === 'one');
      expect(raised.length, name).toBeGreaterThan(0);
      expect([raised[0]!.composed, raised[0]!.bubbles], name).toEqual([true, true]);
    }

    // A host that starts late reads the same state from the property.
    await installHostHeader(page);
    await expect
      .poll(() => hostHeader(page))
      .toEqual({
        sync: 'saved',
        connection: 'online',
        mode: 'edit',
        requested: 'edit',
        peers: '',
        comments: 'unknown',
        catchUp: 'unknown',
      });

    // Save state: typing makes the document unsaved or saving, then saved again.
    const seen: string[] = [];
    await page.exposeFunction('__sync', (s: string) => {
      seen.push(s);
    });
    await page.evaluate((sel) => {
      document.querySelector(sel)!.addEventListener('de-status', (ev) => {
        void (window as unknown as { __sync(s: string): void }).__sync(
          (ev as CustomEvent<{ sync: string }>).detail.sync,
        );
      });
    }, editor);
    await page.locator(`${editor} .de-editing-surface p`).first().click();
    await page.keyboard.type('x');
    await expect.poll(() => seen.some((s) => s !== 'saved')).toBe(true);
    await expect.poll(async () => (await hostHeader(page)).sync).toBe('saved');

    // Mode: the host asks for `view`; the mode in effect follows and the host header shows it.
    await page.evaluate((sel) => document.querySelector(sel)!.setAttribute('mode', 'view'), editor);
    await expect
      .poll(async () => {
        const h = await hostHeader(page);
        return [h.mode, h.requested];
      })
      .toEqual(['view', 'view']);
    await page.evaluate((sel) => document.querySelector(sel)!.setAttribute('mode', 'edit'), editor);
    await expect.poll(async () => (await hostHeader(page)).mode).toBe('edit');

    // Presence: a second session of another user arrives, then leaves.
    await mountEditor(page, { name: 'two', sub: 'bob' });
    await expect.poll(async () => (await hostHeader(page)).peers).toMatch(/^bob:(active|idle)$/);
    const presence = (await events(page, 'de-presence')).filter((e) => e.element === 'one');
    const last = presence.at(-1)!.detail as { peers: Record<string, unknown>[] };
    // Identifiers and a status only: no name, no selection.
    expect(Object.keys(last.peers[0]!).sort()).toEqual(['session', 'status', 'user']);
    // destroy() ends the session at once; remove() alone would wait for the keep-alive grace.
    await page.evaluate(() => {
      const two = document.querySelector('doc-editor[data-test="two"]') as HTMLElement & {
        destroy(): void;
      };
      two.destroy();
      two.remove();
    });
    await expect.poll(async () => (await hostHeader(page)).peers, { timeout: 30_000 }).toBe('');

    // Counts: the core has no source yet, so the test hook sets them as a source will.
    await page.evaluate((sel) => {
      const e = (
        window as unknown as {
          __embed: {
            internals(el: Element): {
              editor: { core: { setCounts(c: { comments?: number; catchUp?: number }): void } };
            };
          };
        }
      ).__embed;
      e.internals(document.querySelector(sel)!).editor.core.setCounts({ comments: 3 });
    }, editor);
    await expect
      .poll(async () => {
        const h = await hostHeader(page);
        return [h.comments, h.catchUp];
      })
      .toEqual(['3', 'unknown']);

    // Removing the attribute brings the built-in header back, without a reload.
    await page.evaluate((sel) => document.querySelector(sel)!.removeAttribute('header'), editor);
    await expect(page.locator(`${editor} .de-header`)).toHaveCount(1);
  });
});
