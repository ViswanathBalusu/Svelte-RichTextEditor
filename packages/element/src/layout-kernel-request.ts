/**
 * The core's only way to the layout kernel (WASM-002; ADR 0016). Nothing here imports the kernel or
 * its loader statically: `requestLayoutKernel` loads them on first use, so a session that only uses
 * the web view fetches and compiles no WebAssembly, and the first interactive chunk holds none
 * (FND-008 fails the build otherwise; critical-path.test.ts).
 *
 * One load serves every element of the page. Each request reports to its own element, through
 * `de-diagnostic`: how long the load took, or why it failed and which directive the host lacks.
 */
import type { LayoutKernel } from '@docedit/layout-kernel';
import type { DiagnosticDetail } from './events.ts';
import type { KernelLoad, LoadKernelOptions, loadLayoutKernel } from './features/layout-kernel.ts';

type Loader = { loadLayoutKernel: typeof loadLayoutKernel };

export interface RequestOptions {
  /** Replaceable for tests: the chunk of the loader and the files it loads. */
  load?: () => Promise<{
    loader: Loader;
    source: LoadKernelOptions['source'];
  }>;
}

const failure = (
  code: string,
  extra: Partial<Pick<DiagnosticDetail, 'directive' | 'bytes' | 'streaming'>> = {},
): DiagnosticDetail => ({
  feature: 'layout-kernel',
  kind: 'load-failed',
  ms: null,
  bytes: extra.bytes ?? null,
  streaming: extra.streaming ?? null,
  code,
  directive: extra.directive ?? null,
  fallback: null,
});

let shared: Promise<KernelLoad> | null = null;

async function defaultLoad(): Promise<{
  loader: Loader;
  source: LoadKernelOptions['source'];
}> {
  const [loader, { BUILD_SOURCE }] = await Promise.all([
    import('./features/layout-kernel.ts'),
    import('./features/layout-kernel-source.ts'),
  ]);
  return { loader, source: BUILD_SOURCE };
}

/**
 * Loads the kernel (once per page) and tells `report` how it went. Resolves to the kernel, or to
 * `null` after a failure that `report` has described; it never rejects. A failed load is not
 * remembered, so a later request tries again.
 */
export async function requestLayoutKernel(
  report: (detail: DiagnosticDetail) => void,
  options: RequestOptions = {},
): Promise<LayoutKernel | null> {
  if (shared === null) {
    shared = (async () => {
      let loaded;
      try {
        loaded = await (options.load ?? defaultLoad)();
      } catch (error) {
        // The chunk of the loader, or of the build's files, did not load (network, or a policy).
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
          code: 'chunk_failed',
        });
      }
      return loaded.loader.loadLayoutKernel({ source: loaded.source });
    })();
  }
  const attempt = shared;
  try {
    const { kernel, report: detail } = await attempt;
    report(detail);
    return kernel;
  } catch (error) {
    if (shared === attempt) shared = null;
    const e = error as {
      code?: unknown;
      directive?: unknown;
      bytes?: unknown;
      streaming?: unknown;
    };
    report(
      failure(typeof e.code === 'string' ? e.code : 'compile_failed', {
        directive: typeof e.directive === 'string' ? e.directive : null,
        bytes: typeof e.bytes === 'number' ? e.bytes : null,
        streaming: typeof e.streaming === 'boolean' ? e.streaming : null,
      }),
    );
    return null;
  }
}

/** Forgets the shared load. For tests. */
export function resetLayoutKernelRequests(): void {
  shared = null;
}
