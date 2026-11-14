/**
 * Helpers of the exit-check scenario: the stack's addresses, the demo sign-in, the events the
 * element raises, typing into the editor's shadow root, and the Node scripts that read the
 * stack's storage and sandbox.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { APP_DIR, dataDir, endpoints, REPO_DIR, stackSettings } from '../scripts/lib/stack.ts';

export const APP = APP_DIR;

export function hostUrl(): string {
  return endpoints(stackSettings()).hostUrl;
}

export function serviceUrl(): string {
  return endpoints(stackSettings()).serviceUrl;
}

export const PEOPLE = {
  olivia: { sub: 'u-olivia', name: 'Olivia Okafor' },
  ada: { sub: 'u-ada', name: 'Ada Lindqvist' },
  bob: { sub: 'u-bob', name: 'Bob Mensah' },
  vic: { sub: 'u-vic', name: 'Vic Moreau' },
} as const;

export type Person = (typeof PEOPLE)[keyof typeof PEOPLE];

/** The element's events (05 §8.1), recorded on the document from the first script of each page. */
export const EVENTS = [
  'de-ready',
  'de-status',
  'de-change',
  'de-permission-change',
  'de-auth-required',
  'de-recovered-edits',
  'de-error',
  'de-command-state',
  'de-export-progress',
  'de-export-completed',
  'de-export-failed',
] as const;

export interface RecordedEvent {
  name: string;
  detail: unknown;
  t: number;
}

declare global {
  interface Window {
    __deEvents?: RecordedEvent[];
    __pageMarker?: string;
  }
}

export async function recordEvents(context: BrowserContext): Promise<void> {
  await context.addInitScript((names: readonly string[]) => {
    window.__deEvents = [];
    for (const name of names)
      document.addEventListener(name, (e) =>
        window.__deEvents!.push({
          name,
          detail: JSON.parse(JSON.stringify((e as CustomEvent).detail ?? null)) as unknown,
          t: Date.now(),
        }),
      );
  }, EVENTS);
}

export async function eventsOf(page: Page, name?: string): Promise<RecordedEvent[]> {
  const all = await page.evaluate(() => window.__deEvents ?? []);
  return name ? all.filter((e) => e.name === name) : all;
}

/** The demo sign-in: no password, one form per person (UX-092 criterion 1). */
export async function signIn(page: Page, person: Person): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: `Continue as ${person.name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/as/${person.sub}/?$`));
  await expect(page.getByTestId('acting-as')).toHaveText(person.name);
}

/** Opens a document in the editor and waits for `de-ready` (PRO-074). */
export async function openDocument(page: Page, person: Person, docId: string): Promise<void> {
  await page.goto(`/as/${person.sub}/docs/${docId}`);
  await expect
    .poll(async () => (await eventsOf(page, 'de-ready')).length, {
      message: `de-ready for ${person.name}`,
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
}

export function editor(page: Page): Locator {
  return page.locator('doc-editor');
}

/** The body paragraph of a region of the demo template, by the region's title. */
export function regionParagraph(page: Page, regionTitle: string): Locator {
  return editor(page).locator(`.de-region[data-title="${regionTitle}"] p.de-p`).first();
}

/** Puts the caret at the end of a paragraph and types (the editor is in an open shadow root). */
export async function typeAtEnd(page: Page, target: Locator, text: string): Promise<void> {
  await target.click();
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 15 });
}

/**
 * Selects one word of a paragraph as a person does with the keyboard: a click just inside the
 * word's last character puts the caret after it, then Shift+Ctrl+Left extends to the word's start.
 */
export async function selectWord(page: Page, paragraph: Locator, word: string): Promise<void> {
  const box = await paragraph.evaluate((p, w) => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent?.indexOf(w) ?? -1;
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i + w.length - 1);
      range.setEnd(n, i + w.length);
      const r = range.getBoundingClientRect();
      return { x: r.right - Math.max(1, r.width / 4), y: r.top + r.height / 2 };
    }
    return null;
  }, word);
  if (!box) throw new Error(`"${word}" is not in the paragraph`);
  await page.mouse.click(box.x, box.y);
  // Word-wise movement is Alt on macOS and Control elsewhere.
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Shift+Alt+ArrowLeft' : 'Shift+Control+ArrowLeft',
  );
}

/** Runs one of the stack's Node scripts and parses its JSON output. */
export function runScript<T>(script: string, args: readonly string[] = []): T {
  const out = execFileSync('node', [join(APP_DIR, 'scripts', script), ...args], {
    cwd: REPO_DIR,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return JSON.parse(out.trim().split('\n').pop()!) as T;
}

/** Whether the stack's export worker process is running (scripts/stack.ps1 keeps its pid). */
export function workerStatus(): { running: boolean; detail: string } {
  const file = join(dataDir(), 'pids', 'export-worker.pid');
  if (!existsSync(file)) return { running: false, detail: 'the stack did not start it' };
  const pid = Number(readFileSync(file, 'utf8').trim());
  try {
    process.kill(pid, 0);
    return { running: true, detail: `pid ${pid}` };
  } catch {
    return { running: false, detail: `pid ${pid} has stopped; see .stack/logs/export-worker.*` };
  }
}

/** A token for `docId` from the host's token endpoint, as the page glue gets one. */
export async function hostToken(context: BrowserContext, person: Person, docId: string) {
  const r = await context.request.post(`${hostUrl()}/as/${person.sub}/api/token`, {
    data: { docId },
  });
  expect(r.status(), `token for ${person.name}`).toBe(200);
  return (await r.json()) as { token: string; expiresAt: string };
}
