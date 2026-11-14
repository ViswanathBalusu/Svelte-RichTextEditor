/**
 * EXP-072 criterion 2 (lane U-EXP-065-080): a compromised worker cannot reach the database, the
 * object store or any other service.
 *
 * The existing probe in sandbox.escape.test.ts tries five addresses from inside a sandbox and
 * expects all to be refused. That result means something only if the same addresses are live
 * when probed from the host, so this file adds that positive control: the PostgreSQL and S3
 * ports of the shared test environment (infra/containers/.env.example) accept a TCP connection
 * from the host, and the job's sandbox, probed on the same ports, is refused. It runs under
 * Podman with the worker image, and skips when they are not available (`sandboxReady`) or when
 * the test environment is not running (the host control fails).
 *
 * Arbitrary Lua has no socket library (sandbox.escape.test.ts, 'has no network'), and a shell
 * inside the sandbox has no route: the container runs with --network=none.
 */
import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { runInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The shared test services, as infra/containers/.env.example names them. */
const TARGETS = [
  { name: 'postgres', port: 55432 },
  { name: 's3', port: 57070 },
] as const;

/** Whether a TCP connection to 127.0.0.1:port opens within a short time. */
function hostAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const ready = await sandboxReady();
const hostUp = ready.ok ? await Promise.all(TARGETS.map((t) => hostAccepts(t.port))) : [];
const liveTargets = ready.ok && hostUp.every(Boolean);

describe.skipIf(!ready.ok)(`EXP-072 criterion 2: sandbox reach (${ready.reason})`, () => {
  it('the test services accept connections from the host (positive control)', () => {
    // A failure here means the shared test environment is not running, not that the sandbox
    // is safe; start it with infra/test-env.ps1 up before reading the probe below.
    TARGETS.forEach((t, i) => expect(hostUp[i], `${t.name} on 127.0.0.1:${t.port}`).toBe(true));
  });

  it.skipIf(!liveTargets)(
    'a job sandbox is refused on the database, the object store and the other probed addresses, while the host reaches them',
    async () => {
      const r = await runInSandbox(
        [
          'exec 2>&1',
          ...TARGETS.map(
            (t) =>
              `if bash -c "exec 3<>/dev/tcp/127.0.0.1/${t.port}" 2>/dev/null; then echo "reached ${t.name}"; else echo "refused ${t.name}"; fi`,
          ),
          'for target in 10.0.2.2/5432 172.17.0.1/5432 192.168.127.254/80; do',
          '  if bash -c "exec 3<>/dev/tcp/$target" 2>/dev/null; then echo "reached $target"; else echo "refused $target"; fi',
          'done',
          'getent hosts host.containers.internal || echo noresolve',
          'echo probe-done',
          '',
        ].join('\n'),
        { limits: { wallSeconds: 60 } },
      );
      const out = new TextDecoder().decode(r.stdout);
      expect(out).toContain('probe-done');
      expect(out).not.toContain('reached');
      expect(out.match(/refused/g)).toHaveLength(TARGETS.length + 3);
      expect(out).toContain('noresolve');
    },
  );
});
