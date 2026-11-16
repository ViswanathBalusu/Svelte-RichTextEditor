/**
 * PRM-019 criterion 1, PRM-020 criterion 4 and PRM-024 criterion 5, against the demo stack (the
 * real document service, room and PostgreSQL), each person in a browser context of their own:
 *
 *   1. the owner reduces Bob's role in his region from `editor` to `viewer`; Bob's open page hears
 *      `perm.changed` and stops accepting typing there, without a reload (07 §9);
 *   2. Bob's commit, made before `perm.changed` reached him, is refused because the grant was
 *      withdrawn; the rejection shows in his tab, and his access then equals the server's (01 §4.3).
 *
 * The owner changes grants with her own token over `PATCH /documents/{id}/grants` (05 §6.2), since
 * the host's panel only gives or takes `editor`. For step 2 the test holds the messages the service
 * sends to Bob's page (Playwright's WebSocket route), which is a slow network and nothing else: the
 * service, the room and the client are the real ones.
 */
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import {
  editor,
  eventsOf,
  hostToken,
  openDocument,
  PEOPLE,
  recordEvents,
  regionParagraph,
  serviceUrl,
  signIn,
  typeAtEnd,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const TITLE = `Grant reduced ${Date.now().toString(36)}`;
const DELIVERY = 'Delivery section';
const BOB_REGION = 'rBobSection00001';
const SCOPE = `region:${BOB_REGION}`;

let docId = '';
const contexts: BrowserContext[] = [];
let op: Page; // Olivia, the owner
let ap: Page; // Ada, who watches
let bp: Page; // Bob, editor of the delivery section

/** Messages from the service to Bob's page are kept here while `held` is true. */
let held = false;
const waiting: Array<() => void> = [];
let fromServer = 0;

function release(): void {
  held = false;
  for (const send of waiting.splice(0)) send();
}

interface AccessDetail {
  rev: number;
  scopes: Record<string, string[]>;
}

async function lastAccess(page: Page): Promise<AccessDetail | null> {
  const all = await eventsOf(page, 'de-permission-change');
  return (all.at(-1)?.detail as AccessDetail | undefined) ?? null;
}

async function lastSync(page: Page): Promise<string | null> {
  const all = await eventsOf(page, 'de-status');
  return (all.at(-1)?.detail as { sync?: string } | undefined)?.sync ?? null;
}

interface Grant {
  region: string;
  principal: string;
  role: string;
}

/** The owner sets Bob's grant on his region, or removes it (`null`), with her own token. */
async function setBobsRole(role: 'editor' | 'viewer' | null): Promise<void> {
  const token = (await hostToken(contexts[0]!, PEOPLE.olivia, docId)).token;
  const url = `${serviceUrl()}/v1/documents/${docId}/grants`;
  const read = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  expect(read.status, 'the owner reads the grants').toBe(200);
  const etag = read.headers.get('etag') ?? '';
  const principal = `user:${PEOPLE.bob.sub}`;
  const grants = ((await read.json()) as { grants: Grant[] }).grants
    .filter((g) => !(g.region === BOB_REGION && g.principal === principal))
    .map((g) => ({ region: g.region, principal: g.principal, role: g.role }));
  if (role) grants.push({ region: BOB_REGION, principal, role });
  const write = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'If-Match': etag,
    },
    body: JSON.stringify({ grants }),
  });
  expect(write.status, `the owner sets Bob's role to ${String(role)}`).toBe(200);
}

test.beforeAll(async ({ browser }) => {
  for (let i = 0; i < 3; i++) {
    const c = await browser.newContext();
    await recordEvents(c);
    contexts.push(c);
  }
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const [owner, watcher, bob] = pages;
  if (!owner || !watcher || !bob) throw new Error('three pages expected, one per person');
  [op, ap, bp] = [owner, watcher, bob];
  await bp.routeWebSocket(/.*/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      fromServer++;
      if (held) waiting.push(() => ws.send(m));
      else ws.send(m);
    });
  });
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

test('0. the owner creates the document; Ada and Bob open it, Bob as editor of his region', async () => {
  await signIn(op, PEOPLE.olivia);
  await op.getByLabel('Title', { exact: true }).fill(TITLE);
  await op.getByRole('button', { name: 'Create and open' }).click();
  await expect(op).toHaveURL(/\/as\/u-olivia\/docs\/[0-9a-f-]{36}$/);
  docId = op.url().split('/').pop()!;
  await Promise.all([signIn(ap, PEOPLE.ada), signIn(bp, PEOPLE.bob)]);
  await Promise.all([openDocument(ap, PEOPLE.ada, docId), openDocument(bp, PEOPLE.bob, docId)]);
  await expect.poll(async () => (await lastAccess(bp))?.scopes[SCOPE]).toContain('edit');
  // The route sees Bob's channel: the service's messages pass through it.
  expect(fromServer).toBeGreaterThan(0);
  await typeAtEnd(bp, regionParagraph(bp, DELIVERY), ' Bob was here.');
  await expect(regionParagraph(ap, DELIVERY)).toContainText('Bob was here.');
  await expect.poll(() => lastSync(bp)).toBe('saved');
});

test("1. the owner reduces Bob's role from editor to viewer: his tab hears it and stops accepting typing, without a reload (PRM-019)", async () => {
  await bp.evaluate(() => {
    window.__pageMarker = 'loaded once';
  });
  const before = (await lastAccess(bp))?.rev ?? 0;
  await setBobsRole('viewer');
  // `perm.changed` reaches the open page: a new access revision without `edit` in the region.
  await expect.poll(async () => (await lastAccess(bp))?.rev ?? 0).toBeGreaterThan(before);
  const access = await lastAccess(bp);
  expect(access?.scopes[SCOPE]).toContain('view');
  expect(access?.scopes[SCOPE]).not.toContain('edit');
  expect(await bp.evaluate(() => window.__pageMarker)).toBe('loaded once');
  // Typing in the region is no longer accepted, in his tab or anywhere else.
  const text = (await regionParagraph(bp, DELIVERY).textContent()) ?? '';
  await typeAtEnd(bp, regionParagraph(bp, DELIVERY), ' Not allowed.');
  await expect(regionParagraph(bp, DELIVERY)).toHaveText(text);
  await ap.waitForTimeout(1500);
  await expect(regionParagraph(ap, DELIVERY)).toHaveText(text);
  expect(await bp.evaluate(() => window.__pageMarker)).toBe('loaded once');
});

test('2. a commit Bob made before perm.changed reached him is refused, the rejection shows in his tab and his access becomes the server`s (PRM-024, PRM-020)', async () => {
  // Bob is an editor of the region again.
  await setBobsRole('editor');
  await expect.poll(async () => (await lastAccess(bp))?.scopes[SCOPE]).toContain('edit');
  const text = (await regionParagraph(bp, DELIVERY).textContent()) ?? '';
  const recoveredBefore = (await eventsOf(bp, 'de-recovered-edits')).length;
  const rev = (await lastAccess(bp))?.rev ?? 0;

  // The network to Bob's page stalls; the owner withdraws his grant meanwhile.
  held = true;
  await setBobsRole(null);
  // Bob has not heard: his page still lets him type, and sends the commit.
  await typeAtEnd(bp, regionParagraph(bp, DELIVERY), ' Too late.');
  await expect(regionParagraph(bp, DELIVERY)).toContainText('Too late.');
  expect((await lastAccess(bp))?.rev).toBe(rev);
  // The room refuses it under the new grants: nobody else ever sees the text.
  await expect.poll(() => waiting.length, { message: 'messages held for Bob' }).toBeGreaterThan(1);
  await ap.waitForTimeout(1500);
  await expect(regionParagraph(ap, DELIVERY)).toHaveText(text);
  release();

  // The rejection is visible in Bob's tab: the refused text is gone and a notice says why.
  await expect(regionParagraph(bp, DELIVERY)).toHaveText(text);
  const notice = editor(bp).locator('[data-status="notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('permissions changed');
  await expect
    .poll(async () => (await eventsOf(bp, 'de-recovered-edits')).length)
    .toBeGreaterThan(recoveredBefore);
  // His access is the server's again: no `edit` in the region (PRM-020 criterion 4).
  // (`rev` counts the access objects of one channel, so it is not compared: a channel reopened
  // during the stall starts again.)
  await expect
    .poll(async () => (await lastAccess(bp))?.scopes[SCOPE] ?? ['edit'])
    .not.toContain('edit');
  // Ada's tab never held the refused text.
  await expect(regionParagraph(ap, DELIVERY)).toHaveText(text);
});
