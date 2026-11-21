/**
 * FE-009 criterion 7: the fault-injection run of the phase 1b exit criteria (11 §4), in real
 * browser tabs.
 *
 * Two people with different grants and one participant who may only fill work on one document
 * through `<doc-editor>` (the library build, with `endpoint` and `getToken`, its DEP client and its
 * IndexedDB journal), each in a browser profile of their own, against the real document service on
 * PostgreSQL. Ada holds the grant on the restricted region and types there and in the body; Grace
 * types in the body before and after it; the participant fills three fields. They type with the
 * keyboard, word after word, for the length of the run.
 *
 * Meanwhile faults are injected at random from a seed: every connection is dropped; the service
 * process is killed and started again; the database is taken away and comes back; and a tab is
 * closed while it holds unconfirmed work (the network is cut first, the person types on, and the tab
 * is closed or, in Chromium every other time, its renderer is crashed) and opened again.
 *
 * When the time is up the faults stop, every tab drains, and the run compares:
 * - every word that was typed and shown by its editor is in the service's document exactly once, or
 *   it is in that person's recovered edits: nothing typed is missing, nothing is applied twice;
 * - every field holds the last value the participant gave it;
 * - a word Grace typed at the restricted region is not in it;
 * - every tab's confirmed text and field values are the service's, and every journal is empty.
 *
 * The run writes its seed, its fault schedule and its result to `reports/` next to this file, and
 * for a run that fails also what each tab last sent and received. A run kept for the record is
 * copied to `runs/`.
 * Skips, with the reason, when PostgreSQL or the object store of the test environment is not up.
 */
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresUnavailable } from '../../services/document-service/test/support/env.ts';
import {
  IDS,
  STREAMS,
  between,
  canonical,
  contentOf,
  objectStoreUnavailable,
  occurrences,
  random,
  regionText,
  sleep,
  startFaultRun,
  type FaultRun,
  type OutageKind,
} from './run.ts';

const MINUTES = Number(process.env['DOCEDIT_FAULT_RUN_MINUTES'] ?? 60);
const SEED = Number(process.env['DOCEDIT_FAULT_RUN_SEED'] ?? Date.now() % 2_147_483_647);
const OUTAGE: OutageKind = process.env['DOCEDIT_FAULT_RUN_OUTAGE'] === 'hook' ? 'hook' : 'postgres';
const PORT = Number(process.env['DOCEDIT_FAULT_RUN_PORT'] ?? 57090);
const PAGE_ORIGIN = `http://127.0.0.1:${PORT}`;
/** Words on one line of a stream before the person presses Enter: short lines never wrap. */
const LINE_WORDS = 6;
/** How long a tab may take to send everything it holds once the faults are over. */
const DRAIN_MS = Number(process.env['DOCEDIT_FAULT_RUN_DRAIN_S'] ?? 180) * 1000;

const skip = (await postgresUnavailable()) ?? (await objectStoreUnavailable());
test.skip(skip !== null, skip ?? '');

type Sub = 'ada' | 'grace' | 'fill';
type FaultKind = 'drop' | 'kill' | 'database' | 'tab';

interface Client {
  readonly sub: Sub;
  readonly context: BrowserContext;
  page: Page;
  /** One turn, or one fault, at a time on this tab. */
  lock: Promise<void>;
  counter: number;
  /** Words the editor showed after they were typed. */
  readonly typed: string[];
  /** Words the editor did not show after they were typed (it was loading or had no surface). */
  readonly notShown: string[];
  /** Words that were shown, but not on the line the person had put the caret on. */
  readonly astray: string[];
  /** Words Grace typed at the restricted region: the editor refuses them. */
  readonly forbidden: string[];
  /** The participant: the last value given to each field. */
  readonly fills: Record<string, string>;
  opens: number;
  /** Turns given up: the editor was loading, or the caret did not go where the person clicked. */
  skippedTurns: number;
  misplacedClicks: number;
  readonly pageErrors: string[];
  /** The last messages of the tab's sockets, for the report of a run that fails. */
  readonly frames: string[];
}

interface PageState {
  status: string;
  error: string;
  ready: number;
  connection: string;
  sync: string;
  recovered: number;
  authRequired: number;
  errors: Array<{ code: string; fatal: boolean }>;
}

interface FaultRecord {
  atS: number;
  kind: FaultKind;
  detail: Record<string, unknown>;
}

let t0 = Date.now();
const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function exclusive<T>(c: Client, run: () => Promise<T>): Promise<T> {
  const next = c.lock.then(run, run);
  c.lock = next.then(
    () => {},
    () => {},
  );
  return next;
}

const stateOf = (page: Page): Promise<PageState> =>
  page.evaluate(() => (window as unknown as { __state: PageState }).__state);

/** Waits until the tab's editor is live. A failed load is retried as a person would: by its button. */
async function untilReady(c: Client, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'loading';
  while (Date.now() < deadline) {
    const state = await stateOf(c.page).catch(() => null);
    last = state?.status ?? 'no page state';
    if (state?.status === 'ready') {
      const surface = c.page.locator('doc-editor .de-editing-surface');
      if (await surface.isVisible().catch(() => false)) return;
    }
    if (state?.status === 'failed') {
      const retry = c.page.locator('doc-editor .de-failure-action');
      if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => {});
    }
    await sleep(500);
  }
  throw new Error(`${c.sub}: the editor was not ready within ${timeoutMs} ms (last: ${last})`);
}

/** One line for a protocol message: its type and what decides how the client goes on. */
function summarise(payload: string | Buffer): string | null {
  try {
    const m = JSON.parse(String(payload)) as {
      t?: string;
      ch?: number;
      d?: Record<string, unknown>;
    };
    const t = m.t ?? '?';
    if (t === 'ping' || t === 'pong' || t.startsWith('presence')) return null;
    const d = m.d ?? {};
    const parts = [m.ch === undefined ? t : `${t}#${m.ch}`];
    for (const key of ['code', 'action', 'catchUp', 'seq', 'base', 'head', 'retryAfterMs'])
      if (d[key] !== undefined) parts.push(`${key}=${String(d[key])}`);
    for (const key of ['resume', 'inflight'])
      if (d[key] !== undefined) parts.push(`${key}=${JSON.stringify(d[key]).slice(0, 160)}`);
    if (typeof d['message'] === 'string') parts.push(`"${d['message'].slice(0, 100)}"`);
    return parts.join(' ');
  } catch {
    return String(payload).slice(0, 60);
  }
}

async function openTab(c: Client, run: FaultRun): Promise<void> {
  const page = await c.context.newPage();
  page.on('pageerror', (e) => c.pageErrors.push(`${elapsed()} ${e.message}`));
  const note = (line: string): void => {
    c.frames.push(`${elapsed()} ${line}`);
    if (c.frames.length > 150) c.frames.shift();
  };
  page.on('websocket', (ws) => {
    note('socket opened');
    ws.on('framesent', (f) => {
      const s = summarise(f.payload);
      if (s !== null) note(`> ${s}`);
    });
    ws.on('framereceived', (f) => {
      const s = summarise(f.payload);
      if (s !== null) note(`< ${s}`);
    });
    ws.on('close', () => note('socket closed'));
  });
  await page.addInitScript(
    (cfg) => {
      (window as unknown as { __run: unknown }).__run = cfg;
    },
    {
      endpoint: run.endpoint,
      docId: run.docId,
      sub: c.sub,
      mode: c.sub === 'fill' ? 'fill' : null,
    },
  );
  await page.goto('/pages/fe-009-fault-run.html');
  c.page = page;
  c.opens++;
  note(`tab opened (${c.opens})`);
  await untilReady(c);
}

async function newClient(browser: Browser, sub: Sub, run: FaultRun): Promise<Client> {
  // A profile of their own: three people on three machines (the journal is bound to the user).
  const context = await browser.newContext();
  await context.exposeFunction('__token', (who: string) => run.token(who));
  const c: Client = {
    sub,
    context,
    page: null as unknown as Page,
    lock: Promise.resolve(),
    counter: 0,
    typed: [],
    notShown: [],
    astray: [],
    forbidden: [],
    fills: {},
    opens: 0,
    skippedTurns: 0,
    misplacedClicks: 0,
    pageErrors: [],
    frames: [],
  };
  await openTab(c, run);
  return c;
}

const surfaceText = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      document.querySelector('doc-editor')?.shadowRoot?.querySelector('.de-editing-surface')
        ?.textContent ?? '',
  );

/**
 * The text of the paragraph the caret is in, read from the browser's selection inside the shadow
 * root, or null when the selection is not in a paragraph of the editor (or cannot be read).
 */
const caretLine = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const root = document.querySelector('doc-editor')?.shadowRoot;
    if (!root) return null;
    const focusNode = (): Node | null => {
      // Chromium gives a shadow root a selection of its own.
      const own = (root as unknown as { getSelection?: () => Selection | null }).getSelection;
      if (typeof own === 'function') return own.call(root)?.focusNode ?? null;
      const selection = document.getSelection();
      if (!selection) return null;
      if (typeof selection.getComposedRanges !== 'function') return selection.focusNode;
      // The dictionary form is the standard one; the older form took the roots as arguments.
      try {
        return selection.getComposedRanges({ shadowRoots: [root] })[0]?.endContainer ?? null;
      } catch {
        const older = selection.getComposedRanges as unknown as (
          this: Selection,
          ...roots: ShadowRoot[]
        ) => StaticRange[];
        return older.call(selection, root)[0]?.endContainer ?? null;
      }
    };
    const node = focusNode();
    if (!node || !root.contains(node)) return null;
    const el = node instanceof Element ? node : node.parentElement;
    return el?.closest('p')?.textContent ?? null;
  });

/** The last line of a stream. `A1` is the stream inside the restricted region. */
function streamLine(page: Page, marker: string): Locator {
  const scope = marker === STREAMS.ada[0] ? '.de-region p' : 'p';
  return page
    .locator(`doc-editor .de-editing-surface ${scope}`)
    .filter({ hasText: new RegExp(`^${marker}`) })
    .last();
}

/**
 * Puts the caret at the end of a line, as a click and the End key do, and looks where it went. A
 * person whose click did not take clicks again; after three tries the turn is given up.
 */
async function caretAtEnd(c: Client, line: Locator): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await line.click({ timeout: 10_000 });
    await c.page.keyboard.press('End');
    const wanted = (await line.textContent()) ?? '';
    const at = await caretLine(c.page);
    // Null: this browser does not say where the selection is; the click is taken as it is.
    if (at === null || at === wanted) return wanted;
    c.misplacedClicks++;
    await sleep(200);
  }
  throw new Error('the caret did not go to the line');
}

/** One word of an editor: at the end of one of their streams, on a new line when the line is full. */
async function typeWord(c: Client, forbidden = false): Promise<void> {
  const own = STREAMS[c.sub as 'ada' | 'grace'];
  const n = ++c.counter;
  // Four words in one stream, then four in the other.
  const marker = forbidden ? STREAMS.ada[0] : own[Math.floor((n - 1) / 4) % 2]!;
  const prefix = forbidden ? 'X' : c.sub === 'ada' ? 'A' : 'G';
  const word = `${prefix}${String(n).padStart(5, '0')}`;
  const text = await caretAtEnd(c, streamLine(c.page, marker));
  if (!forbidden && text.trim().split(/\s+/).length - 1 >= LINE_WORDS) {
    await c.page.keyboard.press('Enter');
    await c.page.keyboard.type(`${marker} `, { delay: 10 });
  }
  await c.page.keyboard.type(`${word} `, { delay: 10 });
  // It counts as typed once the editor shows it.
  let shown = false;
  for (let i = 0; i < 10 && !shown; i++) {
    shown = (await surfaceText(c.page)).includes(word);
    if (!shown) await sleep(100);
  }
  if (forbidden) {
    c.forbidden.push(word);
    return;
  }
  if (!shown) {
    c.notShown.push(word);
    return;
  }
  c.typed.push(word);
  const at = await caretLine(c.page);
  if (at !== null && !(at.startsWith(marker) && at.includes(word))) c.astray.push(word);
}

const FIELDS = [IDS.fieldA, IDS.fieldB, IDS.fieldC] as const;

/** One entry of the participant: a value typed into a field's control, committed with Tab. */
async function fillField(c: Client): Promise<void> {
  const n = ++c.counter;
  const id = FIELDS[(n - 1) % FIELDS.length]!;
  const value = `F${String(n).padStart(5, '0')}`;
  const control = c.page.locator(
    `doc-editor .de-form-field[data-field="${id}"] .de-form-field-control`,
  );
  await control.fill(value, { timeout: 10_000 });
  await control.press('Tab');
  c.fills[id] = value;
}

async function turn(c: Client, next: () => number): Promise<void> {
  try {
    if (c.sub === 'fill') await fillField(c);
    // About one turn of Grace's in twenty is an attempt on the region she may not change.
    else await typeWord(c, c.sub === 'grace' && next() < 0.05);
  } catch {
    // The tab was loading, or its document was being replaced: the person tries again next turn.
    c.skippedTurns++;
  }
}

interface JournalRead {
  commits: number;
  /** Whether the journal holds a commit or queued steps. */
  holdsWork: boolean;
  /** The text the unconfirmed steps insert, joined, and the steps as JSON (for field values). */
  text: string;
  raw: string;
  recovered: string[];
}

/** What the tab's journal holds for the document, read straight from IndexedDB. */
function readJournal(page: Page, docId: string): Promise<JournalRead> {
  return page.evaluate(
    (doc) =>
      new Promise<JournalRead>((resolve, reject) => {
        const open = indexedDB.open('docedit-journal');
        open.onerror = () => reject(open.error ?? new Error('the journal did not open'));
        open.onsuccess = () => {
          const db = open.result;
          const stores = ['commits', 'queues', 'recovered'].filter((s) =>
            db.objectStoreNames.contains(s),
          );
          if (stores.length < 3) {
            db.close();
            resolve({ commits: 0, holdsWork: false, text: '', raw: '', recovered: [] });
            return;
          }
          const t = db.transaction(stores, 'readonly');
          const commits = t.objectStore('commits').getAll();
          const queue = t.objectStore('queues').get(doc);
          const recovered = t.objectStore('recovered').get(doc);
          t.onerror = () => reject(t.error ?? new Error('the journal could not be read'));
          t.oncomplete = () => {
            db.close();
            const rows = (commits.result as Array<{ docId: string; steps: unknown }>).filter(
              (r) => r.docId === doc,
            );
            const queued = (queue.result as { steps?: unknown[] } | undefined)?.steps ?? [];
            const items = (recovered.result as { items?: unknown[] } | undefined)?.items ?? [];
            const raw = JSON.stringify([rows.map((r) => r.steps), queued]);
            resolve({
              commits: rows.length,
              holdsWork: rows.length > 0 || queued.length > 0,
              // Typing is one step for each character: the pieces are joined in their order.
              text: [...raw.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join(''),
              raw,
              recovered: items.map((i) => JSON.stringify(i)),
            });
          };
        };
      }),
    docId,
  );
}

/** Closes a tab that holds unconfirmed work, and opens it again. */
async function closeTab(
  c: Client,
  run: FaultRun,
  next: () => number,
  browserName: string,
  crash: boolean,
): Promise<Record<string, unknown>> {
  return exclusive(c, async () => {
    // The network goes first, so that what is typed now cannot be confirmed.
    run.cutNetwork();
    const before = c.sub === 'fill' ? { ...c.fills } : c.typed.length;
    for (let i = 0; i < 2; i++) await turn(c, () => 1);
    const fresh: string[] =
      c.sub === 'fill'
        ? Object.values(c.fills).filter(
            (v) => !Object.values(before as Record<string, string>).includes(v),
          )
        : c.typed.slice(before as number);
    // The journal takes the work within moments of the keystroke; the person closes the tab after.
    let journalled = false;
    const started = Date.now();
    while (!journalled && Date.now() - started < 5_000) {
      const j = await readJournal(c.page, run.docId).catch(() => null);
      journalled =
        j !== null &&
        fresh.length > 0 &&
        fresh.every((w) => j.text.includes(w) || j.raw.includes(w));
      if (!journalled) await sleep(100);
    }
    const journalMs = Date.now() - started;
    await sleep(500);
    let how = 'closed';
    if (crash && browserName === 'chromium') {
      // A killed tab: the renderer crashes, with no event of any kind in the page.
      const cdp: CDPSession = await c.context.newCDPSession(c.page);
      const crashed = c.page.waitForEvent('crash');
      void cdp.send('Page.crash').catch(() => {});
      await crashed;
      await c.page.close().catch(() => {});
      how = 'renderer crashed';
    } else await c.page.close();
    run.restoreNetwork();
    await sleep(between(next, 500, 4000));
    await openTab(c, run);
    return { tab: c.sub, how, unconfirmed: fresh, journalled, journalMs };
  });
}

function pick(next: () => number): FaultKind {
  const r = next();
  if (r < 0.4) return 'drop';
  if (r < 0.6) return 'kill';
  if (r < 0.8) return 'database';
  return 'tab';
}

test(`FE-009 criterion 7: ${MINUTES} minutes of faults lose nothing typed and apply nothing twice`, async ({
  browser,
  browserName,
}) => {
  const run = await startFaultRun({ pageOrigin: PAGE_ORIGIN, outage: OUTAGE });
  const startedAt = new Date();
  const schedule: FaultRecord[] = [];
  const clients: Client[] = [];
  let failure: unknown = null;
  let result: Record<string, unknown> = {};
  const diagnostics: Record<string, unknown> = {};
  try {
    for (const sub of ['ada', 'grace', 'fill'] as const)
      clients.push(await newClient(browser, sub, run));

    t0 = Date.now();
    const until = t0 + MINUTES * 60_000;
    let stop = false;

    // The people: each types on at a pace of their own, whatever the network does.
    const people = clients.map(async (c, i) => {
      const next = random(SEED + 101 * (i + 1));
      while (!stop && Date.now() < until) {
        await exclusive(c, () => turn(c, next));
        await sleep(c.sub === 'fill' ? between(next, 3000, 7000) : between(next, 900, 2600));
      }
    });

    // The faults: one of each kind first, then at random.
    const faults = (async () => {
      const next = random(SEED);
      const first: FaultKind[] = ['drop', 'tab', 'kill', 'database'];
      let n = 0;
      let crash = false;
      for (;;) {
        const gap = between(next, 12, 35) * 1000;
        if (Date.now() + gap >= until - 20_000) break;
        await sleep(gap);
        const kind = n < first.length ? first[n]! : pick(next);
        n++;
        const atS = Math.round((Date.now() - t0) / 1000);
        const inject = async (): Promise<Record<string, unknown>> => {
          if (kind === 'drop') return { sockets: run.dropConnections() };
          if (kind === 'kill') {
            const downMs = between(next, 1000, 6000);
            await run.killService(downMs);
            return { downMs };
          }
          if (kind === 'database') {
            const ms = between(next, 3000, 9000);
            await run.databaseOutage(ms);
            return { ms };
          }
          const c = clients[between(next, 0, clients.length - 1)]!;
          crash = !crash;
          return closeTab(c, run, next, browserName, crash);
        };
        for (const c of clients) c.frames.push(`${elapsed()} == fault begins: ${kind}`);
        const detail = await inject();
        schedule.push({ atS, kind, detail });
        for (const c of clients)
          c.frames.push(`${elapsed()} == fault over: ${JSON.stringify(detail).slice(0, 120)}`);
      }
    })();

    await faults;
    stop = true;
    await Promise.all(people);

    // The faults are over. Every tab comes back, sends what it holds and says it is saved.
    run.restoreNetwork();
    const stuck: string[] = [];
    for (const c of clients) {
      await c.lock;
      try {
        await untilReady(c);
        await c.page.evaluate(
          (timeoutMs) =>
            (
              document.querySelector('doc-editor') as unknown as {
                flush(o: { timeoutMs: number }): Promise<void>;
              }
            ).flush({ timeoutMs }),
          DRAIN_MS,
        );
        await expect
          .poll(async () => (await stateOf(c.page)).sync, { timeout: 60_000 })
          .toBe('saved');
      } catch (e) {
        stuck.push(`${c.sub}: ${String(e).split('\n')[0]}`);
      }
    }
    // One more look after a pause: nothing may arrive late and change the comparison.
    await sleep(3000);

    // A service that cannot give its document is a failure of the run; the tabs are still read, so
    // that the report says what each of them held.
    let storedError: string | null = null;
    const stored = await run.stored().catch((e: unknown) => {
      storedError = String(e);
      return { seq: -1, doc: null as unknown };
    });
    const server = contentOf(stored.doc);
    const missing: string[] = [];
    const twice: string[] = [];
    const recoveredWords: string[] = [];
    const perPerson: Record<
      string,
      { sameText: boolean; sameFields: boolean; identical: boolean; journalCommits: number }
    > = {};
    for (const c of clients) {
      const journal = await readJournal(c.page, run.docId);
      const kept = journal.recovered.join('\n');
      if (c.sub === 'fill') {
        for (const [id, value] of Object.entries(c.fills)) {
          if (server.fields[id] === value) continue;
          if (kept.includes(value)) recoveredWords.push(value);
          else missing.push(`${id}=${value} (the document holds ${String(server.fields[id])})`);
        }
      } else {
        for (const word of c.typed) {
          const n = occurrences(server.text, word);
          if (n > 1) twice.push(word);
          else if (n === 0) {
            if (kept.includes(word)) recoveredWords.push(word);
            else missing.push(word);
          }
        }
        // A word the editor did not show may have been taken or not; it must not be there twice.
        for (const word of c.notShown) if (occurrences(server.text, word) > 1) twice.push(word);
      }
      const own = (await c.page
        .evaluate(() =>
          (
            document.querySelector('doc-editor') as unknown as {
              getContent(): Promise<{ seq: number; doc: unknown }>;
            }
          ).getContent(),
        )
        .catch(() => ({ seq: -1, doc: null }))) as { seq: number; doc: unknown };
      const state = await stateOf(c.page);
      const mine = contentOf(own.doc);
      const summary = {
        typed: c.sub === 'fill' ? c.counter : c.typed.length,
        notShown: c.notShown,
        astray: c.astray,
        forbidden: c.forbidden.length,
        skippedTurns: c.skippedTurns,
        misplacedClicks: c.misplacedClicks,
        opens: c.opens,
        loadsOfLastTab: state.ready,
        authRequired: state.authRequired,
        errors: state.errors,
        connection: state.connection,
        sync: state.sync,
        recoveredCount: state.recovered,
        pageErrors: c.pageErrors,
        seq: own.seq,
        identical: canonical(own.doc) === canonical(stored.doc),
        sameText: mine.text === server.text,
        sameFields: canonical(mine.fields) === canonical(server.fields),
        journalCommits: journal.commits,
        journalHoldsWork: journal.holdsWork,
      };
      perPerson[c.sub] = summary;
      if (stuck.some((s) => s.startsWith(c.sub)) || !summary.sameText || storedError !== null)
        diagnostics[c.sub] = {
          frames: c.frames.slice(-120),
          shown: await surfaceText(c.page).catch(() => ''),
          journalText: journal.text.slice(-400),
          recovered: journal.recovered.map((r) => r.slice(0, 300)),
        };
    }
    // A word Grace typed at the restricted region must not be in it. (Where her caret could not go
    // into the region, the word is her own text somewhere else, which is not a violation.)
    const grace = clients.find((c) => c.sub === 'grace')!;
    const legal = regionText(stored.doc, IDS.legalRegion);
    const leaked = grace.forbidden.filter((w) => legal.includes(w));
    const counts = Object.fromEntries(
      (['drop', 'kill', 'database', 'tab'] as const).map((k) => [
        k,
        schedule.filter((f) => f.kind === k).length,
      ]),
    );
    result = {
      seq: stored.seq,
      ...(storedError !== null ? { storedError } : {}),
      faults: counts,
      stuck,
      missing,
      appliedTwice: twice,
      keptAsRecovered: recoveredWords,
      forbiddenTyped: grace.forbidden.length,
      forbiddenInRegion: leaked,
      people: perPerson,
      ...run.counts(),
    };
    if (stuck.length > 0 || missing.length > 0 || twice.length > 0)
      diagnostics['serverText'] = server.text;

    // Not vacuous: people typed, every kind of fault happened, and tabs were closed with work in them.
    for (const c of clients)
      expect(c.sub === 'fill' ? c.counter : c.typed.length).toBeGreaterThan(5);
    for (const k of ['drop', 'kill', 'database', 'tab'] as const)
      expect(counts[k], `faults of kind ${k}`).toBeGreaterThan(0);
    expect(
      schedule.filter((f) => f.kind === 'tab' && f.detail['journalled'] === true).length,
    ).toBeGreaterThan(0);
    // The service gave its document, and every tab came back and sent what it held.
    expect(storedError).toBeNull();
    expect(stuck).toEqual([]);
    // Nothing typed is missing, nothing is applied twice.
    expect(missing).toEqual([]);
    expect(twice).toEqual([]);
    expect(leaked).toEqual([]);
    // Every tab ends on the service's document, with an empty journal.
    for (const c of clients) {
      const p = perPerson[c.sub]!;
      expect(p.sameText, `${c.sub} holds the service's text`).toBe(true);
      expect(p.sameFields, `${c.sub} holds the service's field values`).toBe(true);
      expect(p.journalCommits, `${c.sub} has no commit left in the journal`).toBe(0);
    }
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    const report = {
      story: 'FE-009 criterion 7',
      browser: browserName,
      minutes: MINUTES,
      seed: SEED,
      outage: OUTAGE,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      passed: failure === null,
      ...(failure !== null ? { failure: String(failure).slice(0, 2000) } : {}),
      result,
      schedule,
      ...(failure !== null ? { diagnostics } : {}),
    };
    // Not Playwright's output directory, which the next run empties.
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'reports');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `fault-run-${browserName}-${SEED}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    // What the service processes wrote, next to the report of a run that failed.
    if (failure !== null)
      writeFileSync(join(dir, `fault-run-${browserName}-${SEED}.service.log`), run.serviceOutput());
    console.log(`fault run report: ${file}`);
    console.log(
      JSON.stringify({
        passed: report.passed,
        minutes: MINUTES,
        seed: SEED,
        faults: schedule.length,
        result: { ...result, people: undefined },
      }),
    );
    for (const c of clients) await c.context.close().catch(() => {});
    await run.close();
  }
});
