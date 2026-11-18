/**
 * FE-075 criterion 3: the cost, on the main thread, of receiving the layout tree from a layout
 * Worker, measured per message against the typing latency target of 00 §9 (keystroke to paint within
 * 16 ms at the median and 50 ms at the 95th percentile, for documents up to 100 pages).
 *
 * How it is measured: the Worker lays out a document of about 100 pages once, and then posts, on
 * request, the whole tree ("full": what a first layout or a font change sends), one page of it
 * ("page": what a keystroke changes, FE-089 sends a changed slice) or nothing ("none": the baseline).
 * A browser delivers a message by cloning it on the receiving thread, in the task that dispatches
 * the `message` event, so the clone blocks that thread. The page runs a heartbeat, a loop of
 * MessageChannel tasks that records the time between two ticks; the longest gap while one message is
 * delivered, less the longest gap of the same window without a message, is the time the main thread
 * was held for that message. The longest gap in a window is a bound on the longest frame the
 * delivery can cost, which is the figure the criterion asks for. It is not the Worker's layout time
 * and not the time to paint.
 *
 * The numbers are printed as one JSON line per browser (`FE-075 tree crossing`). They depend on the
 * machine and its load: the run that the story's Evidence names was made on a Windows development
 * machine shared with other test runs, not on the reference machine of ADR 0037, so it shows the
 * order of magnitude and is no measure of the target. The assertions are the targets themselves,
 * for the page that a keystroke sends.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`; in Node.js
 * there is no Worker URL support for this entry, so the suite is skipped there.
 */
import { describe, expect, it } from 'vitest';

interface WorkerLike {
  onmessage: ((event: { data: Reply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}
type WorkerCtor = new (url: URL, options: { type: 'module' }) => WorkerLike;
type Reply = { kind: string; pages?: number; json?: number; tree?: unknown };

const g = globalThis as unknown as {
  Worker?: WorkerCtor;
  MessageChannel?: new () => {
    port1: { onmessage: (() => void) | null };
    port2: { postMessage(message: unknown): void };
  };
  performance: { now(): number };
  setTimeout(run: () => void, ms: number): unknown;
};
const hasWorker = typeof g.Worker === 'function' && typeof g.MessageChannel === 'function';
const now = (): number => g.performance.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => g.setTimeout(resolve, ms));

/** A loop of tasks that records the time between two of them while it is on. */
function heartbeat() {
  const channel = new g.MessageChannel!();
  let last = now();
  let worst = 0;
  let on = true;
  channel.port1.onmessage = () => {
    const t = now();
    if (t - last > worst) worst = t - last;
    last = t;
    if (on) channel.port2.postMessage(0);
  };
  channel.port2.postMessage(0);
  return {
    /** Starts a window; the longest gap of the window is read by `window()`. */
    start() {
      worst = 0;
      last = now();
    },
    window: () => worst,
    stop() {
      on = false;
    },
  };
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

describe.skipIf(!hasWorker)(
  'the layout tree crossing to the main thread (FE-075 criterion 3)',
  () => {
    it('holds the main thread for a page of the tree within the typing latency target', async ({
      annotate,
    }) => {
      const worker = new g.Worker!(new URL('./fe-075-tree-worker.ts', import.meta.url), {
        type: 'module',
      });
      const heart = heartbeat();
      let waiting: ((reply: Reply) => void) | null = null;
      worker.onmessage = (event) => waiting?.(event.data);
      const request = (message: { kind: string; page?: number }): Promise<Reply> =>
        new Promise((resolve, reject) => {
          waiting = resolve;
          worker.onerror = (event) => reject(new Error(event.message ?? 'the Worker failed'));
          worker.postMessage(message);
        });
      try {
        // The first reply comes after the Worker has laid the document out.
        const info = await request({ kind: 'info' });
        expect(info.pages).toBeGreaterThanOrEqual(100);

        /** The longest gap of the heartbeat while one message is delivered, in milliseconds. */
        const held = async (message: { kind: string; page?: number }): Promise<number> => {
          await sleep(10);
          heart.start();
          await request(message);
          await sleep(10);
          return heart.window();
        };
        const measure = async (message: { kind: string; page?: number }, runs: number) => {
          const out: number[] = [];
          for (let i = 0; i < runs; i++) out.push(await held(message));
          return out;
        };

        // One unmeasured pass of each, so that the first-use costs are not in the numbers.
        for (const m of [{ kind: 'none' }, { kind: 'page', page: 0 }, { kind: 'full' }])
          await held(m);
        const none = await measure({ kind: 'none' }, 30);
        const page = await measure({ kind: 'page', page: 49 }, 30);
        const full = await measure({ kind: 'full' }, 15);
        const stats = (values: number[]) => ({
          p50: Number(percentile(values, 50).toFixed(1)),
          p95: Number(percentile(values, 95).toFixed(1)),
          max: Number(Math.max(...values).toFixed(1)),
        });
        // The longest gap of the heartbeat per delivered message, in milliseconds, by what was sent.
        const summary = {
          pages: info.pages,
          treeJsonBytes: info.json,
          none: stats(none),
          page: stats(page),
          full: stats(full),
          // The heartbeat resolves a cost only where its own gap is well below a frame.
          resolved: percentile(none, 95) < 16,
        };
        await annotate(`FE-075 tree crossing ${JSON.stringify(summary)}`);

        // The page that a keystroke sends costs the main thread, over the gap of the same window with
        // no message, no more than the 16 ms median and 50 ms 95th-percentile targets. Where the
        // heartbeat is itself throttled to the display's rate (WebKit under automation: `none` near
        // 30 ms), the cost is not resolved, `resolved` says so, and the test shows no more than that.
        expect(summary.page.p50 - summary.none.p50).toBeLessThanOrEqual(16);
        expect(summary.page.p95 - summary.none.p95).toBeLessThanOrEqual(50);
        // The whole tree is measured and reported, not held to the target: it is not what a keystroke sends.
        expect(full.length).toBeGreaterThan(0);
      } finally {
        heart.stop();
        worker.terminate();
      }
    }, 120_000);
  },
);
