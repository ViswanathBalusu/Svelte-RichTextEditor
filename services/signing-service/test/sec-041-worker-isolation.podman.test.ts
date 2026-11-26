// SEC-041 criteria 2 and 3 (lane w8): the signing service is a container of its own, on a network
// of its own, and the export and asset workers cannot reach it, by network policy and by credential.
// Off unless DOCEDIT_SIGNING_CONTAINER=1, like frw-052-container.podman.test.ts, whose image and
// configuration it reuses:
//
//   $env:DOCEDIT_SIGNING_CONTAINER = '1'
//   pnpm exec vitest run --project node services/signing-service/test/sec-041-worker-isolation.podman.test.ts
//
// What it shows (Podman; two user-defined networks; the signing container has no published port):
// - a probe on the signing service's own network reaches it (positive control: the probe works);
// - the export worker's image and the asset worker's image, each started on the workers' network, get
//   no connection to the signing container's address (no route between the two networks);
// - when a worker is put on the signing network by mistake, the service still refuses it: no
//   credential is 401, the export worker's own credential is 403 (wrong caller), a made-up one 401;
// - the signing container has no environment variable and no file under its working paths that holds
//   private key material, and the workers' containers have no variable that names the service or a
//   key service.
//
// What it does not show: the import and indexer workers, which are not separate images in this tree
// (they run as job handlers of the document service); the key service of the development emulator
// (SoftHSM2 in Podman, owner decision 222) is reached by `podman exec` and not over a network; and a
// production network policy, which is the deployment's.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { podmanInfo } from '../../export-worker/src/container.ts';

const run = promisify(execFile);
const enabled = process.env['DOCEDIT_SIGNING_CONTAINER'] === '1';
const cli = process.env['DOCEDIT_CONTAINER_CLI'] ?? 'podman';
const root = resolve(import.meta.dirname, '../../..');
const SIGNING_IMAGE = 'localhost/docedit-signing-service:test-w4';
const SIGNING_IMAGE_OWN = 'localhost/docedit-signing-service:test-w8';
const EXPORT_IMAGE = 'localhost/docedit-export-worker:test';
const ASSET_IMAGE = process.env['DOCEDIT_ASSET_IMAGE'] ?? 'localhost/docedit-asset-worker:w5';
const NAME = 'docedit-signing-sec041-w8';
const NET_SIGNING = 'sec041-signing-w8';
const NET_WORK = 'sec041-work-w8';
const PORT = 8443;

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

const config = () => `
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
  listen: { host: '0.0.0.0', port: ${PORT} },
});
`;

describe.skipIf(!enabled)('the workers cannot reach the signing service (SEC-041; Podman)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec041-'));
  let ip = '';
  let image = SIGNING_IMAGE;

  /** A bash script run in a worker's image, on `network`; its standard output, trimmed. */
  const probe = async (img: string, network: string, script: string): Promise<string> => {
    const r = await sh(
      ['run', '--rm', '--network', network, '--entrypoint', 'bash', img, '-c', script],
      120_000,
    ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
    return r.stdout.trim();
  };

  /** Opens a TCP connection to the signing container with a 5 s limit. */
  const connect = `if timeout 5 bash -c "exec 3<>/dev/tcp/$IP/${PORT}" 2>/dev/null; then echo connected; else echo blocked; fi`;

  /** One HTTP request to the signing container over /dev/tcp; the status line. */
  const status = (secret: string | null) => {
    const body = JSON.stringify({
      tenant: 't',
      documentId: 'd',
      seq: 1,
      pdfSha256: '0'.repeat(64),
      compileSha256: ['0'.repeat(64), '0'.repeat(64)],
      pdf: Buffer.from('%PDF-1.7\n').toString('base64'),
    });
    const auth = secret ? `Authorization: Bearer ${secret}\\r\\n` : '';
    return (
      `exec 3<>/dev/tcp/$IP/${PORT}; ` +
      `printf 'POST /v1/seal HTTP/1.1\\r\\nHost: x\\r\\nContent-Type: application/json\\r\\n${auth}Content-Length: ${body.length}\\r\\nConnection: close\\r\\n\\r\\n%s' '${body}' >&3; ` +
      `timeout 10 head -n 1 <&3`
    );
  };

  beforeAll(async () => {
    const have = await sh(['image', 'exists', SIGNING_IMAGE]).then(
      () => true,
      () => false,
    );
    if (!have) {
      image = SIGNING_IMAGE_OWN;
      await sh([
        'build',
        '-f',
        'services/signing-service/Containerfile',
        '--ignorefile',
        'services/signing-service/Containerfile.dockerignore',
        '-t',
        image,
        '.',
      ]);
    }
    for (const n of [NET_SIGNING, NET_WORK]) await sh(['network', 'create', n]);
    const file = join(dir, 'signing-config.mjs');
    writeFileSync(file, config());
    await sh([
      'create',
      '--name',
      NAME,
      '--network',
      NET_SIGNING,
      '--cap-drop=all',
      '--security-opt=no-new-privileges',
      '-e',
      'DOCEDIT_SIGNING_CONFIG=/app/signing-config.mjs',
      image,
    ]);
    await sh(['cp', file, `${NAME}:/app/signing-config.mjs`]);
    await sh(['start', NAME]);
    ip = (
      await sh([
        'inspect',
        '-f',
        `{{(index .NetworkSettings.Networks "${NET_SIGNING}").IPAddress}}`,
        NAME,
      ])
    ).stdout.trim();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // Wait until the service answers, from its own network.
    const end = Date.now() + 60_000;
    for (;;) {
      const out = await probe(EXPORT_IMAGE, NET_SIGNING, `IP=${ip}; ${status('worker-secret')}`);
      if (out.startsWith('HTTP/1.1')) break;
      if (Date.now() > end) throw new Error(`the signing container did not answer: ${out}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 900_000);

  afterAll(async () => {
    await sh(['rm', '-f', NAME]).catch(() => undefined);
    for (const n of [NET_SIGNING, NET_WORK])
      await sh(['network', 'rm', '-f', n]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('is reached from its own network (the probe works)', async () => {
    expect(await probe(EXPORT_IMAGE, NET_SIGNING, `IP=${ip}; ${connect}`)).toBe('connected');
  }, 180_000);

  it('is not reached from the network of the export worker or the asset worker: there is no route', async () => {
    expect(await probe(EXPORT_IMAGE, NET_WORK, `IP=${ip}; ${connect}`)).toBe('blocked');
    expect(await probe(ASSET_IMAGE, NET_WORK, `IP=${ip}; ${connect}`)).toBe('blocked');
  }, 180_000);

  it('refuses a worker that is on its network by mistake: no credential 401, the export worker credential 403, another 401', async () => {
    const line = async (img: string, secret: string | null) =>
      probe(img, NET_SIGNING, `IP=${ip}; ${status(secret)}`);
    expect(await line(EXPORT_IMAGE, null)).toContain(' 401 ');
    expect(await line(EXPORT_IMAGE, 'worker-secret')).toContain(' 403 ');
    expect(await line(ASSET_IMAGE, 'made-up-secret')).toContain(' 401 ');
    expect(await line(ASSET_IMAGE, 'worker-secret')).toContain(' 403 ');
    // The refusals are in the service's audit log, and no secret is.
    const logs = (await sh(['logs', NAME])).stdout;
    expect(logs).toContain('"event":"seal.refused"');
    expect(logs).not.toContain('worker-secret');
    expect(logs).not.toContain('made-up-secret');
  }, 300_000);

  it('is a deployable of its own: an image with the service and no worker, run by an unprivileged user with its own credentials', async () => {
    const inside = async (script: string) =>
      (await sh(['exec', NAME, 'sh', '-c', script])).stdout.trim();
    // The service and the packages it reads: no worker, no other service, no export code.
    expect(await inside('ls /app/services')).toBe('signing-service');
    expect(await inside('ls /app/packages | sort | tr "\n" " "')).toBe(
      'authority corpus model rules',
    );
    expect(await inside('id -u')).not.toBe('0');
    // Its credentials are the ones of its own configuration (the hashes of the callers it names);
    // the workers' images do not carry them.
    const config = await inside('cat /app/signing-config.mjs');
    expect(config).toContain('allowedCaller');
    for (const img of [EXPORT_IMAGE, ASSET_IMAGE]) {
      const found = await probe(
        img,
        NET_WORK,
        'grep -rIl -e document-secret -e worker-secret / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -3; true',
      );
      expect(found, img).toBe('');
    }
  }, 300_000);

  it('holds no private key material in its environment or under its paths, and the workers hold no name of it', async () => {
    const inside = async (script: string) =>
      (await sh(['exec', NAME, 'sh', '-c', script])).stdout.trim();
    // Environment variables and command line of the running service: nothing that is a key.
    const env = await inside('cat /proc/1/environ | tr "\\0" "\\n"');
    expect(env).not.toMatch(/PRIVATE KEY|BEGIN [A-Z ]*KEY|\bPKCS|_KEY=|SECRET=|PASSWORD=|PIN=/i);
    expect(await inside('cat /proc/1/cmdline | tr "\\0" " "')).not.toMatch(/PRIVATE KEY/);
    // The files the service reads and the configuration it was given: no private key block.
    const blocks = await inside(
      'grep -rIl -e "BEGIN PRIVATE KEY" -e "BEGIN RSA PRIVATE KEY" -e "BEGIN EC PRIVATE KEY" -e "BEGIN ENCRYPTED PRIVATE KEY" /app /etc/docedit /tmp 2>/dev/null; true',
    );
    expect(blocks).toBe('');
    // The worker images carry no variable that names the signing service or a key service.
    for (const img of [EXPORT_IMAGE, ASSET_IMAGE]) {
      const vars = await probe(img, NET_WORK, 'env');
      expect(vars, img).not.toMatch(/SIGNING|KEY_?SERVICE|HSM|PKCS11|SOFTHSM/i);
    }
  }, 180_000);
});
