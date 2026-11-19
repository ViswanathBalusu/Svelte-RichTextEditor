/**
 * WASM-006: shaping and measurement behind the measurement interface. Node.js, on the real build of
 * the crate and a real font file (Noto Serif). The comparison with HarfBuzz and the layout engine
 * run with the kernel as its measurer are in packages/perf/test/wasm-006-kernel-provider.test.ts;
 * the browser run (painted widths against computed widths) is in e2e/wasm-006-kernel-measure.spec.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  KERNEL_FILES,
  createKernel,
  type KernelGlue,
  type LayoutKernel,
} from '@docedit/layout-kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { LayoutWorker, type WorkerLike } from '../src/features/layout-worker-host.ts';
import { fontAlias } from '../src/font-registration.ts';
import { kernelTextMeasurer, sizeInTwips } from '../src/kernel-measure.ts';
import { kernelFaceRequests, PLATFORM_FONTS } from '../src/kernel-faces.ts';
import {
  ElementKernel,
  resetLayoutKernelRequests,
  type WorkerHostModule,
} from '../src/layout-kernel-request.ts';

const dist = resolve(import.meta.dirname, '../../layout-kernel/dist');
const fonts = resolve(import.meta.dirname, '../../perf/fonts/files');
const built = existsSync(resolve(dist, KERNEL_FILES.wasm));
const script = resolve(import.meta.dirname, 'support/layout-worker-node.ts');

const fontBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(fonts, name)));
const sha = (name: string): string => createHash('sha256').update(fontBytes(name)).digest('hex');
const SERIF = 'NotoSerif-Regular.ttf';
const BOLD = 'NotoSerif-Bold.ttf';
const alias = (name: string): string => fontAlias(sha(name));
const manifestFiles = [SERIF, BOLD].map((name) => ({
  family: 'Noto Serif',
  style: 'normal',
  weight: '400',
  url: `https://host.test/fonts/${name}`,
  hash: sha(name),
  licence: 'OFL-1.1',
}));

function nodeWorld() {
  const made: Worker[] = [];
  const create = (): WorkerLike => {
    const worker = new Worker(script, { execArgv: ['--no-warnings'] });
    made.push(worker);
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

/** The same kernel, in this thread, to compare the worker with. */
async function localKernel(): Promise<LayoutKernel> {
  const glue = (await import(
    `${pathToFileURL(resolve(dist, KERNEL_FILES.module)).href}?run=${Math.random()}`
  )) as KernelGlue;
  const kernel = createKernel(glue, new Uint8Array(readFileSync(resolve(dist, KERNEL_FILES.wasm))));
  for (const name of [SERIF, BOLD]) kernel.faces.load('', alias(name), sha(name), fontBytes(name));
  return kernel;
}

afterEach(() => resetLayoutKernelRequests());

describe('the provider’s units', () => {
  it('turns a size in points into whole twentieths of a point, at least one', () => {
    expect(sizeInTwips(12)).toBe(240);
    expect(sizeInTwips(10.5)).toBe(210);
    expect(sizeInTwips(10.51)).toBe(210);
    expect(sizeInTwips(10.56)).toBe(211);
    expect(sizeInTwips(0)).toBe(1);
  });
});

describe.skipIf(!built)('the kernel behind the measurer interface', () => {
  it('has the shape of the engine’s TextMeasurer and measures in points', async () => {
    const kernel = await localKernel();
    const measurer = kernelTextMeasurer(kernel);
    const font = { family: alias(SERIF), sizePt: 12, bold: false, italic: false };
    expect(measurer.id).toMatch(/^kernel\/harfrust@\d+\.\d+\.\d+$/);
    const text = 'Typography is the craft of setting type.';
    const advances = measurer.advances(font, text);
    expect(advances).toHaveLength(text.length);
    // The per-unit advances sum to the run's advance, as the interface says.
    expect(advances.reduce((a, b) => a + b, 0)).toBeCloseTo(measurer.advance(font, text), 9);
    // The width is a whole number of 1/1280 pt, so the result is identical wherever it is computed.
    expect(Number.isInteger(measurer.advance(font, text) * 1280)).toBe(true);
    // A longer run is wider; the same run twice gives the same answer.
    expect(measurer.advance(font, text + text)).toBeGreaterThan(measurer.advance(font, text));
    expect(measurer.advance(font, text)).toBe(measurer.advance(font, text));
    expect(measurer.advance(font, '')).toBe(0);
    expect(measurer.advances(font, '')).toEqual([]);
    const metrics = measurer.lineMetrics(font);
    expect(metrics.ascent).toBeGreaterThan(0);
    expect(metrics.descent).toBeGreaterThan(0);
  });

  it('measures a face at its own size and a bigger size gives a proportionally bigger width', async () => {
    const kernel = await localKernel();
    const measurer = kernelTextMeasurer(kernel);
    const text = 'Measure me';
    const at = (sizePt: number, name = SERIF): number =>
      measurer.advance({ family: alias(name), sizePt, bold: false, italic: false }, text);
    expect(at(24)).toBeCloseTo(2 * at(12), 1);
    expect(at(12, BOLD)).toBeGreaterThan(at(12));
  });

  it('asks the worker for the advances of whole blocks, and gets what the same kernel gives here', async () => {
    const local = kernelTextMeasurer(await localKernel());
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    await worker.ensureFaces(PLATFORM_FONTS, kernelFaceRequests(manifestFiles));
    const blocks = ['Typography is the craft', 'of setting type — AVATAR', 'Zażółć gęślą'];
    const runs = [
      { alias: alias(SERIF), sizeTwips: 240, language: '', features: '' },
      { alias: alias(BOLD), sizeTwips: 300, language: 'en', features: '' },
      { alias: alias(SERIF), sizeTwips: 210, language: 'pl', features: 'kern=0' },
    ];
    const values = await worker.measure(runs, blocks);
    expect(values).toBeInstanceOf(Int32Array);
    expect(values).toHaveLength(blocks.join('').length);
    // Block by block it is what the measurer gives in this thread, in 1/1280 pt.
    let at = 0;
    for (const [i, block] of blocks.entries()) {
      const run = runs[i]!;
      const kernel = await localKernel();
      const expected = kernel.shaper.advances(run, block);
      expect(Array.from(values.subarray(at, at + block.length))).toEqual(Array.from(expected));
      at += block.length;
    }
    expect(
      local.advance({ family: alias(SERIF), sizePt: 12, bold: false, italic: false }, 'x'),
    ).toBeGreaterThan(0);
    expect(worker.stats.at(-1)).toMatchObject({ op: 'advances', blocks: 3 });
    expect(worker.stats.at(-1)!.roundTripMs).toBeGreaterThan(0);
    worker.terminate();
  });

  it('transfers the batch and the answer, and refuses a face it does not hold without ending', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    await worker.ensureFaces(PLATFORM_FONTS, kernelFaceRequests(manifestFiles));
    const known = { alias: alias(SERIF), sizeTwips: 240, language: '', features: '' };
    await expect(
      worker.measure([{ ...known, alias: 'de-font-nowhere' }], ['abc']),
    ).rejects.toMatchObject({ code: 'unknown_face' });
    await expect(
      worker.measure([{ ...known, features: 'not a feature' }], ['abc']),
    ).rejects.toMatchObject({ code: 'bad_feature' });
    // A request with a run missing for a block is refused too.
    await expect(worker.measure([known], ['a', 'b'])).rejects.toMatchObject({
      code: 'bad_request',
    });
    // The worker is alive: a good request still works.
    expect((await worker.measure([known], ['abc'])).length).toBe(3);
    expect(worker.alive).toBe(true);
    worker.terminate();
  });

  it('measures through the element’s kernel, and starts again after a suspend', async () => {
    const world = nodeWorld();
    const kernel = new ElementKernel(() => undefined, { load: world.load });
    const run = { alias: alias(SERIF), sizeTwips: 240, language: '', features: '' };
    await kernel.ensureFaces(PLATFORM_FONTS, kernelFaceRequests(manifestFiles));
    const first = await kernel.measure([run], ['hello']);
    kernel.stop();
    // The faces went with the worker: the next measurement says so, and loads again on demand.
    await expect(kernel.measure([run], ['hello'])).rejects.toMatchObject({ code: 'unknown_face' });
    await kernel.ensureFaces(PLATFORM_FONTS, kernelFaceRequests(manifestFiles));
    expect(Array.from(await kernel.measure([run], ['hello']))).toEqual(Array.from(first));
    kernel.destroy();
  });
});
