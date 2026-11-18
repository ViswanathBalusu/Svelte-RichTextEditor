/**
 * The layout kernel's loader (WASM-002; ADR 0016). This module is a lazy chunk of its own: the core
 * reaches it only through `requestLayoutKernel` (../layout-kernel-request.ts), so a session that
 * never opens the page view fetches and compiles no WebAssembly.
 *
 * The module's file is an asset of the build, never inlined as base64 (`assetsInlineLimit: 0`;
 * FND-008 fails the build otherwise). Its URL is resolved against this chunk's own URL, so it loads
 * from the origin that serves the component, as the PDF viewer's page and the measuring worker do.
 *
 * Starting: the response is compiled while it streams (`WebAssembly.compileStreaming`) when the
 * server calls the file `application/wasm`. For any other media type the bytes are read whole and
 * compiled with `WebAssembly.compile`, which does not check the type. The compiled module is then
 * given to the generated module's start, which instantiates it. Compiling apart from instantiating
 * is what lets the page hand one compiled module to every layout worker (WASM-004). This loader runs
 * inside the layout worker (./layout-worker.ts), so the page thread compiles nothing.
 */
import { startKernel, type KernelGlueModule, type LayoutKernel } from '@docedit/layout-kernel';
import type { DiagnosticDetail } from '../events.ts';

/** Where the module comes from. */
export interface KernelSource {
  /** The generated ES module of wasm-bindgen. */
  glue(): Promise<KernelGlueModule>;
  /** The URL of the WebAssembly file, absolute or relative to the page. */
  url(): string;
}

export interface LoadKernelOptions {
  /** The worker's own files (./features/layout-worker.ts), or a test's. */
  source: KernelSource;
  /** The fetch of the page. Replaceable for tests. */
  fetch?: typeof fetch;
  /** Milliseconds, monotonic. Replaceable for tests. */
  now?: () => number;
  /**
   * A module that was compiled already (by another worker of the page, WASM-004). Nothing is
   * fetched or compiled then; the module only gets a new instance.
   */
  module?: unknown;
}

/** What a load tells the caller: the started kernel and the numbers the diagnostic event carries. */
export interface KernelLoad {
  kernel: LayoutKernel;
  report: DiagnosticDetail;
  /** The compiled module, which another realm of the page can start its own instance from. */
  module: unknown;
}

/** A failed load, with the code of `DiagnosticDetail` and the directive when the policy is to blame. */
export class KernelLoadError extends Error {
  override name = 'KernelLoadError';
  readonly code: string;
  readonly directive: string | null;
  readonly bytes: number | null;
  readonly streaming: boolean | null;
  constructor(
    code: string,
    message: string,
    extra: { directive?: string | null; bytes?: number | null; streaming?: boolean | null } = {},
  ) {
    super(message);
    this.code = code;
    this.directive = extra.directive ?? null;
    this.bytes = extra.bytes ?? null;
    this.streaming = extra.streaming ?? null;
  }
}

/** The directive a host adds when the page's own policy refuses to compile the module (S2, section 6). */
export const WASM_DIRECTIVE = "script-src 'wasm-unsafe-eval'";

/**
 * The browsers word a refused compilation differently: Chromium and Edge name `unsafe-eval` or
 * `wasm-eval`, Firefox says the call is blocked by the policy, WebKit throws an `EvalError` or a
 * `CompileError` and sends no report (S2).
 */
const POLICY_WORDS = /unsafe-eval|wasm-eval|blocked by csp|content security policy|not allowed/i;

/** Which failure an error of the start is. `magicOk` says the file begins like a module. */
export function classifyStartError(error: unknown, magicOk: boolean): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (POLICY_WORDS.test(message) || name === 'EvalError') return 'blocked_by_policy';
  // A file that begins with the module's magic number and still does not compile was refused by
  // the browser, not damaged. WebKit reports nothing more than that.
  if (name === 'CompileError' && magicOk) return 'blocked_by_policy';
  if (name === 'CompileError' || name === 'LinkError') return 'bad_module';
  return 'compile_failed';
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function hasMagic(bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Fetches, compiles and starts the kernel. Throws `KernelLoadError`; never leaves a half-started
 * module. Reports nothing by itself: the caller turns `report` or the error into the event.
 */
export async function loadLayoutKernel(options: LoadKernelOptions): Promise<KernelLoad> {
  const source = options.source;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => performance.now());
  const started = now();

  let glue: KernelGlueModule;
  try {
    glue = await source.glue();
  } catch (error) {
    throw new KernelLoadError('chunk_failed', `the kernel's loader did not load: ${text(error)}`);
  }

  if (options.module !== undefined)
    return startFrom(glue, options.module, null, null, started, now);

  let response: Response;
  try {
    response = await doFetch(source.url(), { credentials: 'same-origin' });
  } catch (error) {
    throw new KernelLoadError('fetch_failed', `the kernel could not be fetched: ${text(error)}`);
  }
  if (!response.ok)
    throw new KernelLoadError('fetch_failed', `the kernel's server answered ${response.status}`);

  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const streaming =
    type === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function';
  let bytes: number | null;
  let magicOk = true;
  let compiled: unknown;
  if (!streaming) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    bytes = buffer.length;
    magicOk = hasMagic(buffer);
    if (!magicOk)
      throw new KernelLoadError('bad_module', 'the file is not a WebAssembly module', {
        bytes,
        streaming,
      });
    try {
      compiled = await WebAssembly.compile(buffer);
    } catch (error) {
      throw compileError(error, magicOk, bytes, streaming);
    }
  } else {
    // The size of a streamed file is the header's, when the server says it.
    const length = Number(response.headers.get('content-length'));
    bytes = Number.isFinite(length) && length > 0 ? length : null;
    try {
      compiled = await WebAssembly.compileStreaming(response);
    } catch (error) {
      throw compileError(error, magicOk, bytes, streaming);
    }
  }
  return startFrom(glue, compiled, bytes, streaming, started, now);
}

/** Starts an instance from a compiled module and reports it. */
async function startFrom(
  glue: KernelGlueModule,
  module: unknown,
  bytes: number | null,
  streaming: boolean | null,
  started: number,
  now: () => number,
): Promise<KernelLoad> {
  let kernel: LayoutKernel;
  try {
    kernel = await startKernel(glue, module);
  } catch (error) {
    const message = text(error);
    if (/interface version/.test(message))
      throw new KernelLoadError('abi_mismatch', message, { bytes, streaming });
    throw compileError(error, true, bytes, streaming);
  }
  return {
    kernel,
    module,
    report: {
      feature: 'layout-kernel',
      kind: 'loaded',
      ms: Math.round((now() - started) * 10) / 10,
      bytes,
      streaming,
      code: null,
      directive: null,
      fallback: null,
    },
  };
}

function compileError(
  error: unknown,
  magicOk: boolean,
  bytes: number | null,
  streaming: boolean | null,
): KernelLoadError {
  const code = classifyStartError(error, magicOk);
  return new KernelLoadError(code, `the kernel did not start: ${text(error)}`, {
    directive: code === 'blocked_by_policy' ? WASM_DIRECTIVE : null,
    bytes,
    streaming,
  });
}
function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
