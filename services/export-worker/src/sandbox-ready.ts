/**
 * Detects whether sandboxed compiles can run here (spike S4; EXP-070, EXP-072): Podman answers
 * `podman info`, the worker image exists, a container with the sandbox's cgroup limits starts, and
 * nothing from the host is mounted into it (Podman's default `/run/secrets`, S4 §3; the check is in
 * secrets-probe.ts). On a Windows host whose WSL Podman machine cannot apply cgroup limits through
 * the remote client, the machine route (DOCEDIT_PODMAN_MACHINE, see container.ts) is tried first.
 * Tests and measurements skip when this reports `ok: false` (unless DOCEDIT_REQUIRE_SANDBOX=1 makes
 * them fail, see `sandboxRequired`), and the worker process refuses to start.
 */
import { spawnSync } from 'node:child_process';
import { containerCli, podmanInfo, podmanMachine, type PodmanInfo } from './container.ts';
import { IMAGE, runInSandbox } from './sandbox.ts';
import { SECRETS_PROBE_SCRIPT, secretsVerdict } from './secrets-probe.ts';

export interface Readiness {
  ok: boolean;
  reason: string;
  info: PodmanInfo | null;
  machine: string | null;
}

let cached: Readiness | undefined;

/**
 * DOCEDIT_REQUIRE_SANDBOX=1: a test that needs the sandbox fails with the readiness reason instead
 * of skipping. Set it in a CI job that is meant to run the compile tests.
 */
export function sandboxRequired(): boolean {
  return process.env['DOCEDIT_REQUIRE_SANDBOX'] === '1';
}

function runningMachine(): string | null {
  const r = spawnSync(containerCli(), ['machine', 'list', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout) as Array<{ Name?: string; Running?: boolean }>;
    return list.find((m) => m.Running)?.Name?.replace(/\*$/, '') ?? null;
  } catch {
    return null;
  }
}

type Probe = { verdict: 'ok' | 'no-start' | 'host-mounts'; detail: string };

async function probeOnce(): Promise<Probe> {
  const r = await runInSandbox(
    // Strict (EXP-072): /run/secrets must be absent, or be only the job's own empty read-only
    // tmpfs (secrets-probe.ts). An empty directory from Podman's default mounts is refused.
    SECRETS_PROBE_SCRIPT,
    // 180 s: on a loaded Podman machine a `podman run` took 80 to 100 s (lane V-EXP-017-032, 2026-11-13),
    // so a 60 s probe reported no sandbox and the compile tests skipped.
    { limits: { wallSeconds: 180 } },
  );
  const out = new TextDecoder().decode(r.stdout);
  const verdict = secretsVerdict(out);
  if (r.code !== 0 || verdict === 'no-answer') {
    const err = r.stderr.trim().split('\n').at(-1) ?? '';
    return {
      verdict: 'no-start',
      detail: `exit ${r.code}${r.timedOut ? ', timed out' : ''}${err ? `: ${err}` : ''}`,
    };
  }
  const found = out.split('\n').filter((l) => /^(entry|mount|var-secrets)=/.test(l));
  return { verdict, detail: verdict === 'host-mounts' ? found.join('; ') : '' };
}

/**
 * A sandbox that does not start is probed once more: on the loaded WSL machine one start in a few
 * failed and the next succeeded with no change (review of lane U-EXP-113-123, 2026-11-13). A
 * host-mounts verdict is final.
 */
async function probe(): Promise<Probe> {
  const first = await probeOnce();
  return first.verdict === 'no-start' ? probeOnce() : first;
}

const HOST_MOUNTS =
  "Podman's default mounts put /run/secrets into the sandbox; use an empty mounts.conf or a route that passes --default-mounts-file (EXP-072)";

export async function sandboxReady(): Promise<Readiness> {
  if (cached) return cached;
  const info = podmanInfo();
  if (!info)
    return (cached = {
      ok: false,
      reason: 'podman info failed: Podman is not available',
      info,
      machine: null,
    });
  const exists = spawnSync(containerCli(), ['image', 'exists', IMAGE], {
    timeout: 120_000,
    windowsHide: true,
  });
  if (exists.status !== 0)
    return (cached = {
      ok: false,
      reason: `image ${IMAGE} not built (scripts/build-image.ts)`,
      info,
      machine: null,
    });
  // The routes to try, in order. A machine named in DOCEDIT_PODMAN_MACHINE is the only route. On a
  // remote client (Windows, macOS) the machine route goes first: it passes the empty default mounts
  // file and applies the cgroup limits, which the remote client cannot, so trying it first saves a
  // failing probe of up to two minutes. Elsewhere the direct route goes first.
  const set = podmanMachine();
  const routes: Array<string | null> = [];
  if (set) routes.push(set);
  else {
    const m = runningMachine();
    if (m && info.remote) routes.push(m, null);
    else routes.push(null, ...(m ? [m] : []));
  }
  const failures: string[] = [];
  let hostMounts = false;
  for (const route of routes) {
    if (route && !set) process.env['DOCEDIT_PODMAN_MACHINE'] = route;
    const p = await probe();
    if (p.verdict === 'ok')
      return (cached = route
        ? { ok: true, reason: set ? 'direct' : 'machine route (cgroupfs)', info, machine: route }
        : { ok: true, reason: 'direct', info, machine: null });
    if (route && !set) delete process.env['DOCEDIT_PODMAN_MACHINE'];
    if (p.verdict === 'host-mounts') hostMounts = true;
    failures.push(
      `${route ? `machine ${route}` : 'direct'}: ${p.verdict}${p.detail ? ` (${p.detail})` : ''}`,
    );
  }
  return (cached = {
    ok: false,
    reason: `${hostMounts ? HOST_MOUNTS : 'a container with the sandbox limits does not start'}; ${failures.join('; ')}`,
    info,
    machine: null,
  });
}
