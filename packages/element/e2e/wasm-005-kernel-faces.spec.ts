/**
 * WASM-005 (lane w6): font faces from the manifest inside the kernel, in the four browsers. The
 * built layout worker (the one the library starts for the page view) is given the manifest's file
 * for a face by URL: it fetches that file, the kernel checks its SHA-256 against the manifest's, and
 * it reports the memory the face takes. A file whose hash differs is refused. Nothing is loaded
 * for a face that no request names.
 *
 * The font file is a real one (packages/perf/fonts/files/NotoSerif-Regular.ttf), served by the test
 * under a same-origin URL, as a manifest's URL is.
 *
 * Run with `DOCEDIT_DEMO_PORT=4798 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/wasm-005-kernel-faces.spec.ts`.
 * It needs the kernel build (`pnpm --filter @docedit/layout-kernel build:wasm`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { openLib } from './embed-helpers.ts';
import { record } from './helpers.ts';

const FONT = fileURLToPath(
  new URL('../../perf/fonts/files/NotoSerif-Regular.ttf', import.meta.url),
);
const bytes = readFileSync(FONT);
const hash = createHash('sha256').update(bytes).digest('hex');

interface Probe {
  created: { url: string }[];
}

async function mountPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: Probe = { created: [] };
    (window as unknown as { __probe: Probe }).__probe = probe;
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        probe.created.push({ url: String(url) });
      }
    };
  });
  await openLib(page);
  await page.evaluate(() =>
    (window as unknown as { __lib: { load(): Promise<unknown> } }).__lib.load(),
  );
  await page.evaluate(async () => {
    const lib = (window as unknown as { __lib: { docId: string; backend(sub: string): unknown } })
      .__lib;
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = lib.backend('ada');
    el.setAttribute('view', 'print');
    el.setAttribute('doc-id', lib.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __probe: Probe }).__probe.created.length),
    )
    .toBe(1);
}

/** Starts a second copy of the built worker script in the page and returns a function that talks to it. */
async function talk(page: Page) {
  await page.evaluate(async () => {
    const seen = (window as unknown as { __probe: Probe }).__probe;
    const worker = new Worker(seen.created[0]!.url, { type: 'module' });
    let next = 1;
    (window as unknown as { __ask: unknown }).__ask = <T>(message: Record<string, unknown>) =>
      new Promise<T>((resolve) => {
        const id = next++;
        const on = (e: MessageEvent<{ id: number }>) => {
          if (e.data.id !== id) return;
          worker.removeEventListener('message', on);
          resolve(e.data as T);
        };
        worker.addEventListener('message', on);
        worker.postMessage({ ...message, id });
      });
    await (window as unknown as { __ask: (m: unknown) => Promise<unknown> }).__ask({
      type: 'init',
      module: null,
      url: null,
    });
  });
  return <T>(message: Record<string, unknown>): Promise<T> =>
    page.evaluate(
      (m) =>
        (window as unknown as { __ask: (m: unknown) => Promise<unknown> }).__ask(m) as Promise<T>,
      message,
    );
}

interface Faces {
  loaded: string[];
  already: string[];
  failed: { alias: string; code: string }[];
  status: { count: number; bytesHeld: number; epoch: number; memoryBytes: number | null };
}

test.describe('font faces in the layout worker (WASM-005)', () => {
  test('the manifest’s file is fetched by URL, checked against its hash and held; a wrong hash is refused', async ({
    page,
  }) => {
    const fetched: string[] = [];
    await page.route('**/fonts/NotoSerif-Regular.ttf', async (route) => {
      fetched.push(route.request().url());
      await route.fulfill({ body: bytes, contentType: 'font/ttf' });
    });
    await mountPrint(page);
    const ask = await talk(page);
    const url = new URL('/fonts/NotoSerif-Regular.ttf', page.url()).href;

    // Nothing is fetched until a face is named.
    expect(fetched).toEqual([]);
    const first = await ask<Faces & { type: string }>({
      type: 'faces',
      owner: '',
      faces: [{ alias: `de-font-${hash}`, url, hash }],
    });
    expect(first.type).toBe('faces');
    expect(first.loaded).toEqual([`de-font-${hash}`]);
    expect(first.failed).toEqual([]);
    expect(first.status).toMatchObject({ count: 1, bytesHeld: bytes.length, epoch: 1 });
    expect(first.status.memoryBytes).toBeGreaterThanOrEqual(bytes.length);
    expect(fetched).toHaveLength(1);

    // Asking again for a held face fetches nothing and does not move the epoch.
    const again = await ask<Faces>({
      type: 'faces',
      owner: '',
      faces: [{ alias: `de-font-${hash}`, url, hash }],
    });
    expect(again.already).toEqual([`de-font-${hash}`]);
    expect(again.status.epoch).toBe(1);
    expect(fetched).toHaveLength(1);

    // The same file under a hash the manifest did not give is refused.
    const wrong = 'f'.repeat(64);
    const refused = await ask<Faces>({
      type: 'faces',
      owner: '',
      faces: [{ alias: `de-font-${wrong}`, url, hash: wrong }],
    });
    expect(refused.loaded).toEqual([]);
    expect(refused.failed).toEqual([
      { alias: `de-font-${wrong}`, code: 'hash_mismatch', message: expect.any(String) },
    ]);
    expect(refused.status.count).toBe(1);

    // Releasing the platform's faces frees them.
    const released = await ask<{ status: Faces['status'] }>({ type: 'release', owner: null });
    expect(released.status).toMatchObject({ count: 0, bytesHeld: 0 });
    record('wasm-005-face-memory', {
      browser: test.info().project.name,
      note: "one face (Noto Serif Regular, 588,876 bytes) held in the kernel of the built layout worker; the module memory includes the kernel's own pages",
      faceBytes: bytes.length,
      bytesHeld: first.status.bytesHeld,
      memoryBytes: first.status.memoryBytes,
    });
  });
});
