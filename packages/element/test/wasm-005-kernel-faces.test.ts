/**
 * WASM-005: font faces from the manifest inside the kernel. The real worker core and the real build
 * of the crate run in `worker_threads` workers (./support/layout-worker-node.ts), whose `fetch`
 * serves the real font files of packages/perf/fonts under the manifest's URLs. The browser run is
 * in e2e/wasm-005-kernel-faces.spec.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { manifestFontFiles } from '../src/font-manifest.ts';
import { fontAlias } from '../src/font-registration.ts';
import { LayoutWorker, type WorkerLike } from '../src/features/layout-worker-host.ts';
import { kernelFaceRequests, PLATFORM_FONTS, tenantFonts } from '../src/kernel-faces.ts';
import {
  ElementKernel,
  resetLayoutKernelRequests,
  type WorkerHostModule,
} from '../src/layout-kernel-request.ts';

const dist = resolve(import.meta.dirname, '../../layout-kernel/dist');
const fonts = resolve(import.meta.dirname, '../../perf/fonts/files');
const built = existsSync(resolve(dist, 'docedit_layout_kernel_bg.wasm'));
const script = resolve(import.meta.dirname, 'support/layout-worker-node.ts');

const sha = (name: string): string =>
  createHash('sha256')
    .update(readFileSync(resolve(fonts, name)))
    .digest('hex');
const size = (name: string): number => readFileSync(resolve(fonts, name)).length;

/** A manifest as the document service serves it (05 §6.2), with real hashes. */
const manifest = {
  families: [
    {
      family: 'Noto Serif',
      licence: 'OFL-1.1',
      faces: [
        {
          url: 'https://host.test/fonts/NotoSerif-Regular.ttf',
          sha256: sha('NotoSerif-Regular.ttf'),
          weight: 400,
          italic: false,
        },
        {
          url: 'https://host.test/fonts/NotoSerif-Bold.ttf',
          sha256: sha('NotoSerif-Bold.ttf'),
          weight: 700,
          italic: false,
        },
      ],
    },
    {
      family: 'Harano Aji Gothic',
      licence: 'BSD-3-Clause',
      faces: [
        {
          url: 'https://host.test/fonts/HaranoAjiGothic-Regular.otf',
          sha256: sha('HaranoAjiGothic-Regular.otf'),
          weight: 400,
          italic: false,
        },
      ],
    },
  ],
};
const files = manifestFontFiles(manifest);
const aliasOf = (name: string): string => fontAlias(sha(name));

function nodeWorld(data: Record<string, unknown> = {}) {
  const made: Worker[] = [];
  const create = (): WorkerLike => {
    const worker = new Worker(script, { workerData: data, execArgv: ['--no-warnings'] });
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
  /** The URLs the nth worker has fetched. */
  const fetched = (n = 0): Promise<string[]> =>
    new Promise((done) => {
      const worker = made[n]!;
      const listener = (m: { type?: string; urls?: string[] }) => {
        if (m.type !== '__fetched') return;
        worker.off('message', listener);
        done(m.urls ?? []);
      };
      worker.on('message', listener);
      worker.postMessage({ type: '__fetched' });
    });
  return { made, create, load: () => Promise.resolve(host), fetched };
}

afterEach(() => resetLayoutKernelRequests());

describe('the kernel’s requests from the manifest', () => {
  it('uses the editor’s own alias, the manifest’s URL and hash, once for each file', () => {
    const requests = kernelFaceRequests([...files, files[0]!]);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({
      alias: fontAlias(sha('NotoSerif-Regular.ttf')),
      url: 'https://host.test/fonts/NotoSerif-Regular.ttf',
      hash: sha('NotoSerif-Regular.ttf'),
    });
  });

  it('asks only for the aliases a document uses, so a face nobody uses is never named', () => {
    const used = new Set([aliasOf('NotoSerif-Bold.ttf')]);
    expect(kernelFaceRequests(files, used).map((r) => r.url)).toEqual([
      'https://host.test/fonts/NotoSerif-Bold.ttf',
    ]);
    expect(kernelFaceRequests(files, new Set())).toEqual([]);
  });

  it('names the platform’s fonts and each tenant’s own as different owners', () => {
    expect(PLATFORM_FONTS).toBe('');
    expect(tenantFonts('acme')).toBe('tenant:acme');
    expect(tenantFonts('acme')).not.toBe(tenantFonts('globex'));
  });
});

describe.skipIf(!built)('faces in the layout worker', () => {
  it('loads the manifest’s file for an alias, checks it and reports the memory it takes', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    const answer = await worker.ensureFaces(
      PLATFORM_FONTS,
      kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Regular.ttf')])),
    );
    expect(answer.loaded).toEqual([aliasOf('NotoSerif-Regular.ttf')]);
    expect(answer.failed).toEqual([]);
    expect(answer.status).toMatchObject({
      count: 1,
      bytesHeld: size('NotoSerif-Regular.ttf'),
      epoch: 1,
    });
    expect(answer.status.memoryBytes).toBeGreaterThanOrEqual(size('NotoSerif-Regular.ttf'));
    expect(await world.fetched()).toEqual([
      'https://host.test/kernel.wasm',
      'https://host.test/fonts/NotoSerif-Regular.ttf',
    ]);
    worker.terminate();
  });

  it('refuses a file whose SHA-256 is not the manifest’s and keeps the others', async () => {
    const world = nodeWorld({ corrupt: ['NotoSerif-Bold.ttf'] });
    const { worker } = await LayoutWorker.start({ create: world.create });
    const answer = await worker.ensureFaces(PLATFORM_FONTS, kernelFaceRequests(files.slice(0, 2)));
    expect(answer.loaded).toEqual([aliasOf('NotoSerif-Regular.ttf')]);
    expect(answer.failed).toEqual([
      expect.objectContaining({ alias: aliasOf('NotoSerif-Bold.ttf'), code: 'hash_mismatch' }),
    ]);
    expect(answer.status.count).toBe(1);
    expect(answer.status.bytesHeld).toBe(size('NotoSerif-Regular.ttf'));
    worker.terminate();
  });

  it('reports a file that cannot be fetched without stopping the rest', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    const answer = await worker.ensureFaces(PLATFORM_FONTS, [
      { alias: 'de-font-gone', url: 'https://host.test/fonts/missing.ttf', hash: 'a'.repeat(64) },
      ...kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Regular.ttf')])),
    ]);
    expect(answer.failed).toEqual([
      expect.objectContaining({ alias: 'de-font-gone', code: 'fetch_failed' }),
    ]);
    expect(answer.loaded).toHaveLength(1);
    worker.terminate();
  });

  it('loads a face on demand, once for the worker, however many requests ask at once', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    const request = kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Regular.ttf')]));
    const [a, b] = await Promise.all([
      worker.ensureFaces(PLATFORM_FONTS, request),
      worker.ensureFaces(PLATFORM_FONTS, request),
    ]);
    expect([...a.loaded, ...b.loaded]).toHaveLength(1);
    expect([...a.already, ...b.already]).toHaveLength(1);
    // A later request finds it held and fetches nothing.
    const later = await worker.ensureFaces(PLATFORM_FONTS, request);
    expect(later.loaded).toEqual([]);
    expect(later.already).toHaveLength(1);
    const fontFetches = (await world.fetched()).filter((u) => u.includes('/fonts/'));
    expect(fontFetches).toEqual(['https://host.test/fonts/NotoSerif-Regular.ttf']);
    worker.terminate();
  });

  it('loads a CJK face only when a document uses it, and counts its memory', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    // A Latin-only document: the CJK file is in the manifest and is not touched.
    const latin = await worker.ensureFaces(
      PLATFORM_FONTS,
      kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Regular.ttf')])),
    );
    expect(latin.status.bytesHeld).toBe(size('NotoSerif-Regular.ttf'));
    expect((await world.fetched()).some((u) => u.includes('Harano'))).toBe(false);
    // A block in Japanese arrives: now the face is named, loaded and counted.
    const cjk = await worker.ensureFaces(
      PLATFORM_FONTS,
      kernelFaceRequests(files, new Set([aliasOf('HaranoAjiGothic-Regular.otf')])),
    );
    expect(cjk.status.bytesHeld).toBe(
      size('NotoSerif-Regular.ttf') + size('HaranoAjiGothic-Regular.otf'),
    );
    expect(cjk.status.count).toBe(2);
    expect(cjk.status.memoryBytes).toBeGreaterThanOrEqual(cjk.status.bytesHeld);
    expect((await worker.status()).bytesHeld).toBe(cjk.status.bytesHeld);
    worker.terminate();
  });

  it('advances the font epoch for each face that arrives, and not for one held already', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    const serif = kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Regular.ttf')]));
    const bold = kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Bold.ttf')]));
    expect((await worker.status()).epoch).toBe(0);
    expect((await worker.ensureFaces(PLATFORM_FONTS, serif)).status.epoch).toBe(1);
    expect((await worker.ensureFaces(PLATFORM_FONTS, serif)).status.epoch).toBe(1);
    expect((await worker.ensureFaces(PLATFORM_FONTS, bold)).status.epoch).toBe(2);
    worker.terminate();
  });

  it('holds a tenant’s own face for that tenant only, and frees it with the tenant', async () => {
    const world = nodeWorld();
    const { worker } = await LayoutWorker.start({ create: world.create });
    const own = kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Bold.ttf')]));
    const shared = kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Regular.ttf')]));
    await worker.ensureFaces(PLATFORM_FONTS, shared);
    expect((await worker.ensureFaces(tenantFonts('acme'), own)).loaded).toHaveLength(1);
    // Another tenant's document does not get acme's face, and nothing is fetched for the try.
    const before = (await world.fetched()).length;
    const refused = await worker.ensureFaces(tenantFonts('globex'), own);
    expect(refused.loaded).toEqual([]);
    expect(refused.failed).toEqual([expect.objectContaining({ code: 'owner_conflict' })]);
    expect((await world.fetched()).length).toBe(before);
    // When acme's document is closed its faces go; the platform's stay; globex can now hold its own.
    const after = await worker.releaseFaces(tenantFonts('acme'));
    expect(after.count).toBe(1);
    expect(after.bytesHeld).toBe(size('NotoSerif-Regular.ttf'));
    expect((await worker.ensureFaces(tenantFonts('globex'), own)).loaded).toHaveLength(1);
    expect((await worker.releaseFaces(null)).count).toBe(0);
    worker.terminate();
  });
});

describe.skipIf(!built)('faces and the element’s kernel', () => {
  it('releases the faces with the worker on destroy, and starts without them after a suspend', async () => {
    const world = nodeWorld();
    const kernel = new ElementKernel(() => undefined, { load: world.load });
    const serif = kernelFaceRequests(files, new Set([aliasOf('NotoSerif-Regular.ttf')]));
    expect((await kernel.ensureFaces(PLATFORM_FONTS, serif)).status.count).toBe(1);
    kernel.stop();
    // The first use after the resume creates a worker with no faces: they load again on demand.
    expect((await kernel.status()).count).toBe(0);
    expect((await kernel.ensureFaces(PLATFORM_FONTS, serif)).loaded).toHaveLength(1);
    expect(world.made).toHaveLength(2);
    kernel.destroy();
    await expect(kernel.ensureFaces(PLATFORM_FONTS, serif)).rejects.toMatchObject({
      code: 'kernel_unavailable',
    });
  });
});
