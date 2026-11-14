/**
 * UX-104 criterion 2 (lane V-UX-091-104, fixer round 1): given a host that handles access requests,
 * when the reader asks for access to hidden content in a mounted `<doc-editor>`, the element raises
 * `de-access-request` on the host with identifiers only (`{ docId, scope }`) and sends nothing
 * itself (no network request leaves the page between the click and the event).
 *
 * The mock service never stores a `hidden_region` (a stored document may not contain one; ADR 0019)
 * and does not project documents per reader, so this test projects one itself: the backend's
 * `loadContent` is wrapped so that the regions document arrives with its "Middle" region replaced
 * by the `hidden_region` placeholder, as a server projection would send it.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/ux-104-access-request.spec.ts --project=chromium --output <scratch dir>`.
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

interface Mounted {
  docId: string;
  regionId: string;
}

test.describe('asking for access to hidden content (UX-104, criterion 2)', () => {
  test('the element raises de-access-request for the host and sends nothing itself', async ({
    page,
  }) => {
    // The engine reports the `hidden` access limit when a node selection holds a placeholder
    // (`#accessSummary` in packages/engine/src/core.ts), so the status bar offers "Ask for access".
    await openEmbed(page);
    const mounted: Mounted = await page.evaluate(async () => {
      const e = (window as unknown as { __embed: Record<string, unknown> }).__embed as unknown as {
        backend(
          sub: string,
          role: string,
        ): {
          sync: { loadContent(docId: string, seq?: number): Promise<unknown> } & Record<
            string,
            unknown
          >;
        };
        regionsDocId: string;
        REGION_IDS: { region: string };
      };
      const docId = e.regionsDocId;
      const regionId = e.REGION_IDS.region;
      const backend = e.backend('ada', 'viewer');
      const load = backend.sync.loadContent.bind(backend.sync);
      // The projection a server would send this reader: the region is replaced by its placeholder.
      const project = (node: unknown): unknown => {
        if (!node || typeof node !== 'object') return node;
        const n = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
        if (n.type === 'region' && n.attrs?.id === regionId)
          return { type: 'hidden_region', attrs: { id: regionId, title: null } };
        return n.content ? { ...n, content: n.content.map(project) } : n;
      };
      backend.sync = {
        ...backend.sync,
        loadContent: async (d: string, s?: number) => {
          const c = (await load(d, s)) as { envelope?: { doc: unknown }; doc?: unknown };
          if (d !== docId) return c;
          if (c.envelope)
            return { ...c, envelope: { ...c.envelope, doc: project(c.envelope.doc) } };
          return { ...c, doc: project(c.doc) };
        },
      };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'one';
      const w = window as unknown as { __ux104: unknown[] };
      w.__ux104 = [];
      el.addEventListener('de-access-request', (ev) => w.__ux104.push((ev as CustomEvent).detail));
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
      el.backend = backend;
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
      return { docId, regionId };
    });
    const editor = page.locator('doc-editor[data-test="one"]');
    const placeholder = editor.locator('.de-hidden-region');
    await expect(placeholder).toBeVisible();
    await placeholder.click();
    // Criterion 1: the status bar says in plain words that the reader has no access.
    await expect(
      editor
        .locator('[data-status="hidden"]')
        .getByText('You do not have access to this part of the document.'),
    ).toBeVisible();

    const requests: string[] = [];
    page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
    page.on('websocket', (ws) => requests.push(`websocket ${ws.url()}`));
    const ask = editor.getByRole('button', { name: 'Ask for access' });
    await expect(ask).toBeVisible();
    await ask.click();
    await expect(
      editor.locator('[data-status="hidden"]').getByText('Your request for access was passed on.'),
    ).toBeVisible();

    const seen = await page.evaluate(() => (window as unknown as { __ux104: unknown[] }).__ux104);
    expect(seen).toEqual([{ docId: mounted.docId, scope: `region:${mounted.regionId}` }]);
    expect(requests).toEqual([]);
  });
});
