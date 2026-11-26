/**
 * Runs the Word importer in a single-use Podman sandbox (EXP-099 criterion 1; 09 §12; 10 §3.5): no
 * network, no credentials, a read-only root, cgroup limits and a wall-clock limit, as for the
 * asset worker's content checks (sandbox-podman.ts). The request is the bytes of the `.docx` file on
 * standard input and the reply is one JSON document on standard output, so no host path is mounted.
 * The image is built by scripts/build-import-image.ts and is never pulled at job time.
 *
 * The result has the shape of the document service's `DocxImporter` port (control-plane/imports.ts),
 * so a node passes `sandboxedDocxImporter(...)` as its `importer`.
 */
import { podmanMachine, runningMachine } from './container.ts';
import { podmanSandbox, type PodmanSandboxOptions } from './sandbox-podman.ts';
import type { Sandbox } from './sandbox-port.ts';

export const IMPORT_IMAGE =
  process.env['DOCEDIT_IMPORT_IMAGE'] ?? 'localhost/docedit-import-worker:dev';

/** What the importer returns, as the document service's port takes it. */
export interface SandboxImported {
  envelope: unknown;
  warnings: ReadonlyArray<string | Record<string, unknown>>;
  preservation?: Record<string, unknown>;
}

/** The import failed for a reason that is not the file's: the engine, a limit or the sandbox. */
export class ImportSandboxError extends Error {
  override name = 'ImportSandboxError';
}

/**
 * A sandbox for imports: the Podman sandbox over the import image, with a wall-clock limit that
 * suits a large file (a setting, not a measurement).
 */
export function podmanImportSandbox(opts: PodmanSandboxOptions = {}): Sandbox {
  return podmanSandbox({ image: IMPORT_IMAGE, ...opts });
}

/**
 * The importer that runs in `sandbox`. The importer's refusal of a file (a hostile package, a
 * macro-enabled file, a document type declaration) throws an `Error` with the importer's message;
 * a failure of the sandbox itself throws `ImportSandboxError`.
 */
export function sandboxedDocxImporter(
  sandbox: Sandbox,
): (bytes: Uint8Array, opts: { signal: AbortSignal }) => Promise<SandboxImported> {
  return async (bytes, opts) => {
    const run = await sandbox.run(bytes, { signal: opts.signal });
    if (run.aborted) throw new ImportSandboxError('the import was cancelled');
    if (run.engineError) throw new ImportSandboxError('the sandbox could not start');
    if (run.timedOut)
      throw new ImportSandboxError('the import took longer than the sandbox allows');
    if (run.outputOverflow)
      throw new ImportSandboxError('the import produced more than the sandbox allows');
    if (run.exitCode !== 0)
      throw new ImportSandboxError(`the sandbox failed (exit ${run.exitCode ?? 'killed'})`);
    let reply: unknown;
    try {
      reply = JSON.parse(new TextDecoder().decode(run.stdout));
    } catch {
      throw new ImportSandboxError('the sandbox gave no reply');
    }
    const r = reply as {
      ok?: unknown;
      message?: unknown;
      envelope?: unknown;
      warnings?: unknown;
      preservation?: unknown;
    };
    if (r.ok === false) throw new Error(typeof r.message === 'string' ? r.message : 'refused');
    if (r.ok !== true || typeof r.envelope !== 'object' || !Array.isArray(r.warnings))
      throw new ImportSandboxError('the sandbox gave a reply that is not an import');
    return {
      envelope: r.envelope,
      warnings: r.warnings as SandboxImported['warnings'],
      ...(r.preservation && typeof r.preservation === 'object'
        ? { preservation: r.preservation as Record<string, unknown> }
        : {}),
    };
  };
}

/**
 * Whether a container with the sandbox's limits starts from the import image: Podman answers and
 * the image exists. As for the asset worker (`sandboxReady`), a host whose Podman machine cannot
 * apply cgroup limits through the remote client gets one more try through the machine route
 * (DOCEDIT_PODMAN_MACHINE, container.ts).
 */
export async function importSandboxReady(image = IMPORT_IMAGE): Promise<boolean> {
  const attempt = async (): Promise<boolean> => {
    try {
      const r = await podmanSandbox({
        image,
        entrypoint: 'node',
        command: ['--input-type=module', '-'],
        limits: { wallSeconds: 60 },
      }).run(new TextEncoder().encode('process.stdout.write("up");'));
      return r.exitCode === 0 && new TextDecoder().decode(r.stdout) === 'up';
    } catch {
      return false;
    }
  };
  if (await attempt()) return true;
  if (!podmanMachine()) {
    const m = runningMachine();
    if (m) {
      process.env['DOCEDIT_PODMAN_MACHINE'] = m;
      if (await attempt()) return true;
      delete process.env['DOCEDIT_PODMAN_MACHINE'];
    }
  }
  return false;
}
