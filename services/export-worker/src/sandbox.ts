/**
 * Runs one compile in a single-use Podman sandbox (09 §9.3; 10 §3.4; spike S4; EXP-070, EXP-071).
 *
 * The bundle goes in as a tar on standard input and the allow-listed outputs come back as a tar
 * on standard output, so no host path is mounted. Each job gets a fresh container: no network,
 * read-only root (and no Podman default tmpfs on /tmp, /var/tmp, /run), one tmpfs work directory,
 * all capabilities dropped, no new privileges, a non-root user, cgroup limits on memory, CPU and
 * processes, rlimits as a second line, and a wall-clock limit enforced by the image, by Podman and
 * here. Shell escape is off and file access is paranoid inside (see the Containerfile). The empty
 * default mounts file (container.ts) keeps the host's `/run/secrets` out (EXP-072).
 *
 * The container is removed when it ends (`--rm`), whether the job finished, failed, passed a limit
 * or was cancelled: a cancelled job's signal kills it at once (EXP-070 criterion 3).
 */
import { randomBytes } from 'node:crypto';
import { killContainer, podman, type RunResult } from './container.ts';
import { readTar, writeTar } from './tar.ts';

/** 09 §9.3 item 4: the limits of every job. `wallSeconds` covers all passes of a job. */
export const LIMITS = {
  wallSeconds: 120,
  cpus: 1,
  memoryMiB: 1536,
  pids: 64,
  outputBytes: 200 * 1024 * 1024,
  workMiB: 256,
  pages: 2000,
} as const;

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

/**
 * TeX wraps log lines at `max_print_line` (79 by default), so text of the document could start a
 * physical log line and pass for an error line. The log is written without wrapping (EXP-064).
 */
export const LOG_LINE_UNWRAPPED = 1_048_576;

/** The image built from services/export-worker/Containerfile (scripts/build-image.ts). */
export const IMAGE = process.env['DOCEDIT_EXPORT_IMAGE'] ?? 'localhost/docedit-export-worker:s4';

export interface SandboxOptions {
  image?: string;
  minPasses?: number;
  maxPasses?: number;
  passTimeoutSeconds?: number;
  limits?: Partial<Limits>;
  /** SOURCE_DATE_EPOCH of the job (09 §9.4); the default is a fixed instant. */
  sourceDateEpoch?: number;
  /** Aborted when the job is cancelled: the container is killed and removed. */
  signal?: AbortSignal;
  /** Tests only: extra environment for the job. */
  env?: Readonly<Record<string, string>>;
  /** Tests only: another entry point (for example `sh`, reading a script from standard input). */
  entrypoint?: string;
  /** Tests only: arguments for the entry point. */
  command?: readonly string[];
  /** Tests only: the container name, so that a test can check it is gone afterwards. */
  name?: string;
}

export interface Pass {
  pass: number;
  rc: number;
  ms: number;
}

export interface CompileResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  outputOverflow: boolean;
  /** The job was cancelled and its container killed. */
  cancelled: boolean;
  passes: Pass[];
  converged: boolean;
  pdf: Uint8Array | null;
  log: string;
  layoutRaw: string | null;
  stderr: string;
  /** Time from starting `podman run` to its exit, container start-up included. */
  wallMs: number;
  /** Outputs of a test command (`command`), as returned on standard output. */
  stdout: Uint8Array;
  /** The container's name; the container no longer exists once this result is returned. */
  name: string;
  /** The limits and pass timeout the job ran under. */
  limits: Limits;
  passTimeoutSeconds: number;
}

const OUTPUTS = new Set(['main.pdf', 'main.log', 'main.layout', 'timings.txt']);

function resolveLimits(opts: SandboxOptions): { l: Limits; passTimeout: number } {
  const l: Limits = { ...LIMITS, ...opts.limits };
  return { l, passTimeout: opts.passTimeoutSeconds ?? Math.max(1, l.wallSeconds - 10) };
}

export function sandboxArgs(name: string, opts: SandboxOptions = {}): string[] {
  const { l, passTimeout } = resolveLimits(opts);
  const env: Record<string, string> = {
    SOURCE_DATE_EPOCH: String(opts.sourceDateEpoch ?? 1_788_000_000),
    FORCE_SOURCE_DATE: '1',
    DOCEDIT_MIN_PASSES: String(opts.minPasses ?? 2),
    DOCEDIT_MAX_PASSES: String(opts.maxPasses ?? 4),
    DOCEDIT_PASS_TIMEOUT: String(passTimeout),
    DOCEDIT_MAX_PAGES: String(l.pages),
    max_print_line: String(LOG_LINE_UNWRAPPED),
    ...opts.env,
  };
  const args = [
    'run',
    '--rm',
    '-i',
    `--name=${name}`,
    '--network=none',
    '--read-only',
    '--read-only-tmpfs=false',
    `--tmpfs=/work:rw,size=${l.workMiB}m,mode=1777,nosuid,nodev,noexec`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=10001:10001',
    // DOCEDIT_CONTAINER_CGROUPS=disabled (the WSL Podman machine, infra/test-env.ps1): the cgroup
    // flags fail there, so the job runs with rlimits only. The default keeps the cgroup limits.
    ...(process.env['DOCEDIT_CONTAINER_CGROUPS'] === 'disabled'
      ? ['--cgroups=disabled']
      : [
          `--memory=${l.memoryMiB}m`,
          `--memory-swap=${l.memoryMiB}m`,
          `--cpus=${l.cpus}`,
          `--pids-limit=${l.pids}`,
        ]),
    // Second line where cgroup limits are unavailable: rlimits apply to every process of the job.
    `--ulimit=nproc=${l.pids}:${l.pids}`,
    `--ulimit=fsize=${l.outputBytes}:${l.outputBytes}`,
    `--ulimit=cpu=${l.wallSeconds}:${l.wallSeconds}`,
    '--ulimit=nofile=256:256',
    `--timeout=${l.wallSeconds}`,
    '--log-driver=none',
    '--no-hosts',
    '--hostname=sandbox',
  ];
  for (const [k, v] of Object.entries(env)) args.push(`--env=${k}=${v}`);
  if (opts.entrypoint) args.push(`--entrypoint=${opts.entrypoint}`);
  args.push(opts.image ?? IMAGE);
  if (opts.command) args.push(...opts.command);
  return args;
}

const jobName = (prefix: string): string => `${prefix}-${randomBytes(6).toString('hex')}`;

/** Tests only: runs the sandbox with a script on standard input instead of a bundle. */
export async function runInSandbox(
  script: string,
  opts: SandboxOptions = {},
): Promise<RunResult & { name: string }> {
  const { l } = resolveLimits(opts);
  const name = opts.name ?? jobName('docedit-test');
  const r = await podman(sandboxArgs(name, { ...opts, entrypoint: opts.entrypoint ?? 'sh' }), {
    stdin: new TextEncoder().encode(script),
    timeoutMs: (l.wallSeconds + 15) * 1000,
    maxStdoutBytes: l.outputBytes,
    onKill: () => {
      void killContainer(name);
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { ...r, name };
}

function parseTimings(text: string): { passes: Pass[]; converged: boolean } {
  const passes: Pass[] = [];
  let converged = false;
  // The file is worker output and hostile: only these line shapes count, and only a few of them.
  for (const line of text.split('\n').slice(0, 64)) {
    const m = /^(\d{1,3}) (\d{1,3}) (\d{1,9})$/.exec(line.trim());
    if (m) passes.push({ pass: Number(m[1]), rc: Number(m[2]), ms: Number(m[3]) });
    else if (line.trim() === 'converged 1') converged = true;
  }
  return { passes, converged };
}

export async function compileInSandbox(
  files: Readonly<Record<string, string | Uint8Array>>,
  opts: SandboxOptions = {},
): Promise<CompileResult> {
  const { l, passTimeout } = resolveLimits(opts);
  const name = opts.name ?? jobName('docedit-job');
  const enc = new TextEncoder();
  const tar = writeTar(
    Object.entries(files).map(([n, c]) => [n, typeof c === 'string' ? enc.encode(c) : c] as const),
  );
  const r: RunResult = await podman(sandboxArgs(name, opts), {
    stdin: tar,
    timeoutMs: (l.wallSeconds + 15) * 1000,
    maxStdoutBytes: l.outputBytes + 1024 * 1024,
    onKill: () => {
      void killContainer(name);
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const out =
    opts.entrypoint || r.aborted
      ? new Map<string, Uint8Array>()
      : readTar(r.stdout, { allow: OUTPUTS, maxFileBytes: l.outputBytes });
  const dec = new TextDecoder();
  const timings = parseTimings(dec.decode(out.get('timings.txt') ?? new Uint8Array()));
  const pdf = out.get('main.pdf') ?? null;
  return {
    ok: r.code === 0 && pdf !== null && !r.timedOut && !r.stdoutOverflow && !r.aborted,
    exitCode: r.code,
    timedOut: r.timedOut,
    outputOverflow: r.stdoutOverflow,
    cancelled: r.aborted,
    passes: timings.passes,
    converged: timings.converged,
    pdf,
    log: dec.decode(out.get('main.log') ?? new Uint8Array()),
    layoutRaw: out.has('main.layout') ? dec.decode(out.get('main.layout')!) : null,
    stderr: r.stderr,
    wallMs: r.wallMs,
    stdout: opts.entrypoint ? r.stdout : new Uint8Array(),
    name,
    limits: l,
    passTimeoutSeconds: passTimeout,
  };
}
