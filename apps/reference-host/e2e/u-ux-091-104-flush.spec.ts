/**
 * The author types, the service does not confirm the work, and the host navigates away: the page
 * waits for `flush` before it leaves, `flush` rejects at its timeout, the guard takes its `kept`
 * branch, and the typed work comes back from the journal when the document is opened again (UX-093
 * criterion 3). Lane U-UX-091-104, round 6; reworked by the round 6 fixer.
 *
 * The editing connection is a WebSocket (packages/backend-dep/src/connection.ts), which
 * `page.route` does not intercept. The test therefore routes the service's WebSocket with
 * `context.routeWebSocket`, forwards every frame both ways, and drops the page's `sync.submit`
 * frames while the service is to refuse the work: the commit is never stored and never
 * acknowledged, as when the service cannot take it.
 *
 * Run against a stack that is already up (see u-ux-091-104-stack.spec.ts for the ports):
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/u-ux-091-104-flush.spec.ts
 *
 * The test creates its own document, titled with the lane's name, and types one marker into it.
 */
import { expect, test, type Page } from '@playwright/test';
import { editor, openDocument, PEOPLE, recordEvents, serviceUrl, typeAtEnd } from './support.ts';

const RUN = Date.now().toString(36);
const MARKER = `U-UX-091-104 flush ${RUN}`;
/** The guard's timeout in the editor page (`+page.svelte`, `flushBeforeNavigation(editor, 3000)`). */
const GUARD_TIMEOUT_MS = 3000;

/** Whether a frame the page sends is a `sync.submit` (05 §5.3): one JSON message per text frame. */
function isSubmit(frame: string | Buffer): boolean {
  if (typeof frame !== 'string') return false;
  try {
    return (JSON.parse(frame) as { t?: unknown }).t === 'sync.submit';
  } catch {
    return false;
  }
}

/**
 * The text the element's IndexedDB journal holds for `docId` (`docedit-journal`, commits and
 * queue; packages/element/src/journal-idb.ts), as one string per commit and one for the queue.
 */
function journalTexts(page: Page, docId: string): Promise<string[]> {
  return page.evaluate(
    (docId) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('docedit-journal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('commits') || !db.objectStoreNames.contains('queues')) {
            db.close();
            resolve([]);
            return;
          }
          const t = db.transaction(['commits', 'queues'], 'readonly');
          const commits = t.objectStore('commits').getAll();
          const queue = t.objectStore('queues').get(docId);
          t.onerror = () => reject(t.error);
          t.oncomplete = () => {
            db.close();
            const texts = (steps: unknown) =>
              [...JSON.stringify(steps).matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)]
                .map((m) => m[1])
                .join('');
            const rows = commits.result as Array<{ docId: string; steps: unknown[] }>;
            resolve([
              ...rows.filter((r) => r.docId === docId).map((r) => texts(r.steps)),
              texts((queue.result as { steps?: unknown } | undefined)?.steps ?? []),
            ]);
          };
        };
      }),
    docId,
  );
}

test('a host navigation waits for flush; work that could not be confirmed returns with the document (UX-093 criterion 3)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await recordEvents(context);
  // The service's WebSocket, routed from the first page on: frames pass both ways, except the
  // page's `sync.submit` frames while `refusing` is set, which are dropped (never stored, never
  // acknowledged).
  const servicePort = new URL(serviceUrl()).port;
  let refusing = false;
  let dropped = 0;
  let forwardedSubmits = 0;
  await context.routeWebSocket(
    (url) => url.port === servicePort,
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((frame) => {
        if (isSubmit(frame)) {
          if (refusing) {
            dropped++;
            return;
          }
          forwardedSubmits++;
        }
        server.send(frame);
      });
      server.onMessage((frame) => ws.send(frame));
    },
  );
  const page = await context.newPage();
  // A second person's view of the service, with no journal of the first context and no routing:
  // what the service itself holds.
  const witness = await browser.newContext();
  await recordEvents(witness);
  const witnessPage = await witness.newPage();
  try {
    // Create the document from the list, then open it from the list by a link: the list and the
    // editor are then two pages of one client-side session, so Back leaves the editor through the
    // page's navigation guard (beforeNavigate), the path that waits for flush.
    await page.goto('/');
    await page.getByRole('button', { name: `Continue as ${PEOPLE.olivia.name}` }).click();
    await page.getByLabel('Title', { exact: true }).fill(`U-UX-091-104 flush doc ${RUN}`);
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
    const docId = page.url().split('/').pop()!;
    await page.goto(`/as/${PEOPLE.olivia.sub}/`);
    await page.locator(`tr[data-document="${docId}"] a`).first().click();
    await expect(page).toHaveURL(new RegExp(`/docs/${docId}$`));
    await expect
      .poll(
        () => page.evaluate(() => (window.__deEvents ?? []).some((e) => e.name === 'de-ready')),
        {
          timeout: 60_000,
        },
      )
      .toBe(true);

    // Record the element's flush calls, and the moment the editor leaves the page.
    await page.evaluate(() => {
      type Entry = { start: number; end?: number; ok?: boolean; error?: string };
      const el = document.querySelector('doc-editor') as unknown as {
        flush: (o: unknown) => Promise<unknown>;
      };
      const log: Entry[] = [];
      const orig = el.flush.bind(el);
      el.flush = (o: unknown) => {
        const entry: Entry = { start: performance.now() };
        log.push(entry);
        return orig(o).then(
          (v) => {
            entry.end = performance.now();
            entry.ok = true;
            return v;
          },
          (err: unknown) => {
            entry.end = performance.now();
            entry.ok = false;
            entry.error = err instanceof Error ? err.message : String(err);
            throw err;
          },
        );
      };
      const w = window as unknown as { __flush: Entry[]; __leftAt?: number; __outcome?: string };
      w.__flush = log;
      const observer = new MutationObserver(() => {
        // The guard shows its outcome ("Last flush: kept") before the host's navigation completes.
        const shown = [...document.querySelectorAll('span')].find((s) =>
          s.textContent?.startsWith('Last flush:'),
        );
        if (shown && !w.__outcome)
          w.__outcome = (shown.textContent ?? '').slice('Last flush:'.length).trim();
        if (!w.__leftAt && !document.querySelector('doc-editor')) {
          w.__leftAt = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    // Work the service does not confirm: from here the page's submits are dropped.
    refusing = true;
    await typeAtEnd(page, editor(page).locator('p.de-p').first(), ` ${MARKER}`);
    await expect(editor(page).locator('p.de-p').first()).toContainText(MARKER);
    await expect
      .poll(() => dropped, { message: 'the page submitted the typed work', timeout: 20_000 })
      .toBeGreaterThan(0);
    // The typed work is in the journal before the host navigates (FE-008).
    await expect
      .poll(async () => (await journalTexts(page, docId)).join(''), {
        message: 'the typed work is journalled',
      })
      .toContain(MARKER);

    // The host navigates away (Back): the guard must wait for flush before the page changes.
    await page.goBack();
    await expect(page.getByRole('button', { name: 'Create and open' })).toBeVisible({
      timeout: 60_000,
    });
    const timing = await page.evaluate(() => {
      const w = window as unknown as {
        __flush?: { start: number; end?: number; ok?: boolean; error?: string }[];
        __leftAt?: number;
        __outcome?: string;
      };
      return { calls: w.__flush ?? [], leftAt: w.__leftAt ?? null, outcome: w.__outcome ?? null };
    });
    expect(timing.calls.length, 'flush was called by the guard').toBe(1);
    const [call] = timing.calls;
    expect(call?.end, 'flush settled before the page changed').toBeDefined();
    // The work was not confirmed, so flush rejects at the guard's timeout (05 §8.1; PRO-083).
    expect(call?.ok, 'flush rejected').toBe(false);
    expect(call?.error ?? '', 'the rejection names the unconfirmed commits').toMatch(
      /unconfirmed commits remain/,
    );
    const waited = (call?.end ?? 0) - (call?.start ?? 0);
    test.info().annotations.push({
      type: 'flush-wait',
      description: `flush rejected after ${Math.round(waited)} ms (performance.now in the page)`,
    });
    // A 50 ms allowance for the timer's granularity in the page.
    expect(waited, 'flush rejected at its timeout, not before').toBeGreaterThanOrEqual(
      GUARD_TIMEOUT_MS - 50,
    );
    expect(timing.outcome, 'the guard took its kept branch').toBe('kept');
    expect(timing.leftAt, 'the editor left the page').not.toBeNull();
    expect(
      (timing.leftAt ?? 0) >= (call?.end ?? Number.POSITIVE_INFINITY),
      'the page changed only after flush settled',
    ).toBe(true);

    // The work stayed in the journal, and the service does not have it: a fresh context, with no
    // journal of its own and no routing, opens the document without the marker.
    expect((await journalTexts(page, docId)).join(''), 'the work stays in the journal').toContain(
      MARKER,
    );
    await witnessPage.goto('/');
    await witnessPage.getByRole('button', { name: `Continue as ${PEOPLE.olivia.name}` }).click();
    await expect(witnessPage).toHaveURL(new RegExp(`/as/${PEOPLE.olivia.sub}/?$`));
    await openDocument(witnessPage, PEOPLE.olivia, docId);
    await expect(editor(witnessPage).locator('p.de-p').first()).toBeVisible();
    expect(
      (await editor(witnessPage).locator('p.de-p').first().textContent()) ?? '',
      'the service did not store the work',
    ).not.toContain(MARKER);

    // The service takes work again: the author returns to the document from the list, and the
    // journal brings the work back and submits it.
    refusing = false;
    const submitsBefore = forwardedSubmits;
    // (The guard's navigation replaces the forward entry, so the document is opened from the list.)
    await page.locator(`tr[data-document="${docId}"] a`).first().click();
    await expect(page).toHaveURL(new RegExp(`/docs/${docId}$`));
    await expect
      .poll(async () => (await editor(page).locator('p.de-p').first().textContent()) ?? '', {
        timeout: 60_000,
        message: 'the typed work reappears on return',
      })
      .toContain(MARKER);
    await expect
      .poll(() => forwardedSubmits - submitsBefore, {
        message: 'the journalled work was submitted on return',
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    // Once confirmed, the service has it: the witness loads the document again and sees it.
    await expect
      .poll(
        async () => {
          await openDocument(witnessPage, PEOPLE.olivia, docId);
          return (await editor(witnessPage).locator('p.de-p').first().textContent()) ?? '';
        },
        { timeout: 60_000, message: 'the service stored the returned work' },
      )
      .toContain(MARKER);
  } finally {
    await witness.close();
    await context.close();
  }
});
