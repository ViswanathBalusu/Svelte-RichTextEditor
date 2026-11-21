/**
 * SEC-007 criteria 1 and 2 (lane w3, 2026-11-15): a full session of the element against the real
 * wire service (tests/security/test/support/harness.ts, memory storage, a real WebSocket), with
 * the element's own IndexedDB journal (src/journal-idb.ts), a host-signed token, an export the
 * element itself starts (`requestExport`; the harness runs an export handler, so the service
 * announces `exports`) and, where the browser lets a test paste a file, a pasted picture that the
 * element hands to the service's assets routes (the harness runs the asset worker, so the service
 * announces `assets`).
 *
 * Criterion 1. The journal clause needs rows to look at, and an acknowledged commit leaves the
 * journal at once. The test therefore holds the service's log append (a gate around
 * `parts.logs.append`, test code only), types, and reads the journal while the commit is still
 * being stored. Each row of the `commits` store must hold a commit and nothing else (`docId`, `id`,
 * `base`, `steps`, and `origin` when set), the `queues` rows `docId` and `steps`, and no string in
 * any store may be the token, a part of it, or look like a signed token. The gate is then opened,
 * and `localStorage`, `sessionStorage`, every IndexedDB database, the cookies (the page's and the
 * browser context's, which include HttpOnly ones) and the addresses the page visited are scanned
 * for the token.
 *
 * Criterion 2. Every request address and body and every WebSocket address of the session is
 * scanned for the token. The export addresses (`POST /v1/documents/{id}/exports` and the job reads
 * under `/v1/exports/{job}`) are asked for by the element. The asset address
 * (`POST /v1/documents/{id}/assets`) is asked for by the element when the picture is pasted. With
 * memory storage the upload address the service answers is `memory://…`, which no browser fetches,
 * and the element has no code that displays an asset picture, so no asset read address exists in
 * the session; see the story Notes.
 *
 * Firefox ignores the clipboardData of a synthetic ClipboardEvent (sec-005-image-paste.spec.ts), so
 * the picture step is left out there.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/sec-007-wire-storage.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { unsandboxed } from '../../../services/asset-worker/src/index.ts';
import { startHarness } from '../../../tests/security/test/support/harness.ts';
import { openEmbed } from './embed-helpers.ts';

const DEMO_PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const ORIGIN = `http://127.0.0.1:${DEMO_PORT}`;
const NAME = 'sec-007-wire-storage';

interface StoreDump {
  database: string;
  store: string;
  rows: unknown[];
}

/** Every IndexedDB database of the page, row by row. The journal database is opened by name too. */
async function dumpIndexedDb(page: Page): Promise<StoreDump[]> {
  return page.evaluate(async () => {
    const names = new Set<string>(['docedit-journal']);
    if (typeof indexedDB.databases === 'function')
      for (const info of await indexedDB.databases()) if (info.name) names.add(info.name);
    const out: Array<{ database: string; store: string; rows: unknown[] }> = [];
    for (const name of names) {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      });
      if (!db) continue;
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result as unknown[]);
          req.onerror = () => reject(req.error ?? new Error('getAll failed'));
        });
        out.push({ database: name, store, rows: JSON.parse(JSON.stringify(rows)) as unknown[] });
      }
      db.close();
    }
    return out;
  });
}

/** The page's `localStorage`, `sessionStorage` and `document.cookie` as one text. */
async function webStorageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.cookie];
    for (const store of [localStorage, sessionStorage])
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i) ?? '';
        parts.push(k, store.getItem(k) ?? '');
      }
    return parts.join('\n');
  });
}

/** A 2 by 2 PNG header: enough for the element to read the size (src/assets.ts). */
function pngBytes(): number[] {
  const u32 = (n: number): number[] => [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ];
  return [
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32(13),
    ...[0x49, 0x48, 0x44, 0x52],
    ...u32(2),
    ...u32(2),
    ...[8, 6, 0, 0, 0, 0, 0, 0, 0],
  ];
}

test('SEC-007: a full wire session leaves no token in storage, journal, cookies, history or any address', async ({
  page,
  browserName,
}) => {
  test.setTimeout(150_000);
  const h = await startHarness('memory', {
    port: 0,
    jobHandlers: {
      export: async (_job, ctx) => {
        await ctx.report('converting', 10);
        return { output: 'output.pdf', pages: 1 };
      },
    },
    assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
  });
  // The gate around the log append: while `hold` is set, a commit stays "being stored".
  let hold: Promise<void> | null = null;
  let open: () => void = () => {};
  const logs = h.parts.logs as { append: (...args: unknown[]) => Promise<unknown> };
  const append = logs.append.bind(logs);
  logs.append = async (...args: unknown[]) => {
    if (hold) await hold;
    return append(...args);
  };
  try {
    await h.parts.registry.addOrigin(h.a.id, ORIGIN);
    const docId = await h.createDocument(h.a);
    const token = h.userToken(h.a, 'ada', { [docId]: 'editor' });
    const [head, payload, signature] = token.split('.') as [string, string, string];
    // The token, and each of its three parts: a leak of the claims alone is a leak too.
    const needles = [token, head, payload, signature, signature.slice(-40)];
    const clean = (text: string, where: string): void => {
      for (const n of needles) expect(text, `${where} holds no token`).not.toContain(n);
      expect(text, `${where} holds nothing shaped like a signed token`).not.toMatch(
        /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
      );
    };

    const seen: string[] = [];
    const addresses: string[] = [];
    page.on('request', (r) => {
      addresses.push(`${r.method()} ${r.url()}`);
      seen.push(r.url());
      const body = r.postData();
      if (body) seen.push(body);
    });
    page.on('websocket', (ws) => {
      addresses.push(`WS ${ws.url()}`);
      seen.push(ws.url());
    });
    const visited: string[] = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) visited.push(f.url());
    });

    await openEmbed(page);
    const historyBefore = await page.evaluate(() => history.length);
    await page.evaluate(
      async ({ endpoint, docId, token, name }) => {
        const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
        el.dataset['test'] = name;
        el.setAttribute('endpoint', endpoint);
        el.setAttribute('doc-id', docId);
        el['getToken'] = async () => token;
        const ready = new Promise<void>((resolve, reject) => {
          el.addEventListener('de-ready', () => resolve(), { once: true });
          el.addEventListener(
            'de-error',
            (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
            { once: true },
          );
        });
        document.getElementById('mount')!.append(el);
        await ready;
      },
      { endpoint: h.base, docId, token, name: NAME },
    );

    const surface = page.locator(`doc-editor[data-test="${NAME}"] .de-editing-surface`);
    await expect(surface).toBeVisible();
    await surface.locator('p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' sec007first');
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 15_000 })
      .toContain('sec007first');

    // The export, started by the element: the service announces `exports`, so it is not refused.
    const jobId = await page.evaluate(async (name) => {
      const el = document.querySelector(`doc-editor[data-test="${name}"]`) as HTMLElement & {
        flush(): Promise<void>;
        requestExport(o: unknown): Promise<{ jobId: string }>;
      };
      await el.flush();
      return (await el.requestExport({ target: 'pdf', options: { profile: 'final' } })).jobId;
    }, NAME);
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      addresses.some((a) => a === `POST ${h.base}/v1/documents/${docId}/exports`),
      'the element asked for the export address',
    ).toBe(true);
    await expect
      .poll(() => addresses.some((a) => a === `GET ${h.base}/v1/exports/${jobId}`), {
        timeout: 15_000,
        message: 'the element read the export job by its address',
      })
      .toBe(true);

    // The picture: the element asks the service's assets route for an upload.
    if (browserName !== 'firefox') {
      await page.evaluate(
        ({ name, bytes }) => {
          const host = document.querySelector(`doc-editor[data-test="${name}"]`)!;
          const target = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array(bytes)], 'dot.png', { type: 'image/png' }));
          target.dispatchEvent(
            new ClipboardEvent('paste', { bubbles: true, composed: true, clipboardData: dt }),
          );
        },
        { name: NAME, bytes: pngBytes() },
      );
      await expect
        .poll(() => addresses.some((a) => a === `POST ${h.base}/v1/documents/${docId}/assets`), {
          timeout: 15_000,
          message: 'the element asked for the asset address',
        })
        .toBe(true);
    }

    // The journal while a commit is still being stored.
    hold = new Promise<void>((resolve) => (open = resolve));
    await surface.locator('p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' sec007held');
    const journal = (dump: StoreDump[]) => dump.filter((d) => d.database === 'docedit-journal');
    await expect
      .poll(
        async () =>
          journal(await dumpIndexedDb(page))
            .filter((d) => d.store === 'commits')
            .reduce((n, d) => n + d.rows.length, 0),
        { timeout: 15_000, message: 'a commit is in the journal while it is being stored' },
      )
      .toBeGreaterThan(0);
    const held = await dumpIndexedDb(page);
    expect(
      journal(held)
        .map((d) => d.store)
        .sort(),
    ).toEqual(['commits', 'queues', 'recovered']);
    const commitRows = journal(held).find((d) => d.store === 'commits')!.rows as Array<
      Record<string, unknown>
    >;
    for (const row of commitRows) {
      // A journal row is the commit as it was sent, and the document it belongs to, with the log
      // incarnation and the user's identifier that the next visit checks before it resubmits it
      // (FE-009; decision 47 of docs/owner-decisions-2026-11-15.md); nothing else. The whole dump
      // is also checked for the token below (`clean`).
      const extra = Object.keys(row).filter(
        (k) => !['docId', 'id', 'base', 'steps', 'origin', 'incarnation', 'user'].includes(k),
      );
      expect(extra, 'a journal row holds a commit only').toEqual([]);
      expect(row['docId']).toBe(docId);
      expect(typeof row['id']).toBe('string');
      expect(typeof row['base']).toBe('number');
      expect(Array.isArray(row['steps'])).toBe(true);
      expect((row['steps'] as unknown[]).length, 'the row holds steps').toBeGreaterThan(0);
    }
    for (const row of journal(held).find((d) => d.store === 'queues')!.rows as Array<
      Record<string, unknown>
    >) {
      // The steps, and the confirmed document they were made on (seq, incarnation, user id; FE-009).
      expect(
        Object.keys(row)
          .filter((k) => k !== 'at')
          .sort(),
        'a queue row holds steps only',
      ).toEqual(['docId', 'steps']);
      if (row['at'] !== undefined)
        expect(
          Object.keys(row['at'] as object)
            .sort()
            .filter((k) => !['incarnation', 'seq', 'user'].includes(k)),
          'the position of a queue is a sequence number, an incarnation and a user',
        ).toEqual([]);
    }
    clean(JSON.stringify(held), 'IndexedDB, with a commit in the journal');

    // The commit is stored; the session ends with everything acknowledged.
    open();
    hold = null;
    await page.evaluate(async (name) => {
      const el = document.querySelector(`doc-editor[data-test="${name}"]`) as HTMLElement & {
        flush(): Promise<void>;
      };
      await el.flush();
    }, NAME);
    await expect
      .poll(
        async () =>
          journal(await dumpIndexedDb(page))
            .filter((d) => d.store === 'commits')
            .reduce((n, d) => n + d.rows.length, 0),
        { timeout: 15_000 },
      )
      .toBe(0);
    await page.evaluate((name) => {
      document.querySelector(`doc-editor[data-test="${name}"]`)!.remove();
    }, NAME);
    await page.waitForTimeout(300);

    // Afterwards: storage, IndexedDB, cookies and history.
    clean(await webStorageText(page), 'localStorage, sessionStorage or document.cookie');
    clean(JSON.stringify(await dumpIndexedDb(page)), 'IndexedDB');
    const cookies = await page.context().cookies();
    clean(cookies.map((c) => `${c.name}=${c.value}`).join('\n'), 'the cookie jar');
    expect(visited.length, 'the page was visited').toBeGreaterThan(0);
    for (const url of [...visited, page.url()]) clean(url, 'a visited address');
    expect(await page.evaluate(() => history.length), 'the session added no history entry').toBe(
      historyBefore,
    );

    // The network log: addresses and bodies.
    expect(
      seen.some((s) => s.startsWith('ws')),
      'the session opened a WebSocket',
    ).toBe(true);
    for (const s of seen) clean(s, 'a request address or body');
    test.info().annotations.push({
      type: 'addresses',
      description: [...new Set(addresses.map((a) => a.replace(/[0-9a-f-]{36}/g, '{id}')))].join(
        ' | ',
      ),
    });
  } finally {
    open();
    await h.close();
  }
});
