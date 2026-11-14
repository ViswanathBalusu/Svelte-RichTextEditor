// SEC-048 criterion 2 (lane U-SEC-033-048): a container run without privileges holds only the
// secrets it needs. The export worker's job needs none: its input is a bundle on standard input and
// its output is a tar on standard output, with no network and no credentials (09 §9.3; 10 §3.6).
//
// Every case runs through `runInSandbox` (src/sandbox.ts), so the container is started with the
// job's own arguments (`sandboxArgs`) and the job's own route (src/container.ts: the empty default
// mounts file of EXP-072, and the machine route where the remote client cannot apply cgroup limits).
// No flag is written here. The control case shows that the secret-path check sees the files the
// runtime injects when the empty default mounts file is left out.
//
// Needs Podman and the worker image (DOCEDIT_EXPORT_IMAGE); skips, with the reason, otherwise
// (`sandboxReady`).
import { describe, expect, it, vi } from 'vitest';
import { podmanCommand, run } from '../src/container.ts';
import { runInSandbox, sandboxArgs } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();

const SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE|ACCESS_KEY|SIGNING|API_KEY|DOCEDIT_PG|DOCEDIT_S3|DATABASE|DSN|AWS_|S3_)/i;

// Where a mounted secret, a cloud credential or a container engine socket would appear.
const SECRET_PATHS = [
  '/run/secrets',
  '/var/run/secrets',
  '/run/podman',
  '/var/run/docker.sock',
  '/etc/docedit',
  '/opt/docedit/keys',
  '/secrets',
  '/root/.aws',
  '/home/tex/.aws',
  '/work/.aws',
  '/work/.docker',
  '/work/.netrc',
  '/work/.ssh',
];

const LIST_SECRET_PATHS = [
  'exec 2>&1',
  `for p in ${SECRET_PATHS.join(' ')}; do`,
  '  if [ -e "$p" ]; then echo "present $p"; find "$p" -mindepth 1 2>/dev/null | head -n 5 | sed "s/^/file /"; fi',
  'done',
  'echo listing-done',
  '',
].join('\n');

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe.skipIf(!ready.ok)(
  `SEC-048 criterion 2: the export worker job holds no secret (${ready.reason})`,
  () => {
    it('its environment names no credential, key or service address', async () => {
      const r = await runInSandbox('exec 2>&1\nenv\necho env-done\n');
      const out = text(r.stdout);
      expect(r.code).toBe(0);
      expect(out).toContain('env-done');
      const names = out
        .split('\n')
        .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1])
        .filter((n): n is string => n !== undefined);
      // The control: the listing holds the variables the image and the job set.
      expect(names).toContain('PATH');
      expect(names).toContain('DOCEDIT_MAX_PAGES');
      expect(names.filter((n) => SECRET_NAME.test(n))).toEqual([]);
    });

    it('has no secret directory, engine socket or credential file', async () => {
      const r = await runInSandbox(LIST_SECRET_PATHS);
      const out = text(r.stdout);
      expect(r.code).toBe(0);
      expect(out).toContain('listing-done');
      // Not even an empty /run/secrets: the empty default mounts file keeps it out (EXP-072).
      expect(
        out.split('\n').filter((l) => l.startsWith('present ') || l.startsWith('file ')),
      ).toEqual([]);
    });

    it('runs as an unprivileged user with an empty capability set', async () => {
      const r = await runInSandbox(
        'id -u; id -g; grep -E "^Cap(Eff|Prm|Bnd):" /proc/self/status\n',
      );
      const lines = text(r.stdout).trim().split('\n');
      expect(r.code).toBe(0);
      expect(lines[0]).toBe('10001');
      expect(lines[1]).toBe('10001');
      for (const cap of ['CapEff', 'CapPrm', 'CapBnd'])
        expect(lines.find((l) => l.startsWith(`${cap}:`))).toMatch(/:\s+0{16}$/);
    });

    it('control: without the empty default mounts file the same check finds the injected files', async (ctx) => {
      // The job's own command line, routed as the job is, with only the default mounts file taken out.
      const name = `docedit-u-sec-033-048-control-${Date.now().toString(36)}`;
      const cmd = podmanCommand(sandboxArgs(name, { entrypoint: 'sh' }));
      const withMounts = cmd.args.filter((a) => !a.startsWith('--default-mounts-file='));
      if (withMounts.length === cmd.args.length) ctx.skip(); // A remote client without the machine route never passes the file.
      const r = await run(cmd.file, withMounts, {
        stdin: new TextEncoder().encode(LIST_SECRET_PATHS),
        timeoutMs: 120_000,
        maxStdoutBytes: 1024 * 1024,
      });
      const out = text(r.stdout);
      expect(out).toContain('listing-done');
      // Recorded, not required: whether the runtime injects anything depends on its mounts.conf.
      const injected = out.split('\n').filter((l) => l.startsWith('present /run/secrets'));
      console.log(
        `control (no empty default mounts file): ${injected.length ? 'host files injected at /run/secrets' : 'nothing injected'}`,
      );
      if (injected.length === 0) ctx.skip();
      expect(out).toContain('present /run/secrets');
    });
  },
);
