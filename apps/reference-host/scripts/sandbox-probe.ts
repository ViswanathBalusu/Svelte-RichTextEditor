/**
 * `node apps/reference-host/scripts/sandbox-probe.ts`: starts one container of the demo stack's
 * export sandbox with exactly the arguments the export worker uses for a compile job
 * (services/export-worker, `sandboxArgs`), and from inside it tries to reach the network: a public
 * address, a name lookup, and the stack's own PostgreSQL and S3 ports (UX-091 criterion 2; BE-005
 * criterion 4; 09 §9.3). Prints JSON on standard output.
 */
import { setting, stackSettings } from './lib/stack.ts';

const s = stackSettings();
// The worker's modules read these when they load.
process.env['DOCEDIT_EXPORT_IMAGE'] = setting(s, 'DOCEDIT_EXPORT_IMAGE');
process.env['DOCEDIT_CONTAINER_CLI'] = setting(s, 'DOCEDIT_CONTAINER_CLI');
if (s['DOCEDIT_PODMAN_MACHINE'])
  process.env['DOCEDIT_PODMAN_MACHINE'] = s['DOCEDIT_PODMAN_MACHINE'];

const { sandboxReady } = await import('@docedit/export-worker/src/sandbox-ready.ts');
const { podman, sandboxArgs } = await import('@docedit/export-worker/src/index.ts');

const ready = await sandboxReady();
if (!ready.ok) {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: ready.reason })}\n`);
  process.exit(0);
}

const pg = setting(s, 'DOCEDIT_DEMO_PG_PORT');
const s3 = setting(s, 'DOCEDIT_DEMO_S3_PORT');
const tcp = (label: string, host: string, port: string) =>
  `bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null && echo "${label}=connected" || echo "${label}=refused"`;
const script = [
  'echo "interfaces=$(ls /sys/class/net | tr "\\n" " ")"',
  tcp('public', '1.1.1.1', '53'),
  tcp('postgres', '127.0.0.1', pg),
  tcp('s3', '127.0.0.1', s3),
  'getent hosts example.org >/dev/null 2>&1 && echo "dns=resolved" || echo "dns=noresolve"',
  '',
].join('\n');

const name = `docedit-demo-probe-${Date.now().toString(36)}`;
const args = sandboxArgs(name, { entrypoint: 'sh', limits: { wallSeconds: 60 } });
const r = await podman(args, {
  stdin: new TextEncoder().encode(script),
  timeoutMs: 120_000,
  maxStdoutBytes: 64 * 1024,
});
const out = new TextDecoder().decode(r.stdout);
const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? null;
process.stdout.write(
  `${JSON.stringify({
    ok: r.code === 0,
    route: ready.reason,
    image: process.env['DOCEDIT_EXPORT_IMAGE'],
    network: args.find((a) => a.startsWith('--network')) ?? null,
    interfaces: value('interfaces'),
    public: value('public'),
    postgres: value('postgres'),
    s3: value('s3'),
    dns: value('dns'),
    exitCode: r.code,
    stderr: r.stderr.slice(0, 400),
  })}\n`,
);
