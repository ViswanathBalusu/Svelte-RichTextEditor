// FRW-052 criterion 1: the signing service as a container of its own, built and run with Podman.
// Off unless DOCEDIT_SIGNING_CONTAINER=1, because the build fetches the pinned Node.js base image
// and the workspace's production dependencies:
//
//   $env:DOCEDIT_SIGNING_CONTAINER = '1'
//   pnpm exec vitest run --project node services/signing-service/test/frw-052-container.podman.test.ts
//
// What it shows: the image runs as an unprivileged user; it holds the service and the packages it
// reads and no other service, no export or LaTeX worker and no key, certificate or test helper; it
// refuses to start without the deployment's configuration; and, started with a configuration that
// has no key service, it answers from its own container: no credential is 401, the export worker's
// own valid credential is 403. What it does not show: the network (a segment with no route from the
// compile workers) is the deployment's, and no key service is behind this container.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { podmanInfo } from '../../export-worker/src/container.ts';

const run = promisify(execFile);
const enabled = process.env['DOCEDIT_SIGNING_CONTAINER'] === '1';
const cli = process.env['DOCEDIT_CONTAINER_CLI'] ?? 'podman';
const root = resolve(import.meta.dirname, '../../..');
const IMAGE = 'localhost/docedit-signing-service:test-w4';
const NAME = 'docedit-signing-test-w4';

// On a Windows or macOS host the remote Podman client has no cgroup controllers delegated (the WSL
// machine of the spikes), so `run` and `create` ask for --cgroups=disabled, as softhsm.ts does.
const noCgroups =
  process.env['DOCEDIT_CONTAINER_CGROUPS'] === 'disabled' || podmanInfo()?.remote === true;

const sh = (args: string[], timeout = 600_000) =>
  run(
    cli,
    args[0] === 'run' || args[0] === 'create'
      ? [args[0], ...(noCgroups ? ['--cgroups=disabled'] : []), ...args.slice(1)]
      : args,
    { cwd: root, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );

const config = (port: number) => `
import { createHash } from 'node:crypto';
import { JsonLinesAudit } from '/app/services/signing-service/src/audit.ts';
const h = (s) => createHash('sha256').update(s).digest('hex');
export default () => ({
  service: {
    sealing: { operatorKeyId: 'operator-key', tenantKeyIds: {} },
    keys: { get: () => undefined },
    certificates: { chainFor: async () => [] },
    timestamps: { stamp: async () => { throw new Error('no authority in this test'); } },
    validationData: () => ({ certificates: [], crls: [], ocsps: [] }),
    callers: { [h('document-secret')]: 'document-service', [h('worker-secret')]: 'export-worker' },
    allowedCaller: 'document-service',
    rateLimit: { limit: 100, windowMs: 60000 },
    audit: new JsonLinesAudit((line) => process.stdout.write(line + '\\n')),
  },
  http: { maxBodyBytes: 1000000 },
  listen: { host: '127.0.0.1', port: ${port} },
});
`;

function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

describe.skipIf(!enabled)('the signing service image (FRW-052 criterion 1; Podman)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signing-container-'));
  afterAll(async () => {
    await sh(['rm', '-f', NAME]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('builds from the Containerfile', async () => {
    await sh([
      'build',
      '-f',
      'services/signing-service/Containerfile',
      '--ignorefile',
      'services/signing-service/Containerfile.dockerignore',
      '-t',
      IMAGE,
      '.',
    ]);
    const user = (await sh(['image', 'inspect', IMAGE, '--format', '{{.Config.User}}'])).stdout;
    expect(user.trim()).toBe('node');
  }, 900_000);

  it('holds the service and nothing of the workers, and no key material', async () => {
    const inside = async (script: string) =>
      (await sh(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', script])).stdout.trim();
    expect(await inside('ls /app/services')).toBe('signing-service');
    // No worker, no other service, no export code in the image.
    expect(await inside('ls /app/packages | sort | tr "\\n" " "')).toBe(
      'authority corpus model rules',
    );
    // No private key, certificate, key store or test helper under the paths the image adds.
    const found = await inside(
      "find /app/services /app/packages /app/spec /etc/docedit -type f \\( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '*.p8' -o -name '*.cer' -o -name '*.crt' -o -name '*.jks' -o -name '*.test.ts' \\) 2>/dev/null; true",
    );
    expect(found).toBe('');
    expect(await inside('test -d /app/services/signing-service/test && echo yes || echo no')).toBe(
      'no',
    );
    expect(await inside('id -u')).not.toBe('0');
  }, 300_000);

  it('stops with a message and exit code 2 when the deployment gives no configuration', async () => {
    const out = await sh(['run', '--rm', IMAGE]).then(
      () => ({ code: 0, stderr: '' }),
      (e: { code?: number; stderr?: string }) => ({ code: e.code ?? -1, stderr: e.stderr ?? '' }),
    );
    expect(out.code).toBe(2);
    expect(out.stderr).toContain('DOCEDIT_SIGNING_CONFIG is not set; nothing is sealed');
  }, 120_000);

  it('answers from its own container: no credential is 401 and the worker credential is 403', async () => {
    // Host networking, loopback only, as the other container tests of this repository do: the
    // remote Podman client here does not forward published ports to the host.
    const port = await freePort();
    const file = join(dir, 'signing-config.mjs');
    writeFileSync(file, config(port));
    await sh([
      'create',
      '--name',
      NAME,
      '--cap-drop=all',
      '--security-opt=no-new-privileges',
      '--network=host',
      '-e',
      'DOCEDIT_SIGNING_CONFIG=/app/signing-config.mjs',
      IMAGE,
    ]);
    await sh(['cp', file, `${NAME}:/app/signing-config.mjs`]);
    await sh(['start', NAME]);
    const base = `http://127.0.0.1:${port}`;
    const end = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > end) throw new Error('the container did not answer within 30 s');
      await new Promise((r) => setTimeout(r, 300));
    }
    const hash = '0'.repeat(64);
    const request = (secret: string | null) =>
      fetch(`${base}/v1/seal`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({
          tenant: 't',
          documentId: 'd',
          seq: 1,
          pdfSha256: hash,
          compileSha256: [hash, hash],
          pdf: Buffer.from('%PDF-1.7\n').toString('base64'),
        }),
      });
    const none = await request(null);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ ok: false, code: 'unauthenticated' });
    const worker = await request('worker-secret');
    expect(worker.status).toBe(403);
    expect(await worker.json()).toMatchObject({ ok: false, code: 'wrong_caller' });
    // The refusals are in the service's own audit log, and no secret is.
    const logs = (await sh(['logs', NAME])).stdout;
    expect(logs).toContain('"event":"seal.refused"');
    expect(logs).not.toContain('worker-secret');
    expect(logs).not.toContain('document-secret');
  }, 120_000);
});
