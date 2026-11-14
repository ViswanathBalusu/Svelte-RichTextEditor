/**
 * Runs one job in a single-use Podman sandbox (BE-043 criteria 1 and 6; SEC-038 criterion 4;
 * SEC-040 criterion 1; 10 §3.5 "decoding happens in a sandboxed worker without network or
 * credentials"). The approach is the export worker's (09 §9.3; services/export-worker): the
 * request goes in on standard input and the reply comes back on standard output, so no host path
 * is mounted. Each job gets a fresh container from a local image (never pulled at job time):
 *
 * - no network (`--network=none`) and no IPC namespace shared or /dev/shm (`--ipc=none`);
 * - a read-only root and no writable path at all (no tmpfs);
 * - all capabilities dropped, no new privileges, the default seccomp profile, a non-root user;
 * - cgroup limits on memory (swap included), CPU and processes, and rlimits as a second line;
 * - a wall-clock limit enforced by Podman (`--timeout`) and here, which also kills the container;
 * - no environment from the supervisor except the heap size: no credentials of any kind.
 *
 * Inside, Node.js runs under its permission model (read access to its own code only, no child
 * processes, no workers, no add-ons); see the Containerfile.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { containerCli, podman, podmanMachine, runningMachine } from './container.ts';
import type { Sandbox, SandboxRun } from './sandbox-port.ts';
import { encodeFrame, REQUEST_MAGIC } from './sandbox/frame.ts';
import { contentLimits } from './sandbox/limits.ts';

/** Resource limits of one sandbox. Settings, not measurements (ADR 0043). */
export interface SandboxLimits {
  wallSeconds: number;
  memoryMiB: number;
  /** Node.js old-generation heap; decoded pixels live outside it, within `memoryMiB`. */
  heapMiB: number;
  cpus: number;
  /** Processes and threads of one container (cgroup). */
  pids: number;
  /** Processes and threads of the sandbox user across all its containers (rlimit, a second line). */
  userProcesses: number;
  openFiles: number;
  /** Largest reply, bytes. */
  outputBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  wallSeconds: 60,
  memoryMiB: 1024,
  heapMiB: 512,
  cpus: 1,
  pids: 32,
  userProcesses: 512,
  openFiles: 64,
  outputBytes: 2 * 48 * 1024 * 1024 + 64 * 1024,
});

export const IMAGE = process.env['DOCEDIT_ASSET_IMAGE'] ?? 'localhost/docedit-asset-worker:dev';

export interface PodmanSandboxOptions {
  image?: string;
  limits?: Partial<SandboxLimits>;
  /** `--userns`, for example `auto` on a rootful host with subordinate ID ranges. */
  userns?: string;
  /** Tests only: another entry point (`node`), with `command` as its arguments. */
  entrypoint?: string;
  command?: readonly string[];
}

export function sandboxLimits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  const l = { ...DEFAULT_SANDBOX_LIMITS, ...overrides };
  for (const [k, v] of Object.entries(l))
    if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v))
      throw new RangeError(`the sandbox limit ${k} must be positive`);
  return l;
}

/** The `podman run` arguments of one job. */
export function sandboxArgs(name: string, opts: PodmanSandboxOptions = {}): string[] {
  const l = sandboxLimits(opts.limits);
  const args = [
    'run',
    '--rm',
    '-i',
    `--name=${name}`,
    '--pull=never',
    '--network=none',
    '--ipc=none',
    '--read-only',
    '--read-only-tmpfs=false',
    // Podman's default mounts.conf puts host subscription data at /run/secrets; hide it under an
    // empty read-only file system.
    '--tmpfs=/run/secrets:ro,size=4k,mode=0555',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=10001:10001',
    `--memory=${l.memoryMiB}m`,
    `--memory-swap=${l.memoryMiB}m`,
    `--cpus=${l.cpus}`,
    `--pids-limit=${l.pids}`,
    `--ulimit=nproc=${l.userProcesses}:${l.userProcesses}`,
    `--ulimit=nofile=${l.openFiles}:${l.openFiles}`,
    `--ulimit=cpu=${l.wallSeconds}:${l.wallSeconds}`,
    // No path in the container is writable; this is a second line. Zero would stop crun itself,
    // which writes a status file under the job's limits before it starts the process.
    '--ulimit=fsize=1048576:1048576',
    '--ulimit=core=0:0',
    `--timeout=${l.wallSeconds}`,
    '--log-driver=none',
    '--no-hosts',
    '--hostname=sandbox',
    `--env=NODE_OPTIONS=--max-old-space-size=${l.heapMiB}`,
  ];
  if (opts.userns) args.push(`--userns=${opts.userns}`);
  if (opts.entrypoint) args.push(`--entrypoint=${opts.entrypoint}`);
  args.push(opts.image ?? IMAGE);
  if (opts.command) args.push(...opts.command);
  return args;
}

/** Podman's own failures (it could not create or start the container): not the job's content. */
const ENGINE_EXIT = new Set([125, 126, 127]);

export function podmanSandbox(opts: PodmanSandboxOptions = {}): Sandbox {
  const l = sandboxLimits(opts.limits);
  return {
    kind: 'podman',
    async run(request, runOpts = {}): Promise<SandboxRun> {
      const name = `docedit-asset-${randomBytes(6).toString('hex')}`;
      const r = await podman(sandboxArgs(name, opts), {
        stdin: request,
        timeoutMs: (l.wallSeconds + 15) * 1000,
        maxStdoutBytes: l.outputBytes,
        ...(runOpts.signal ? { signal: runOpts.signal } : {}),
        onKill: () => {
          void podman(['kill', name], { timeoutMs: 20_000, maxStdoutBytes: 4096 });
        },
      });
      // Podman ends a container stopped by --timeout with exit code 255; any failure that took the
      // whole wall-clock allowance is the time limit.
      // A run that went past its output limit was stopped for that reason, whatever its wall time
      // (a flood can take longer to stop than the limit, and that must not read as the time limit).
      const timedOut =
        r.timedOut || (!r.stdoutOverflow && r.code !== 0 && r.wallMs >= l.wallSeconds * 1000);
      const engineError =
        r.spawnError ??
        (r.code !== null && ENGINE_EXIT.has(r.code) && !timedOut
          ? r.stderr.slice(0, 300) || `exit ${r.code}`
          : null);
      return {
        exitCode: r.code,
        timedOut,
        outputOverflow: r.stdoutOverflow,
        aborted: r.aborted,
        engineError,
        stdout: r.stdout,
        stderr: r.stderr,
        wallMs: r.wallMs,
      };
    },
  };
}

export interface Readiness {
  ok: boolean;
  reason: string;
  machine: string | null;
}

let cached: Readiness | undefined;

async function probe(image: string): Promise<boolean> {
  // A one-byte "PNG": the sandbox answers with a reply frame saying the type does not match.
  const req = encodeFrame(REQUEST_MAGIC, { v: 1, declared: 'image/png', limits: contentLimits() }, [
    new Uint8Array([0]),
  ]);
  const r = await podmanSandbox({ image, limits: { wallSeconds: 60 } }).run(req);
  return r.exitCode === 0 && new TextDecoder().decode(r.stdout).includes('type_mismatch');
}

/**
 * Whether sandboxed jobs can run here: Podman answers, the image exists, and a container with the
 * sandbox's limits starts. On a host whose Podman machine cannot apply cgroup limits through the
 * remote client, the machine route is tried once (DOCEDIT_PODMAN_MACHINE, container.ts).
 */
export async function sandboxReady(image = IMAGE): Promise<Readiness> {
  if (cached) return cached;
  // A busy host can take well over 30 s to answer `podman info`: a probe that gives up reads as
  // "Podman is not available" and skips every sandbox test, so the limit is generous.
  const info = spawnSync(containerCli(), ['info', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (info.status !== 0)
    return (cached = {
      ok: false,
      reason: 'podman info failed: Podman is not available',
      machine: null,
    });
  const exists = spawnSync(containerCli(), ['image', 'exists', image], { timeout: 180_000 });
  if (exists.status !== 0)
    return (cached = {
      ok: false,
      reason: `image ${image} not built (node services/asset-worker/scripts/build-image.ts)`,
      machine: null,
    });
  if (await probe(image))
    return (cached = { ok: true, reason: 'direct', machine: podmanMachine() });
  if (!podmanMachine()) {
    const m = runningMachine();
    if (m) {
      process.env['DOCEDIT_PODMAN_MACHINE'] = m;
      if (await probe(image))
        return (cached = { ok: true, reason: 'machine route (cgroupfs)', machine: m });
      delete process.env['DOCEDIT_PODMAN_MACHINE'];
    }
  }
  return (cached = {
    ok: false,
    reason: 'a container with the sandbox limits does not start',
    machine: null,
  });
}
