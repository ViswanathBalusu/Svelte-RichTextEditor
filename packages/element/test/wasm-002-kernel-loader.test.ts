/**
 * WASM-002: the layout kernel loads on demand. These tests run the real loader on the real build of
 * the crate (`packages/layout-kernel/dist`, from `pnpm --filter @docedit/layout-kernel build:wasm`)
 * in Node.js, which has `fetch`, `Response` and `WebAssembly.instantiateStreaming`. The browser
 * runs of the same loader are in e2e/wasm-002-kernel-load.spec.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KernelGlueModule } from '@docedit/layout-kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticDetail } from '../src/events.ts';
import {
  classifyStartError,
  loadLayoutKernel,
  type KernelSource,
} from '../src/features/layout-kernel.ts';
import { requestLayoutKernel, resetLayoutKernelRequests } from '../src/layout-kernel-request.ts';

const dist = resolve(import.meta.dirname, '../../layout-kernel/dist');
const built = existsSync(resolve(dist, 'docedit_layout_kernel_bg.wasm'));
const wasmBytes = (): Uint8Array =>
  new Uint8Array(readFileSync(resolve(dist, 'docedit_layout_kernel_bg.wasm')));

/** A fresh copy of the generated module per test, so that each starts its own instance. */
const freshGlue = async (): Promise<KernelGlueModule> =>
  (await import(
    /* @vite-ignore */ `${pathToFileURL(resolve(dist, 'docedit_layout_kernel.js')).href}?run=${Math.random()}`
  )) as KernelGlueModule;

const source: KernelSource = { glue: freshGlue, url: () => 'https://host.test/kernel.wasm' };

function serve(
  contentType: string | null,
  body: BodyInit | null = wasmBytes().slice().buffer,
  status = 200,
) {
  return vi.fn(
    async () =>
      new Response(body, {
        status,
        headers: contentType === null ? {} : { 'content-type': contentType },
      }),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLayoutKernelRequests();
});

describe('classifyStartError', () => {
  it('names a refused compilation by the words of each browser', () => {
    const chromium = new Error(
      "WebAssembly.instantiate(): Refused to compile or instantiate WebAssembly module because 'unsafe-eval' or 'wasm-unsafe-eval' is not an allowed source of script",
    );
    expect(classifyStartError(chromium, true)).toBe('blocked_by_policy');
    expect(
      classifyStartError(new Error('call to WebAssembly.compile() blocked by CSP'), true),
    ).toBe('blocked_by_policy');
    const webkit = Object.assign(new Error('Refused to evaluate'), { name: 'EvalError' });
    expect(classifyStartError(webkit, true)).toBe('blocked_by_policy');
  });

  it('takes a compile error on a file that starts like a module as the policy, and others as damage', () => {
    const compile = Object.assign(new Error('x'), { name: 'CompileError' });
    expect(classifyStartError(compile, true)).toBe('blocked_by_policy');
    expect(classifyStartError(compile, false)).toBe('bad_module');
    expect(classifyStartError(new Error('boom'), true)).toBe('compile_failed');
  });
});

describe.skipIf(!built)('loadLayoutKernel on the build of the crate', () => {
  it('compiles with instantiateStreaming when the server says application/wasm', async () => {
    const streaming = vi.spyOn(WebAssembly, 'instantiateStreaming');
    const buffered = vi.spyOn(WebAssembly, 'instantiate');
    const { kernel, report } = await loadLayoutKernel({
      source,
      fetch: serve('application/wasm'),
    });
    expect(streaming).toHaveBeenCalledTimes(1);
    expect(buffered).not.toHaveBeenCalled();
    expect(kernel.abi).toBe(1);
    expect(kernel.checksum(new TextEncoder().encode('a'))).toBe(0xe40c292c);
    expect(report).toMatchObject({
      feature: 'layout-kernel',
      kind: 'loaded',
      streaming: true,
      code: null,
      directive: null,
    });
    expect(report.ms).toBeGreaterThanOrEqual(0);
  });

  it('falls back to instantiate from an ArrayBuffer when the media type is not application/wasm', async () => {
    const streaming = vi.spyOn(WebAssembly, 'instantiateStreaming');
    const buffered = vi.spyOn(WebAssembly, 'instantiate');
    for (const type of ['application/octet-stream', 'text/plain; charset=utf-8', null]) {
      streaming.mockClear();
      buffered.mockClear();
      const { kernel, report } = await loadLayoutKernel({ source, fetch: serve(type) });
      expect(streaming).not.toHaveBeenCalled();
      // The bytes go to `WebAssembly.instantiate`; the runtime may call it again inside its own start.
      expect(
        buffered.mock.calls.some((c) => c[0] instanceof Uint8Array),
        type ?? 'none',
      ).toBe(true);
      expect(kernel.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report).toMatchObject({ kind: 'loaded', streaming: false, bytes: wasmBytes().length });
    }
  });

  it('asks the page origin only: same-origin credentials, the URL of the source', async () => {
    const fetcher = serve('application/wasm');
    await loadLayoutKernel({ source, fetch: fetcher });
    expect(fetcher).toHaveBeenCalledWith('https://host.test/kernel.wasm', {
      credentials: 'same-origin',
    });
  });

  it('measures time with the clock it is given', async () => {
    const ticks = [100, 112.34];
    const { report } = await loadLayoutKernel({
      source,
      fetch: serve('application/wasm'),
      now: () => ticks.shift() ?? 0,
    });
    expect(report.ms).toBe(12.3);
  });

  it('fails with a code for a missing file, a refused fetch, a damaged file and a stale module', async () => {
    await expect(loadLayoutKernel({ source, fetch: serve(null, 'no', 404) })).rejects.toMatchObject(
      {
        code: 'fetch_failed',
      },
    );
    const refused = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(loadLayoutKernel({ source, fetch: refused })).rejects.toMatchObject({
      code: 'fetch_failed',
    });
    await expect(
      loadLayoutKernel({ source, fetch: serve('application/octet-stream', 'not a module') }),
    ).rejects.toMatchObject({ code: 'bad_module' });
    const stale: KernelSource = {
      url: source.url,
      glue: async () => ({ ...(await freshGlue()), abi_version: () => 99 }) as KernelGlueModule,
    };
    await expect(
      loadLayoutKernel({ source: stale, fetch: serve('application/wasm') }),
    ).rejects.toMatchObject({ code: 'abi_mismatch' });
  });

  it('names the directive when the browser refuses to compile', async () => {
    vi.spyOn(WebAssembly, 'instantiateStreaming').mockRejectedValue(
      new Error("Refused to compile WebAssembly module because 'wasm-unsafe-eval' is not allowed"),
    );
    await expect(
      loadLayoutKernel({ source, fetch: serve('application/wasm') }),
    ).rejects.toMatchObject({
      code: 'blocked_by_policy',
      directive: "script-src 'wasm-unsafe-eval'",
    });
  });

  it('reports a loader chunk that does not load', async () => {
    const missing: KernelSource = {
      url: source.url,
      glue: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
    };
    await expect(
      loadLayoutKernel({ source: missing, fetch: serve('application/wasm') }),
    ).rejects.toMatchObject({ code: 'chunk_failed' });
  });
});

describe.skipIf(!built)('requestLayoutKernel', () => {
  const loader = { loadLayoutKernel };
  const load = (fetchImpl: typeof fetch) => async () => ({
    loader: {
      loadLayoutKernel: (o: Parameters<typeof loadLayoutKernel>[0]) =>
        loader.loadLayoutKernel({ ...o, fetch: fetchImpl }),
    },
    source,
  });

  it('reports a load through the callback, once for each request, and loads once for all', async () => {
    const fetcher = serve('application/wasm');
    const reports: DiagnosticDetail[] = [];
    const [a, b] = await Promise.all([
      requestLayoutKernel((d) => reports.push(d), { load: load(fetcher) }),
      requestLayoutKernel((d) => reports.push(d), { load: load(fetcher) }),
    ]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reports.map((r) => r.kind)).toEqual(['loaded', 'loaded']);
  });

  it('reports a failure, resolves to null and tries again on the next request', async () => {
    const reports: DiagnosticDetail[] = [];
    const first = await requestLayoutKernel((d) => reports.push(d), {
      load: load(serve(null, 'gone', 503)),
    });
    expect(first).toBeNull();
    expect(reports[0]).toMatchObject({
      kind: 'load-failed',
      code: 'fetch_failed',
      ms: null,
      directive: null,
    });
    const second = await requestLayoutKernel((d) => reports.push(d), {
      load: load(serve('application/wasm')),
    });
    expect(second).not.toBeNull();
    expect(reports[1]?.kind).toBe('loaded');
  });

  it('reports a loader chunk that fails to load as chunk_failed', async () => {
    const reports: DiagnosticDetail[] = [];
    const result = await requestLayoutKernel((d) => reports.push(d), {
      load: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
    });
    expect(result).toBeNull();
    expect(reports[0]).toMatchObject({ kind: 'load-failed', code: 'chunk_failed' });
  });
});
