/**
 * The exit check of phase 1a (11 §3; PLAN-1a "Exit check"; UX-091 criterion 5), against the demo
 * stack, through the reference host as a person uses it:
 *
 *   0. the owner creates a document of regions and three paragraph styles, which opens with its title;
 *   1. two tabs with different region grants edit at once;
 *   2. one tab gets a visible rejection when it tries to change the other's region;
 *   3. a grant change takes effect live;
 *   4. the commit log is recorded in full;
 *   5. a PDF from LuaLaTeX in a container without network shows in the PDF panel.
 *
 * Each person has a browser context of their own (their own cookies), as two people would. A step
 * that waits for a piece still being built is marked `test.fail` with the reason and the owner, so
 * that it reports "expected to fail" now and turns red the day it starts passing (remove the mark).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  editor,
  eventsOf,
  hostToken,
  openDocument,
  PEOPLE,
  recordEvents,
  regionParagraph,
  runScript,
  selectWord,
  serviceUrl,
  signIn,
  typeAtEnd,
  workerStatus,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const TITLE = `Exit check ${RUN}`;
const PAYMENT = 'Payment section';
const DELIVERY = 'Delivery section';
const BOB_REGION = 'rBobSection00001';

let docId = '';
let started = 0;
const contexts: BrowserContext[] = [];
let op: Page; // Olivia, the owner
let ap: Page; // Ada, editor of the payment section
let bp: Page; // Bob, editor of the delivery section

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

test.beforeAll(async ({ browser }) => {
  started = Date.now();
  for (let i = 0; i < 3; i++) {
    const c = await browser.newContext();
    await recordEvents(c);
    contexts.push(c);
  }
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const [owner, editorA, editorB] = pages;
  if (!owner || !editorA || !editorB) throw new Error('three pages expected, one per person');
  [op, ap, bp] = [owner, editorA, editorB];
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

test('0. the owner creates a document of regions and three paragraph styles; it opens with its title', async () => {
  await signIn(op, PEOPLE.olivia);
  await op.getByLabel('Title', { exact: true }).fill(TITLE);
  await op.getByRole('button', { name: 'Create and open' }).click();
  await expect(op).toHaveURL(/\/as\/u-olivia\/docs\/[0-9a-f-]{36}$/);
  docId = op.url().split('/').pop()!;
  // The title is the host's, in the element's title slot (UX-094 criterion 2; UX-014).
  await expect(op.getByTestId('title-slot')).toHaveText(TITLE);
  await expect.poll(async () => (await eventsOf(op, 'de-ready')).length).toBeGreaterThan(0);
  // The template's three paragraph styles and two regions are on screen (11 §3).
  const doc = editor(op);
  await expect(doc.locator('p.de-p[data-style="Title"]')).toHaveText('Supply agreement');
  await expect(doc.locator('[data-style="Heading1"]')).toHaveCount(2);
  await expect(doc.locator('p.de-p[data-style="Normal"]').first()).toBeVisible();
  await expect(doc.locator('.de-region')).toHaveCount(2);
});

test('1. two tabs with different region grants edit at once', async () => {
  await Promise.all([signIn(ap, PEOPLE.ada), signIn(bp, PEOPLE.bob)]);
  // The host's list shows the new document to both (UX-094 criterion 1).
  for (const p of [ap, bp]) await expect(p.getByRole('link', { name: TITLE })).toBeVisible();
  await Promise.all([openDocument(ap, PEOPLE.ada, docId), openDocument(bp, PEOPLE.bob, docId)]);
  // Ada may edit the payment section only, Bob the delivery section only (07 §4, `restricted`).
  await expect
    .poll(async () => (await lastAccess(ap))?.scopes[`region:rAdaSection00001`])
    .toContain('edit');
  await expect
    .poll(async () => (await lastAccess(ap))?.scopes[`region:${BOB_REGION}`])
    .not.toContain('edit');
  await expect
    .poll(async () => (await lastAccess(bp))?.scopes[`region:${BOB_REGION}`])
    .toContain('edit');
  // Both type at the same time, each in their own region.
  await Promise.all([
    typeAtEnd(ap, regionParagraph(ap, PAYMENT), ' Ada was here.'),
    typeAtEnd(bp, regionParagraph(bp, DELIVERY), ' Bob was here.'),
  ]);
  for (const p of [ap, bp, op]) {
    await expect(regionParagraph(p, PAYMENT)).toContainText('Ada was here.');
    await expect(regionParagraph(p, DELIVERY)).toContainText('Bob was here.');
  }
  for (const p of [ap, bp]) await expect.poll(() => lastSync(p)).toBe('saved');
});

test('1b. in the two tabs, a selection is replaced and typing is undone, and each sees the other', async () => {
  // Ada selects a word of her section and types over it.
  await selectWord(ap, regionParagraph(ap, PAYMENT), 'thirty');
  await ap.keyboard.type('sixty', { delay: 15 });
  // Bob types and undoes it.
  await typeAtEnd(bp, regionParagraph(bp, DELIVERY), ' Undo me.');
  await expect(regionParagraph(ap, DELIVERY)).toContainText('Undo me.');
  await bp.keyboard.press('ControlOrMeta+z');
  for (const p of [ap, bp]) {
    await expect(regionParagraph(p, PAYMENT)).toContainText('within sixty days');
    await expect(regionParagraph(p, PAYMENT)).not.toContainText('thirty');
    await expect(regionParagraph(p, DELIVERY)).not.toContainText('Undo me.');
    await expect(regionParagraph(p, DELIVERY)).toContainText('Bob was here.');
  }
  for (const p of [ap, bp]) await expect.poll(() => lastSync(p)).toBe('saved');
});

test("2. one tab gets a visible rejection when it tries to change the other's region", async () => {
  const before = (await regionParagraph(bp, DELIVERY).textContent()) ?? '';
  await typeAtEnd(ap, regionParagraph(ap, DELIVERY), 'X');
  // The change is refused: Bob's section is unchanged in both tabs (07 §7; FE-036).
  await expect(regionParagraph(ap, DELIVERY)).toHaveText(before);
  await bp.waitForTimeout(1500);
  await expect(regionParagraph(bp, DELIVERY)).toHaveText(before);
  // And Ada sees why: the shell's status-bar notice (PRM-024; FE-107).
  const notice = editor(ap).locator('[data-status="notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).not.toHaveText('');
});

test('3. a grant change takes effect live', async () => {
  await ap.evaluate(() => {
    window.__pageMarker = 'loaded once';
  });
  const before = (await lastAccess(ap))?.rev ?? 0;
  // The owner gives Ada edit rights on the delivery section in the host's panel (07 §9).
  const row = op.locator(`tr[data-region="${BOB_REGION}"]`);
  await row.getByLabel(`Person for ${DELIVERY}`).selectOption(PEOPLE.ada.sub);
  await row.getByRole('button', { name: 'Give edit rights' }).click();
  await expect(op.getByTestId('host-done')).toContainText('Gave edit rights');
  await expect(op.getByTestId(`editors-${BOB_REGION}`)).toContainText(PEOPLE.ada.name);
  // Ada's open page hears it without a reload (perm.changed; PRO-088): a new access revision
  // with edit in the delivery section.
  await expect.poll(async () => (await lastAccess(ap))?.rev ?? 0).toBeGreaterThan(before);
  expect((await lastAccess(ap))?.scopes[`region:${BOB_REGION}`]).toContain('edit');
  expect(await ap.evaluate(() => window.__pageMarker)).toBe('loaded once');
  // Now her typing there is accepted and reaches Bob.
  await typeAtEnd(ap, regionParagraph(ap, DELIVERY), ' Ada joins.');
  await expect(regionParagraph(bp, DELIVERY)).toContainText('Ada joins.');
  await expect.poll(() => lastSync(ap)).toBe('saved');
});

interface LogReport {
  head: number;
  verdict: { ok: boolean; head?: number; seq?: number; reason?: string };
  grantsRevision: number;
  surrogates: Record<string, string>;
  commits: Array<{
    seq: number;
    kind: string;
    id: string;
    user: string;
    session: string;
    time: number;
    origin: string;
    base: number | null;
    rebased: boolean | null;
    revision: number;
    scopes: string[];
    jti: string | null;
    cdm: number;
    engine: string;
    steps: number;
    inserted: string;
  }>;
}

test('4. the commit log is recorded in full', async () => {
  const subs = [PEOPLE.olivia.sub, PEOPLE.ada.sub, PEOPLE.bob.sub];
  const log = runScript<LogReport>('log-report.ts', [docId, ...subs]);
  // Every accepted commit, in order, without gaps, chained by hash (HIS-001, HIS-002).
  expect(log.head).toBeGreaterThan(0);
  expect(log.commits.map((c) => c.seq)).toEqual(Array.from({ length: log.head }, (_, i) => i + 1));
  expect(log.verdict).toEqual({ ok: true, head: log.head });
  // The service's head is the log's head.
  const token = (await hostToken(contexts[0]!, PEOPLE.olivia, docId)).token;
  const content = await fetch(`${serviceUrl()}/v1/documents/${docId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(content.status).toBe(200);
  expect(((await content.json()) as { seq: number }).seq).toBe(log.head);
  // Every field of each record (08 §2), for a step commit and a control commit.
  const ada = log.surrogates[PEOPLE.ada.sub]!;
  const bob = log.surrogates[PEOPLE.bob.sub]!;
  for (const c of log.commits) {
    expect(c.id).toMatch(/\S/);
    expect(c.time).toBeGreaterThanOrEqual(started - 60_000);
    expect(c.time).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(c.origin).toMatch(/\S/);
    expect(c.cdm).toBe(1);
    expect(c.engine).toBe('pm-steps/1');
    expect(c.revision).toBeGreaterThanOrEqual(1);
    // HIS-003: people appear as the tenant's surrogates, never as the host's `sub`.
    expect(subs).not.toContain(c.user);
    if (c.kind === 'steps') {
      expect(c.steps).toBeGreaterThan(0);
      expect(c.base).not.toBeNull();
      expect(typeof c.rebased).toBe('boolean');
      expect(c.session).toMatch(/\S/);
      expect(c.jti).toMatch(/\S/);
      expect(c.scopes.length).toBeGreaterThan(0);
    }
  }
  const control = log.commits.filter((c) => c.kind === 'control');
  expect(control.length).toBeGreaterThanOrEqual(1);
  const grantChange = control.at(-1)!;
  const typed = (user: string, from = 0, to = Number.POSITIVE_INFINITY) =>
    log.commits
      .filter((c) => c.kind === 'steps' && c.user === user && c.seq > from && c.seq < to)
      .map((c) => c.inserted)
      .join('');
  expect(typed(ada)).toContain('Ada was here.');
  expect(typed(bob)).toContain('Bob was here.');
  // Before the grant change no commit of Ada's touched Bob's region, and the refused X is absent.
  const early = log.commits.filter((c) => c.user === ada && c.seq < grantChange.seq);
  expect(early.some((c) => c.scopes.includes(`region:${BOB_REGION}`))).toBe(false);
  expect(typed(ada, 0, grantChange.seq)).not.toContain('X');
  // After it, Ada's text in Bob's region is recorded under the new grants revision.
  expect(typed(ada, grantChange.seq)).toContain('Ada joins.');
  const late = log.commits.filter((c) => c.user === ada && c.seq > grantChange.seq);
  expect(late.some((c) => c.scopes.includes(`region:${BOB_REGION}`))).toBe(true);
  expect(Math.min(...late.map((c) => c.revision))).toBeGreaterThanOrEqual(grantChange.revision);
});

test('4b. the commit log can be read over REST (GET /documents/{id}/commits)', async () => {
  const token = (await hostToken(contexts[0]!, PEOPLE.olivia, docId)).token;
  const r = await fetch(`${serviceUrl()}/v1/documents/${docId}/commits?after=0`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r.status).toBe(200);
});

interface Probe {
  ok: boolean;
  reason?: string;
  network: string | null;
  interfaces: string | null;
  public: string | null;
  postgres: string | null;
  s3: string | null;
  dns: string | null;
}

test('5a. the export sandbox has no network', async () => {
  const probe = runScript<Probe>('sandbox-probe.ts');
  expect(probe.ok, probe.reason ?? 'the probe container did not run').toBe(true);
  expect(probe.network).toBe('--network=none');
  expect(probe.interfaces).toBe('lo');
  expect(probe.public).toBe('refused');
  expect(probe.postgres).toBe('refused');
  expect(probe.s3).toBe('refused');
  expect(probe.dns).toBe('noresolve');
});

interface ExportJob {
  id: string;
  state: string;
  result: { url: string; pages: number | null } | null;
  error?: { code: string; message: string };
}

test('5b. an export job compiles the document with LuaLaTeX in the sandbox into a PDF', async () => {
  test.setTimeout(300_000);
  const status = workerStatus();
  test.fail(
    !status.running,
    `Expected to fail: no export worker claims jobs in this stack (${status.detail}); the worker is services/export-worker \`start\` (packet D).`,
  );
  const token = (await hostToken(contexts[0]!, PEOPLE.olivia, docId)).token;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${serviceUrl()}/v1/documents/${docId}/exports`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ target: 'pdf' }),
  });
  expect(created.status).toBe(202);
  let job = (await created.json()) as ExportJob;
  const until = Date.now() + 240_000;
  while (!['completed', 'failed', 'cancelled'].includes(job.state) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    job = (await (
      await fetch(`${serviceUrl()}/v1/exports/${job.id}`, { headers: auth })
    ).json()) as ExportJob;
  }
  expect(job.error ?? null).toBeNull();
  expect(job.state).toBe('completed');
  expect(job.result?.pages ?? 0).toBeGreaterThanOrEqual(1);
  const pdf = new Uint8Array(await (await fetch(job.result!.url)).arrayBuffer());
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
});

test('5c. the PDF shows in the PDF panel of the editor', async () => {
  // The element opens its PDF panel from an export through its own interface: a command of the
  // shell (UX-019) or `requestExport` (05 §8.1; PRO-086), then the sandboxed viewer (FE-071).
  const command = editor(op).locator('[data-command-id*="pdf" i], [data-command-id*="export" i]');
  const hasApi = await op.evaluate(
    () =>
      typeof (document.querySelector('doc-editor') as { requestExport?: unknown } | null)
        ?.requestExport === 'function',
  );
  test.fail(
    (await command.count()) === 0 && !hasApi,
    'Expected to fail: the element offers no way to open its PDF panel on an export yet: no export command in the shell (UX-019) and no requestExport (PRO-086); packets B2 (element) and C/U (shell).',
  );
  if ((await command.count()) > 0) await command.first().click();
  else
    await op.evaluate(async () => {
      const el = document.querySelector('doc-editor') as unknown as {
        requestExport(o: { target: string }): Promise<unknown>;
      };
      await el.requestExport({ target: 'pdf' });
    });
  const frame = editor(op).locator('iframe.de-pdf-frame');
  await expect(frame).toBeVisible({ timeout: 240_000 });
  await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
});
