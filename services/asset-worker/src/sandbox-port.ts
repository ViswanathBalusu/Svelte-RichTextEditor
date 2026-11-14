/**
 * Where a job's content checks run. Production uses the Podman sandbox (sandbox-podman.ts); tests
 * of the content rules use `unsandboxed()`, which runs the same code in the calling process with
 * no isolation at all and which the worker refuses unless it is told that this is intended.
 */
import { handleRequest } from './sandbox/process.ts';

export interface SandboxRun {
  /** Exit code of the sandbox's process; null when it was killed. */
  exitCode: number | null;
  /** The wall-clock limit was reached and the sandbox was killed. */
  timedOut: boolean;
  /** The reply was larger than allowed and the sandbox was killed. */
  outputOverflow: boolean;
  /** The caller aborted the run (the job was cancelled or its lock was lost). */
  aborted: boolean;
  /** The container engine failed before or around the job (not the job's content): try again. */
  engineError: string | null;
  stdout: Uint8Array;
  /** Bounded, for diagnostics only; never parsed. */
  stderr: string;
  wallMs: number;
}

export interface Sandbox {
  readonly kind: 'podman' | 'unsandboxed';
  run(request: Uint8Array, opts?: { signal?: AbortSignal }): Promise<SandboxRun>;
}

/** Runs the content checks in this process, without any isolation. Tests and development only. */
export function unsandboxed(): Sandbox {
  return {
    kind: 'unsandboxed',
    async run(request) {
      const started = performance.now();
      const stdout = await handleRequest(request);
      return {
        exitCode: 0,
        timedOut: false,
        outputOverflow: false,
        aborted: false,
        engineError: null,
        stdout,
        stderr: '',
        wallMs: performance.now() - started,
      };
    },
  };
}
