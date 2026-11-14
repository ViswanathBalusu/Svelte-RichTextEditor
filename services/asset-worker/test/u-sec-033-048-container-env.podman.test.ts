// SEC-048 criterion 2 (lane U-SEC-033-048): a container run without privileges holds only the
// secrets it needs. The asset worker's sandbox job needs none: the request comes in on standard
// input and the reply goes out on standard output, with no network and no credentials (10 §3.5).
//
// The probe runs through `podmanSandbox` (src/sandbox-podman.ts), so the container is started with
// the job's own arguments (`sandboxArgs`) and route (src/container.ts). Only the entry point is
// replaced: `node` reads the probe from standard input, without the permission model, so that the
// probe can read every path a decoder could. No flag is written here.
//
// Needs Podman and the image of scripts/build-image.ts; skips, with the reason, otherwise.
import { describe, expect, it, vi } from 'vitest';
import { podmanSandbox, sandboxReady } from '../src/sandbox-podman.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();

const SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE|ACCESS_KEY|SIGNING|API_KEY|DOCEDIT_PG|DOCEDIT_S3|DATABASE|DSN|AWS_|S3_)/i;

const SECRET_PATHS = [
  '/run/secrets',
  '/var/run/secrets',
  '/run/podman',
  '/var/run/docker.sock',
  '/etc/docedit',
  '/opt/docedit/keys',
  '/secrets',
  '/root/.aws',
  '/nonexistent/.aws',
  '/nonexistent/.ssh',
  '/nonexistent/.netrc',
];

const PROBE = `
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
const files = [];
const present = [];
const walk = (p, depth) => {
  let entries = [];
  try { entries = readdirSync(p); } catch { return; }
  for (const e of entries) {
    const q = p + '/' + e;
    files.push(q);
    try { if (depth < 4 && statSync(q).isDirectory()) walk(q, depth + 1); } catch {}
  }
};
for (const p of ${JSON.stringify(SECRET_PATHS)}) {
  if (!existsSync(p)) continue;
  present.push(p);
  walk(p, 0);
}
const status = readFileSync('/proc/self/status', 'utf8');
const cap = (n) => new RegExp('^' + n + ':\\\\s+([0-9a-f]+)$', 'm').exec(status)?.[1] ?? null;
console.log(JSON.stringify({
  env: Object.keys(process.env),
  present,
  files,
  uid: process.getuid(),
  gid: process.getgid(),
  capEff: cap('CapEff'),
  capPrm: cap('CapPrm'),
  capBnd: cap('CapBnd'),
}));
`;

interface ProbeOut {
  env: string[];
  present: string[];
  files: string[];
  uid: number;
  gid: number;
  capEff: string | null;
  capPrm: string | null;
  capBnd: string | null;
}

describe.skipIf(!ready.ok)(
  `SEC-048 criterion 2: the asset worker job holds no secret (${ready.reason})`,
  () => {
    it('has no credential in its environment, no secret file, and no privilege', async () => {
      const r = await podmanSandbox({
        entrypoint: 'node',
        command: ['--input-type=module', '-'],
      }).run(new TextEncoder().encode(PROBE));
      expect(r.engineError).toBeNull();
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(
        new TextDecoder().decode(r.stdout).trim().split('\n').pop() ?? '{}',
      ) as ProbeOut;
      // The control: the listing holds the variables the image and the job set.
      expect(out.env).toContain('PATH');
      expect(out.env).toContain('NODE_OPTIONS');
      expect(out.env.filter((n) => SECRET_NAME.test(n))).toEqual([]);
      // /run/secrets may exist as the job's empty read-only overlay (sandbox-podman.ts), and the
      // Debian base links /var/run to /run, so it shows under both names; no file may.
      expect(out.present.filter((p) => p !== '/run/secrets' && p !== '/var/run/secrets')).toEqual(
        [],
      );
      expect(out.files).toEqual([]);
      expect(out.uid).toBe(10001);
      expect(out.gid).toBe(10001);
      expect(out.capEff).toBe('0000000000000000');
      expect(out.capPrm).toBe('0000000000000000');
      expect(out.capBnd).toBe('0000000000000000');
    });
  },
);
