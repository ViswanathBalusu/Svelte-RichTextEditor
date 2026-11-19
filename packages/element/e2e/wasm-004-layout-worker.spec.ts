/**
 * WASM-004 (lane w6): the layout worker that hosts the kernel, from the library build, in the four
 * browsers. The page `pages/lib.html` loads the distributable by URL, as a host does.
 *
 * - One editor in the page view starts one worker; the worker script is an asset of the library, on
 *   the origin that serves the component; no `SharedArrayBuffer` is needed (the page is not
 *   cross-origin isolated).
 * - A second editor reuses the compiled module: one `.wasm` request for both.
 * - Disconnecting the element stops the worker; reconnecting does not create one until it is used;
 *   `destroy()` releases it.
 * - The built worker script answers a batch of whole blocks, with the typed arrays transferred, and
 *   the cost of batches is measured (`test-results/evidence/wasm-004-batch-cost.json`).
 *
 * Run with `DOCEDIT_DEMO_PORT=4797 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/wasm-004-layout-worker.spec.ts`.
 * It needs the kernel build (`pnpm --filter @docedit/layout-kernel build:wasm`).
 */
import { type Page, expect, test } from '@playwright/test';
import { openLib } from './embed-helpers.ts';
import { record } from './helpers.ts';

interface Diagnostic {
  feature: string;
  kind: string;
  ms: number | null;
  bytes: number | null;
  streaming: boolean | null;
  code: string | null;
}

interface Probe {
  created: { url: string; options: unknown }[];
  terminated: number;
  diagnostics: Diagnostic[];
}

/** Wraps `Worker` to record the workers the page makes and ends. */
async function watchWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: Probe = { created: [], terminated: 0, diagnostics: [] };
    (window as unknown as { __probe: Probe }).__probe = probe;
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        probe.created.push({ url: String(url), options });
      }
      override terminate(): void {
        probe.terminated++;
        super.terminate();
      }
    };
  });
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);

/** Mounts `count` editors in the page view, each with its own backend session, and waits for them. */
async function mountPrint(page: Page, count: number): Promise<void> {
  await openLib(page);
  await page.evaluate(() =>
    (window as unknown as { __lib: { load(): Promise<unknown> } }).__lib.load(),
  );
  await page.evaluate(async (n) => {
    const lib = (window as unknown as { __lib: { docId: string; backend(sub: string): unknown } })
      .__lib;
    const w = window as unknown as { __probe: Probe };
    for (let i = 0; i < n; i++) {
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = `kernel-${i}`;
      el.addEventListener('de-diagnostic', (e) =>
        w.__probe.diagnostics.push((e as CustomEvent<Diagnostic>).detail),
      );
      const ready = new Promise<void>((resolve) =>
        el.addEventListener('de-ready', () => resolve(), { once: true }),
      );
      el.backend = lib.backend(`user${i}`);
      el.setAttribute('view', 'print');
      el.setAttribute('doc-id', lib.docId);
      document.getElementById('mount')!.append(el);
      await ready;
    }
  }, count);
}

const editor = (i: number) => `doc-editor[data-test="kernel-${i}"]`;

test.describe('the layout worker (WASM-004)', () => {
  test('one editor in the page view starts one module worker from the library, with no shared memory', async ({
    page,
  }) => {
    await watchWorkers(page);
    await mountPrint(page, 1);
    await expect.poll(async () => (await probe(page)).diagnostics.length).toBe(1);
    const seen = await probe(page);
    expect(seen.diagnostics[0]).toMatchObject({ kind: 'loaded', code: null, streaming: true });
    expect(seen.created).toHaveLength(1);
    const url = new URL(seen.created[0]!.url);
    expect(url.pathname).toMatch(/^\/lib\/assets\/layout-worker-[\w-]+\.js$/);
    expect(seen.created[0]!.options).toMatchObject({ type: 'module' });
    // No cross-origin isolation was asked of the host, and none was needed.
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    await expect(page.locator(`${editor(0)} .de-editing-surface`)).toBeVisible();
  });

  test('a second editor on the page reuses the compiled module: one file request, two workers', async ({
    page,
  }) => {
    const wasm: string[] = [];
    page.on('request', (r) => {
      if (/\.wasm(\?|$)/.test(r.url())) wasm.push(r.url());
    });
    await watchWorkers(page);
    await mountPrint(page, 2);
    await expect.poll(async () => (await probe(page)).diagnostics.length).toBe(2);
    const seen = await probe(page);
    expect(seen.created).toHaveLength(2);
    expect(seen.diagnostics.map((d) => d.kind)).toEqual(['loaded', 'loaded']);
    // The first compiled from the file; the second was given the module and read no file.
    expect(seen.diagnostics[0]).toMatchObject({ streaming: true });
    expect(seen.diagnostics[1]).toMatchObject({ streaming: null, bytes: null });
    expect(wasm).toHaveLength(1);
  });

  test('the worker stops when the element is disconnected, and is released on destroy', async ({
    page,
  }) => {
    await watchWorkers(page);
    await mountPrint(page, 1);
    await expect.poll(async () => (await probe(page)).created.length).toBe(1);
    await expect.poll(async () => (await probe(page)).diagnostics.length).toBe(1);

    // Suspend: take the element out of the page.
    await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="kernel-0"]')!;
      (window as unknown as { __held: Element }).__held = el;
      el.remove();
    });
    await expect.poll(async () => (await probe(page)).terminated).toBe(1);

    // Resume: nothing is created until the kernel is used.
    await page.evaluate(() =>
      document.getElementById('mount')!.append((window as unknown as { __held: Element }).__held),
    );
    await page.waitForTimeout(300);
    expect((await probe(page)).created).toHaveLength(1);

    // Destroy: the worker (none running after the suspend) and the element's kernel are released,
    // and a later request does not bring a worker back.
    await page.evaluate(() =>
      (
        document.querySelector('doc-editor[data-test="kernel-0"]') as unknown as { destroy(): void }
      ).destroy(),
    );
    await page.waitForTimeout(300);
    const after = await probe(page);
    expect(after.created).toHaveLength(1);
    expect(after.terminated).toBe(1);
  });

  test('the built worker answers a batch of whole blocks; the arrays are transferred; cost is measured', async ({
    page,
  }) => {
    await watchWorkers(page);
    await mountPrint(page, 1);
    await expect.poll(async () => (await probe(page)).created.length).toBe(1);
    const result = await page.evaluate(async () => {
      const seen = (window as unknown as { __probe: Probe }).__probe;
      const worker = new Worker(seen.created[0]!.url, { type: 'module' });
      const request = <T>(message: Record<string, unknown>, transfer: Transferable[] = []) =>
        new Promise<T>((resolve, reject) => {
          const onMessage = (e: MessageEvent<T & { id: number }>) => {
            if (e.data.id !== message['id']) return;
            worker.removeEventListener('message', onMessage);
            resolve(e.data);
          };
          worker.addEventListener('message', onMessage);
          worker.addEventListener('error', (e) => reject(new Error(e.message)), { once: true });
          worker.postMessage(message, transfer);
        });
      const ready = await request<{ type: string; abi: number; module: unknown }>({
        type: 'init',
        id: 1,
        module: null,
        url: null,
      });
      const pack = (blocks: string[]) => {
        let total = 0;
        for (const b of blocks) total += b.length;
        const text = new Uint16Array(total);
        const offsets = new Uint32Array(blocks.length + 1);
        let at = 0;
        blocks.forEach((b, i) => {
          for (let j = 0; j < b.length; j++) text[at + j] = b.charCodeAt(j);
          at += b.length;
          offsets[i + 1] = at;
        });
        return { text, offsets };
      };
      const fnv = (s: string) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
          const u = s.charCodeAt(i);
          for (const byte of [u & 0xff, u >> 8]) {
            h ^= byte;
            h = Math.imul(h, 0x01000193) >>> 0;
          }
        }
        return h >>> 0;
      };
      const blocks = ['', 'Hello, world', 'Zażółć gęślą jaźń', '日本語のテキスト'];
      const packed = pack(blocks);
      const first = await request<{ type: string; values: Uint32Array; ms: number }>(
        { type: 'batch', id: 2, op: 'checksum', text: packed.text, offsets: packed.offsets },
        [packed.text.buffer, packed.offsets.buffer],
      );
      const detached =
        packed.text.buffer.byteLength === 0 && packed.offsets.buffer.byteLength === 0;
      const matches = [...first.values].every((v, i) => v === fnv(blocks[i]!));
      // The cost of a batch of 200 paragraphs of about 600 characters (a page or two of prose).
      const paragraph = 'The quick brown fox jumps over the lazy dog. '.repeat(14);
      const samples: { roundTrip: number; worker: number }[] = [];
      let id = 10;
      for (let run = 0; run < 25; run++) {
        const batch = pack(Array.from({ length: 200 }, () => paragraph));
        const t0 = performance.now();
        const answer = await request<{ ms: number }>(
          { type: 'batch', id: id++, op: 'checksum', text: batch.text, offsets: batch.offsets },
          [batch.text.buffer, batch.offsets.buffer],
        );
        samples.push({ roundTrip: performance.now() - t0, worker: answer.ms });
      }
      worker.terminate();
      const sorted = (key: 'roundTrip' | 'worker') =>
        samples.map((s) => s[key]).sort((a, b) => a - b);
      const median = (xs: number[]) => xs[Math.floor(xs.length / 2)]!;
      return {
        type: ready.type,
        abi: ready.abi,
        isModule: (ready.module as object) instanceof WebAssembly.Module,
        detached,
        matches,
        paragraphs: 200,
        unitsPerBatch: 200 * paragraph.length,
        runs: samples.length,
        medianRoundTripMs: median(sorted('roundTrip')),
        medianWorkerMs: median(sorted('worker')),
      };
    });
    expect(result).toMatchObject({
      type: 'ready',
      abi: 4,
      isModule: true,
      detached: true,
      matches: true,
    });
    expect(result.medianRoundTripMs).toBeGreaterThan(0);
    record('wasm-004-batch-cost', {
      browser: test.info().project.name,
      note: 'median over 25 batches of 200 paragraphs of 630 UTF-16 code units, checksum operation, on the built worker, on this machine',
      ...result,
    });
  });
});
