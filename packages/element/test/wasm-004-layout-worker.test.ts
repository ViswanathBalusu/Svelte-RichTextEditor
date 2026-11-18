/**
 * WASM-004: the layout worker that hosts the kernel. These tests run the real host and the real
 * worker core on the real build of the crate (`packages/layout-kernel/dist`), with a `worker_threads`
 * worker standing in for the browser's (./support/layout-worker-node.ts). The browser runs are in
 * e2e/wasm-004-layout-worker.spec.ts.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { packBlocks } from '@docedit/layout-kernel';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiagnosticDetail } from '../src/events.ts';
import { LayoutWorker, type WorkerLike } from '../src/features/layout-worker-host.ts';
import {
  ElementKernel,
  resetLayoutKernelRequests,
  type WorkerHostModule,
} from '../src/layout-kernel-request.ts';

const dist = resolve(import.meta.dirname, '../../layout-kernel/dist');
const built = existsSync(resolve(dist, 'docedit_layout_kernel_bg.wasm'));
const script = resolve(import.meta.dirname, 'support/layout-worker-node.ts');

/** The reference: 32-bit FNV-1a over each code unit as two bytes, low byte first. */
function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    for (const byte of [unit & 0xff, unit >> 8]) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

/** `worker_threads` workers as the host's `WorkerLike`; the test keeps every worker it made. */
function nodeWorld(data: Record<string, unknown> = {}) {
  const made: { worker: Worker; exited: Promise<number> }[] = [];
  const create = (): WorkerLike => {
    const worker = new Worker(script, { workerData: data, execArgv: ['--no-warnings'] });
    const exited = new Promise<number>((done) => worker.once('exit', done));
    made.push({ worker, exited });
    const like: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate: () => void worker.terminate(),
    };
    worker.on('message', (m) => like.onmessage?.({ data: m }));
    worker.on('error', (e) => like.onerror?.({ message: e.message }));
    return like;
  };
  const host: WorkerHostModule = { LayoutWorker, create };
  return { made, create, load: () => Promise.resolve(host) };
}

const collect = () => {
  const reports: DiagnosticDetail[] = [];
  return { reports, report: (d: DiagnosticDetail) => void reports.push(d) };
};

afterEach(() => resetLayoutKernelRequests());

describe.skipIf(!built)('the layout worker on the build of the crate', () => {
  it('starts one kernel instance in its own worker and says what it started', async () => {
    const world = nodeWorld();
    const { worker, ready } = await LayoutWorker.start({ create: world.create });
    expect(world.made).toHaveLength(1);
    expect(ready).toMatchObject({ type: 'ready', abi: 1, streaming: true });
    expect(ready.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ready.module).toBeInstanceOf(WebAssembly.Module);
    expect(worker.module).toBe(ready.module);
    worker.terminate();
    await world.made[0]!.exited;
  });

  it('runs a batch of whole blocks and answers with one value for each', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    const blocks = ['', 'Hello, world', 'Zażółć gęślą jaźń', '日本語のテキスト', 'a\u{1F600}b'];
    const values = await worker.batch('checksum', blocks);
    expect([...values]).toEqual(blocks.map(fnv));
    worker.terminate();
  });

  it('transfers the typed arrays instead of copying them, and uses no shared memory', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    const batch = packBlocks(['one', 'two two', 'three three three']);
    const text = batch.text;
    const offsets = batch.offsets;
    const values = await worker.batch('checksum', batch);
    // The page's buffers changed owner: they are empty here now.
    expect(text.buffer.byteLength).toBe(0);
    expect(offsets.buffer.byteLength).toBe(0);
    // The answer's buffer is a plain ArrayBuffer of its own, not shared memory.
    expect(values.buffer).toBeInstanceOf(ArrayBuffer);
    expect(values.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    expect(values).toHaveLength(3);
    worker.terminate();
  });

  it('records what each batch cost', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    await worker.batch('checksum', ['abc', 'defgh']);
    await worker.batch('checksum', ['x']);
    expect(worker.stats).toHaveLength(2);
    expect(worker.stats[0]).toMatchObject({ op: 'checksum', blocks: 2, units: 8 });
    expect(worker.stats[1]).toMatchObject({ blocks: 1, units: 1 });
    for (const stat of worker.stats) {
      expect(stat.workerMs).toBeGreaterThanOrEqual(0);
      expect(stat.roundTripMs).toBeGreaterThan(0);
    }
    worker.terminate();
  });

  it('rejects a waiting batch when the worker is ended, and a later one at once', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    const waiting = worker.batch('checksum', ['abc']);
    worker.terminate();
    await expect(waiting).rejects.toMatchObject({ code: 'worker_stopped' });
    await expect(worker.batch('checksum', ['abc'])).rejects.toMatchObject({
      code: 'worker_stopped',
    });
    await world.made[0]!.exited;
  });
});

describe.skipIf(!built)('the kernel of one element', () => {
  it('reports the load and runs batches', async () => {
    const world = nodeWorld();
    const { reports, report } = collect();
    const kernel = new ElementKernel(report, { load: world.load });
    expect(await kernel.start()).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      feature: 'layout-kernel',
      kind: 'loaded',
      streaming: true,
      code: null,
    });
    expect([...(await kernel.batch('checksum', ['ab']))]).toEqual([fnv('ab')]);
    expect(kernel.stats).toHaveLength(1);
    kernel.destroy();
    await world.made[0]!.exited;
  });

  it('gives a second editor on the page the compiled module instead of compiling again', async () => {
    const world = nodeWorld();
    const { reports, report } = collect();
    const first = new ElementKernel(report, { load: world.load });
    const second = new ElementKernel(report, { load: world.load });
    // Started together: the second waits for the first's module.
    await Promise.all([first.start(), second.start()]);
    expect(world.made).toHaveLength(2);
    const loads = reports.filter((r) => r.kind === 'loaded');
    expect(loads).toHaveLength(2);
    // One of them fetched and compiled the file; the other did neither.
    expect(loads.filter((r) => r.streaming === true)).toHaveLength(1);
    expect(loads.filter((r) => r.streaming === null && r.bytes === null)).toHaveLength(1);
    expect([...(await second.batch('checksum', ['x']))]).toEqual([fnv('x')]);
    first.destroy();
    second.destroy();
  });

  it('stops the worker on suspend and creates it again on first use after the resume', async () => {
    const world = nodeWorld();
    const { reports, report } = collect();
    const kernel = new ElementKernel(report, { load: world.load });
    await kernel.start();
    await kernel.batch('checksum', ['a']);
    kernel.stop();
    expect(kernel.running).toBe(false);
    expect(await world.made[0]!.exited).toBeGreaterThanOrEqual(0);
    // Nothing is created while it is stopped.
    expect(world.made).toHaveLength(1);
    // The first use after the resume creates it again, from the page's compiled module.
    expect([...(await kernel.batch('checksum', ['b']))]).toEqual([fnv('b')]);
    expect(world.made).toHaveLength(2);
    expect(kernel.running).toBe(true);
    expect(reports.map((r) => r.kind)).toEqual(['loaded', 'loaded']);
    expect(reports[1]).toMatchObject({ streaming: null, bytes: null });
    // The records of the first worker are kept.
    expect(kernel.stats).toHaveLength(2);
    kernel.destroy();
    await world.made[1]!.exited;
  });

  it('releases the worker for good on destroy', async () => {
    const world = nodeWorld();
    const { report } = collect();
    const kernel = new ElementKernel(report, { load: world.load });
    await kernel.start();
    kernel.destroy();
    await world.made[0]!.exited;
    expect(kernel.running).toBe(false);
    await expect(kernel.batch('checksum', ['a'])).rejects.toMatchObject({
      code: 'kernel_unavailable',
    });
    expect(world.made).toHaveLength(1);
  });

  it('does not report a worker that a suspend overtook', async () => {
    const world = nodeWorld();
    const { reports, report } = collect();
    const kernel = new ElementKernel(report, { load: world.load });
    const started = kernel.start();
    kernel.stop();
    expect(await started).toBe(false);
    expect(reports).toEqual([]);
    expect(kernel.running).toBe(false);
    // Whatever worker the overtaken start made has been ended.
    await Promise.all(world.made.map((m) => m.exited));
  });

  it('catches a trap, reports it, ends the worker and leaves the caller alive', async () => {
    const world = nodeWorld({ trap: true });
    const { reports, report } = collect();
    const kernel = new ElementKernel(report, { load: world.load });
    await kernel.start();
    const document = ['the document is not in the worker'];
    await expect(kernel.batch('checksum', document)).rejects.toMatchObject({ code: 'kernel_trap' });
    expect(reports.map((r) => [r.kind, r.code])).toEqual([
      ['loaded', null],
      ['load-failed', 'kernel_trap'],
    ]);
    expect(await world.made[0]!.exited).toBeGreaterThanOrEqual(0);
    expect(kernel.running).toBe(false);
    // The text the caller holds is untouched; the worker only ever got a packed copy.
    expect(document).toEqual(['the document is not in the worker']);
    kernel.destroy();
  });

  it('reports a policy refusal with the directive, and a missing file', async () => {
    const refused = nodeWorld({
      compileError: "Refused to compile because 'wasm-unsafe-eval' is not allowed",
    });
    const a = collect();
    expect(await new ElementKernel(a.report, { load: refused.load }).start()).toBe(false);
    expect(a.reports[0]).toMatchObject({
      kind: 'load-failed',
      code: 'blocked_by_policy',
      directive: "script-src 'wasm-unsafe-eval'",
    });
    await refused.made[0]!.exited;
    resetLayoutKernelRequests();

    const gone = nodeWorld({ status: 404 });
    const b = collect();
    expect(await new ElementKernel(b.report, { load: gone.load }).start()).toBe(false);
    expect(b.reports[0]).toMatchObject({ kind: 'load-failed', code: 'fetch_failed' });
    await gone.made[0]!.exited;
  });

  it('reports a worker host that does not load, and tries again on the next call', async () => {
    const { reports, report } = collect();
    const kernel = new ElementKernel(report, {
      load: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
    });
    expect(await kernel.start()).toBe(false);
    expect(reports[0]).toMatchObject({ kind: 'load-failed', code: 'chunk_failed' });
    const world = nodeWorld();
    const again = new ElementKernel(report, { load: world.load });
    expect(await again.start()).toBe(true);
    again.destroy();
  });
});
