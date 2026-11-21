/**
 * EXP-001 (lane w2), against the demo stack started from compose.json by scripts/stack.ps1:
 *
 *   1. a document of three paragraph styles and two regions is created and edited in the editor;
 *   2. a PDF export requested over REST creates a job, and the stack's export worker compiles it;
 *   3. the job is at the document's current `seq`, and its result is a signed URL with an expiry;
 *   4. the PDF's text is the document's text in order (the text typed in step 1 included, so the
 *      bundle was written from the CDM at that `seq`), and the regions leave no trace;
 *   5. the worker that did it is the stack's, and LuaLaTeX ran in the sandbox image;
 *   6. a PDF export requested from the editor's export dialog creates a job at the current `seq`,
 *      the stack's worker compiles it, and the PDF opens in the editor's PDF panel: the shell's
 *      PDF preview pane, with the viewer in a sandboxed frame of the host's second origin.
 *
 * The files of the bundle (`main.tex`, `styles.tex`, `docedit.cls`) are not visible from outside
 * the worker: the demo stack announces the `pdf` target only, and a PDF job keeps no copy of its
 * bundle. services/export-worker/test/export.e2e.test.ts checks them at the compile call. The PDF
 * text is read with `pdftotext -raw` (poppler or xpdf) on the machine that runs the test; step 4
 * skips when it is not installed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { dataDir, endpoints, setting, stackSettings } from '../scripts/lib/stack.ts';
import {
  editor,
  eventsOf,
  hostToken,
  PEOPLE,
  recordEvents,
  regionParagraph,
  runCommand,
  serviceUrl,
  signIn,
  typeAtEnd,
  workerStatus,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const TITLE = `EXP-001 ${Date.now().toString(36)}`;
const TYPED = ' Typed before the export.';

interface Job {
  id: string;
  state: string;
  seq?: number;
  result: { url: string; pages: number | null; expiresAt?: string } | null;
  error?: { code: string; message: string } | null;
}

interface CdmNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: CdmNode[];
}

let context: BrowserContext;
let page: Page;
let docId = '';
let auth: Record<string, string> = {};
let seq = 0;
let paragraphs: string[] = [];
let regionTitles: string[] = [];
let pdfJob: Job | null = null;
let pdf = new Uint8Array();

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The text of each paragraph of the body, in document order, and the titles of the regions. */
function readDocument(doc: CdmNode): { paragraphs: string[]; regions: string[] } {
  const out: string[] = [];
  const regions: string[] = [];
  const text = (n: CdmNode): string => n.text ?? (n.content ?? []).map(text).join('');
  const walk = (n: CdmNode): void => {
    if (n.type === 'defs') return;
    if (n.type === 'region') regions.push(String(n.attrs?.['title'] ?? ''));
    if (n.type === 'paragraph') out.push(text(n));
    else for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return { paragraphs: out, regions };
}

async function waitForJob(id: string): Promise<Job> {
  const until = Date.now() + 240_000;
  for (;;) {
    const job = (await (
      await fetch(`${serviceUrl()}/v1/exports/${id}`, { headers: auth })
    ).json()) as Job;
    if (['completed', 'failed', 'cancelled'].includes(job.state) || Date.now() > until) return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The PDF's text by `pdftotext -raw`; null when the tool is not installed or fails. */
function pdftotext(bytes: Uint8Array): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-w2-exp-001-'));
  try {
    const file = join(dir, 'in.pdf');
    writeFileSync(file, bytes);
    const r = spawnSync('pdftotext', ['-enc', 'UTF-8', '-raw', file, '-'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    return r.error === undefined && r.status === 0 ? r.stdout : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await recordEvents(context);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

test('1. a document of three paragraph styles and two regions is created and edited', async () => {
  await signIn(page, PEOPLE.olivia);
  await page.getByLabel('Title', { exact: true }).fill(TITLE);
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page).toHaveURL(/\/as\/u-olivia\/docs\/[0-9a-f-]{36}$/);
  docId = page.url().split('/').pop()!;
  await expect.poll(async () => (await eventsOf(page, 'de-ready')).length).toBeGreaterThan(0);
  const doc = editor(page);
  for (const style of ['Title', 'Heading1', 'Normal'])
    await expect(doc.locator(`[data-style="${style}"]`).first()).toBeVisible();
  await expect(doc.locator('.de-region')).toHaveCount(2);
  // An edit, so that the current `seq` is not the one the document was created at.
  await typeAtEnd(page, regionParagraph(page, 'Payment section'), TYPED);
  await expect
    .poll(async () => {
      const all = await eventsOf(page, 'de-status');
      return (all.at(-1)?.detail as { sync?: string } | undefined)?.sync ?? null;
    })
    .toBe('saved');

  const token = (await hostToken(context, PEOPLE.olivia, docId)).token;
  auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const content = await fetch(`${serviceUrl()}/v1/documents/${docId}/content`, { headers: auth });
  expect(content.status).toBe(200);
  const body = (await content.json()) as { seq: number; content?: { doc: CdmNode }; doc?: CdmNode };
  seq = body.seq;
  expect(seq).toBeGreaterThan(0);
  const read = readDocument((body.content?.doc ?? body.doc)!);
  paragraphs = read.paragraphs;
  regionTitles = read.regions;
  expect(regionTitles).toEqual(['Payment section', 'Delivery section']);
  expect(paragraphs.join('\n')).toContain(TYPED.trim());
});

test('2. a PDF export creates a job and the stack’s worker compiles it', async () => {
  test.setTimeout(300_000);
  expect(workerStatus().running, workerStatus().detail).toBe(true);
  const created = await fetch(`${serviceUrl()}/v1/documents/${docId}/exports`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ target: 'pdf' }),
  });
  expect(created.status).toBe(202);
  const queued = (await created.json()) as Job;
  expect(queued.id).toMatch(/\S/);
  expect(['queued', 'converting', 'compiling']).toContain(queued.state);

  pdfJob = await waitForJob(queued.id);
  expect(pdfJob.error ?? null).toBeNull();
  expect(pdfJob.state).toBe('completed');
  expect(pdfJob.result?.pages ?? 0).toBeGreaterThanOrEqual(1);
  pdf = new Uint8Array(await (await fetch(pdfJob.result!.url)).arrayBuffer());
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
});

test('3. the job is at the current seq and its result holds a signed URL with an expiry', async () => {
  expect(pdfJob?.seq).toBe(seq);
  expect(pdfJob?.result?.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
  expect(new Date(pdfJob!.result!.expiresAt!).getTime()).toBeGreaterThan(Date.now());
});

test('4. the text of the PDF is the text of the document in order; the regions leave no trace', async () => {
  const text = pdftotext(pdf);
  test.skip(text === null, 'pdftotext (poppler or xpdf) is not installed on this machine');
  // Page ends are form feeds; the house class prints no header or footer for this document.
  expect(squash(text!)).toBe(squash(paragraphs.join(' ')));
  for (const title of regionTitles) expect(squash(text!)).not.toContain(title);
  expect(squash(text!)).not.toContain('restricted');
});

test('5. the worker is the one the stack started, and LuaLaTeX ran in the sandbox image', async () => {
  const image = setting(stackSettings(), 'DOCEDIT_EXPORT_IMAGE');
  const lines = readFileSync(join(dataDir(), 'logs', 'export-worker.log'), 'utf8').split('\n');
  const completed = lines.find((l) => l.includes(pdfJob!.id) && l.includes('export.completed'));
  expect(completed, `export.completed for job ${pdfJob!.id} in the worker's log`).toBeTruthy();
  // The worker's record of the job: compile passes in the sandbox, and a PDF of this size.
  expect(completed).toMatch(/sandbox \d+ ms \(passes [\d+]+ ms\)/);
  expect(completed).toContain(`pdf ${pdf.byteLength} B`);
  // The worker says at its start which image its sandbox runs: the stack's.
  const started = lines.findLast((l) => l.includes('export-worker.started'));
  expect(image).toMatch(/docedit-export-worker/);
  expect(started).toContain(`image ${image}`);
});

test('6. a PDF export requested in the editor opens in its PDF panel', async () => {
  test.setTimeout(420_000);
  // The author's way to an export: the shell's export command (UX-101), whose dialog creates the
  // job through the element's exports port (PRO-086). The jobs the element started are named by
  // its `de-export-*` events.
  const before = (await eventsOf(page)).filter((e) => e.name.startsWith('de-export-')).length;
  await runCommand(page, 'document.export');
  const dialog = editor(page).locator('dialog[data-dialog="export"]');
  await expect(dialog).toBeVisible();
  // The demo stack announces the PDF only; the dialog asks for the quick preview by default.
  await expect(dialog.getByRole('radio', { name: 'PDF', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.locator('[data-status="export"]')).toHaveText('Finished', {
    timeout: 300_000,
  });

  // The job is one of the document service: read over REST with the author's token, it is a PDF
  // job at the document's current seq, completed by the stack's worker.
  const raised = (await eventsOf(page))
    .filter((e) => e.name.startsWith('de-export-'))
    .slice(before);
  const completed = raised.find((e) => e.name === 'de-export-completed');
  expect(completed, 'de-export-completed raised by the element').toBeTruthy();
  const jobId = (completed!.detail as { jobId: string }).jobId;
  const token = (await hostToken(context, PEOPLE.olivia, docId)).token;
  const job = (await (
    await fetch(`${serviceUrl()}/v1/exports/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Job & { target?: string };
  expect(job.state).toBe('completed');
  expect(job.target).toBe('pdf');
  expect(job.seq).toBe(seq);
  expect(job.id).not.toBe(pdfJob?.id);
  const lines = readFileSync(join(dataDir(), 'logs', 'export-worker.log'), 'utf8').split('\n');
  const worked = lines.find((l) => l.includes(jobId) && l.includes('export.completed'));
  expect(worked, `export.completed for job ${jobId} in the worker's log`).toBeTruthy();
  expect(worked).toMatch(/sandbox \d+ ms \(passes [\d+]+ ms\)/);

  // The PDF opens in the PDF panel: the pane of the shell, with the viewer in a sandboxed frame
  // of the host's second origin (FE-071), which fetches the signed URL itself.
  await dialog.getByRole('button', { name: 'Show in the PDF preview' }).click();
  await expect(dialog).toBeHidden();
  const pane = editor(page).locator('[data-pane="pdf"]');
  await expect(pane).toBeVisible();
  const frame = pane.locator('iframe.de-pdf-frame');
  await expect(frame).toBeVisible({ timeout: 60_000 });
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  expect(new URL((await frame.getAttribute('src'))!).origin).toBe(
    endpoints(stackSettings()).viewerOrigin,
  );
  // The viewer drew the file: its page count is the job's, and the first page is on a canvas.
  await expect(pane.locator('[data-pdf="pages"]')).toHaveText(
    job.result!.pages === 1 ? '1 page' : `${job.result!.pages} pages`,
    { timeout: 60_000 },
  );
  await expect(pane.locator('[data-pdf="view-failed"]')).toHaveCount(0);
  const inner = page
    .frames()
    .find((f) => f.url().startsWith(endpoints(stackSettings()).viewerOrigin));
  expect(inner, 'the viewer frame').toBeTruthy();
  await expect
    .poll(() =>
      inner!.evaluate(() => document.querySelector('canvas.page')?.getAttribute('aria-label')),
    )
    .toBe(`Page 1 of ${job.result!.pages}`);
  // The page did not fetch the PDF itself and holds no token for the frame: the frame's address
  // is the viewer's page only.
  expect(await frame.getAttribute('src')).not.toContain('token');
});
