/**
 * The container command line (spike S4; EXP-070, EXP-072). The worker calls Podman, never Docker.
 * The binary can be overridden with DOCEDIT_CONTAINER_CLI (default `podman`).
 *
 * DOCEDIT_PODMAN_MACHINE: on a Windows or macOS host, the name of a Podman machine to run
 * `podman --cgroup-manager=cgroupfs ...` inside, through `podman machine ssh`. This is a
 * development route only: on the WSL machine of the spike, the default systemd cgroup manager
 * places containers where no cgroup controller is delegated, so `--memory`, `--cpus` and
 * `--pids-limit` fail, and the remote client cannot pass `--cgroup-manager`. Because ssh joins
 * the arguments into one shell command line, every argument is checked against a strict pattern
 * and the call is refused otherwise.
 *
 * Default mounts (EXP-072): Podman's default `mounts.conf` adds the host's `/run/secrets` to every
 * container (S4 §3). Every `run` therefore names an empty default mounts file with the global flag
 * `--default-mounts-file` (DOCEDIT_DEFAULT_MOUNTS_FILE, default `/dev/null`) wherever Podman runs
 * locally or on the machine route. The Windows and macOS remote clients refuse that flag; on them
 * the sandbox readiness check (sandbox-ready.ts) refuses a sandbox in which `/run/secrets` exists.
 */
import { spawn, spawnSync } from 'node:child_process';

export function containerCli(): string {
  return process.env['DOCEDIT_CONTAINER_CLI'] || 'podman';
}

export function podmanMachine(): string | null {
  const m = process.env['DOCEDIT_PODMAN_MACHINE'];
  return m && /^[A-Za-z0-9_.-]+$/.test(m) ? m : null;
}

const SSH_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** The empty default mounts file of every sandbox run (EXP-072). */
export function defaultMountsFile(): string {
  const f = process.env['DOCEDIT_DEFAULT_MOUNTS_FILE'];
  return f && SSH_SAFE.test(f) ? f : '/dev/null';
}

/**
 * Global flags for `podman run` on this route: the empty default mounts file, except on a remote
 * client (Windows or macOS without the machine route), which does not accept the flag.
 */
function runGlobals(machine: string | null): string[] {
  if (machine) return [`--default-mounts-file=${defaultMountsFile()}`];
  const info = podmanInfo();
  return info && !info.remote ? [`--default-mounts-file=${defaultMountsFile()}`] : [];
}

/**
 * The program and arguments that run `podman <args>` in the configured way. `direct` skips the
 * machine route (for tools such as the validator, whose arguments are not ssh-safe).
 */
export function podmanCommand(
  argv: readonly string[],
  direct = false,
): { file: string; args: string[] } {
  const machine = direct ? null : podmanMachine();
  // DOCEDIT_CONTAINER_CGROUPS=disabled: every `run` takes --cgroups=disabled (the WSL machine has no
  // cgroup controllers delegated; see sandbox.ts for the rlimits that stay in force).
  const args: readonly string[] =
    argv[0] === 'run' &&
    !direct &&
    process.env['DOCEDIT_CONTAINER_CGROUPS'] === 'disabled' &&
    !argv.includes('--cgroups=disabled')
      ? ['run', '--cgroups=disabled', ...argv.slice(1)]
      : argv;
  const globals = args[0] === 'run' && !direct ? runGlobals(machine) : [];
  if (!machine) return { file: containerCli(), args: [...globals, ...args] };
  for (const a of args)
    if (!SSH_SAFE.test(a)) throw new Error(`refusing to pass an argument through ssh: ${a}`);
  return {
    file: containerCli(),
    args: ['machine', 'ssh', machine, 'podman', '--cgroup-manager=cgroupfs', ...globals, ...args],
  };
}

export interface PodmanInfo {
  version: string;
  rootless: boolean;
  /** The client talks to a Podman service elsewhere (Windows and macOS machines). */
  remote: boolean;
  cgroupManager: string;
  cgroupVersion: string;
  ociRuntime: string;
  os: string;
  kernel: string;
  cpus: number;
  memTotal: number;
}

let cached: PodmanInfo | null | undefined;

/** `podman info`, or null when Podman is not available (tests then skip). */
export function podmanInfo(): PodmanInfo | null {
  if (cached !== undefined) return cached;
  try {
    // 120 s: on a loaded Podman machine `podman info` took about 43 s (U-EXP-081-096, 2026-11-13).
    const r = spawnSync(containerCli(), ['info', '--format', 'json'], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return (cached = null);
    const j = JSON.parse(r.stdout) as {
      host?: {
        security?: { rootless?: boolean };
        serviceIsRemote?: boolean;
        cgroupManager?: string;
        cgroupVersion?: string;
        ociRuntime?: { name?: string; version?: string };
        os?: string;
        kernel?: string;
        cpus?: number;
        memTotal?: number;
      };
      version?: { Version?: string };
    };
    cached = {
      version: j.version?.Version ?? 'unknown',
      rootless: j.host?.security?.rootless ?? false,
      remote: j.host?.serviceIsRemote ?? false,
      cgroupManager: j.host?.cgroupManager ?? 'unknown',
      cgroupVersion: j.host?.cgroupVersion ?? 'unknown',
      ociRuntime:
        `${j.host?.ociRuntime?.name ?? '?'} ${(j.host?.ociRuntime?.version ?? '').split('\n')[0]}`.trim(),
      os: j.host?.os ?? 'unknown',
      kernel: j.host?.kernel ?? 'unknown',
      cpus: j.host?.cpus ?? 0,
      memTotal: j.host?.memTotal ?? 0,
    };
    return cached;
  } catch {
    return (cached = null);
  }
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: string;
  /** Standard output went past its limit and the process was killed. */
  stdoutOverflow: boolean;
  /** The wall-clock limit was reached and the process was killed. */
  timedOut: boolean;
  /** The caller's signal was aborted (a cancelled job) and the process was killed. */
  aborted: boolean;
  wallMs: number;
}

export interface RunOptions {
  stdin?: Uint8Array;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes?: number;
  /** Called after a timeout, an overflow or an abort, to stop the container itself. */
  onKill?: () => void;
  /** Aborting it kills the process (and, through `onKill`, the container). */
  signal?: AbortSignal;
}

/** Runs a program with bounded output and a wall-clock limit. Output is treated as hostile. */
export function run(file: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    const maxErr = opts.maxStderrBytes ?? 64 * 1024;
    let stdoutOverflow = false;
    let timedOut = false;
    let aborted = false;
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      opts.onKill?.();
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      if (stdoutOverflow) return;
      size += c.length;
      if (size > opts.maxStdoutBytes) {
        stdoutOverflow = true;
        chunks.length = 0;
        kill();
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < maxErr) err += c.toString('utf8').slice(0, maxErr - err.length);
    });
    child.on('error', (e) => {
      err += String(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        stdout: new Uint8Array(Buffer.concat(chunks)),
        stderr: err,
        stdoutOverflow,
        timedOut,
        aborted,
        wallMs: performance.now() - started,
      });
    });
    child.stdin.on('error', () => {});
    if (opts.stdin) child.stdin.end(Buffer.from(opts.stdin));
    else child.stdin.end();
  });
}

/** Runs `podman <args>` the configured way. */
export function podman(
  args: readonly string[],
  opts: RunOptions,
  direct = false,
): Promise<RunResult> {
  const cmd = podmanCommand(args, direct);
  return run(cmd.file, cmd.args, opts);
}

/** Whether a container of that name exists (EXP-070: a finished job leaves none behind). */
export async function containerExists(name: string): Promise<boolean> {
  const r = await podman(['container', 'exists', name], {
    timeoutMs: 30_000,
    maxStdoutBytes: 4096,
  });
  return r.code === 0;
}

/**
 * Stops a container at once; its `--rm` then removes it. 120 s, like the other Podman calls: on a
 * loaded Podman machine a 20 s kill gave up and left a cancelled container running (EXP-004
 * criterion 4, lane U-EXP-001-016, stabilisation round 6, 2026-11-14).
 */
export function killContainer(name: string): Promise<RunResult> {
  return podman(['kill', name], { timeoutMs: 120_000, maxStdoutBytes: 4096 });
}

const imageIds = new Map<string, string>();
const imageDigests = new Map<string, string>();

/**
 * The manifest digest (`sha256:...`) of a local image: the value a registry pins and an
 * orchestrator pulls by. It is not the image identifier above (that is the digest of the
 * configuration). Recorded in `manifest.json` of every bundle and in every result manifest
 * (EXP-073 criterion 2; EXP-076 criterion 4). Null when the image has none (an image that was never
 * given a manifest) or when it cannot be read; only a value that was read is kept.
 */
export async function imageDigest(image: string): Promise<string | null> {
  const known = imageDigests.get(image);
  if (known !== undefined) return known;
  const r = await podman(
    ['image', 'inspect', '--format', '{{.Digest}}', image],
    { timeoutMs: 120_000, maxStdoutBytes: 4096 },
    true,
  );
  const value = new TextDecoder().decode(r.stdout).trim();
  if (r.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(value)) return null;
  imageDigests.set(image, value);
  return value;
}

/**
 * The identifier (`sha256:...` of the configuration) of a local image, recorded in every result
 * manifest (EXP-076; 09 §9.4). Null when it cannot be read. Only a value that was read is kept:
 * a lookup that failed or timed out is tried again by the next job, not remembered as null.
 */
export async function imageId(image: string): Promise<string | null> {
  const known = imageIds.get(image);
  if (known !== undefined) return known;
  // Direct: inspecting needs no cgroup limits, and the format template is not ssh-safe.
  // 120 s, like `podman info`: on a loaded Podman machine a 30 s inspect timed out (EXP-076 test,
  // stabilisation round 3, 2026-11-14), and the job's manifest then recorded no image ID.
  const r = await podman(
    ['image', 'inspect', '--format', '{{.Id}}', image],
    { timeoutMs: 120_000, maxStdoutBytes: 4096 },
    true,
  );
  const id = new TextDecoder().decode(r.stdout).trim();
  if (r.code !== 0 || !/^(sha256:)?[0-9a-f]{64}$/.test(id)) return null;
  const value = id.replace(/^(?!sha256:)/, 'sha256:');
  imageIds.set(image, value);
  return value;
}
