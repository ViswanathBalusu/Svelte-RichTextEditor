/**
 * The Podman sandbox, for real (BE-043 criteria 1 and 6; SEC-038 criteria 1 to 4; SEC-040 criteria
 * 1 and 2; 10 §5 adversarial sandbox tests). Needs Podman and the image of
 * scripts/build-image.ts, and skips otherwise (`sandboxReady`). Three groups:
 *
 * 1. Probes: scripts run with `node` inside the real image, under the job's limits, once with
 *    Node.js's permission model as in production and once without it, to show that the container
 *    alone already holds (no network, nothing writable, no credentials, limits on time, memory and
 *    processes).
 * 2. Hostile files through the real image and the worker's whole job.
 * 3. A hostile decoder (test/hostile) that hangs, exhausts memory, crashes, floods or forges its
 *    reply, under the same limits: the job fails, the container is gone, other jobs go on.
 *
 * Wall times are written to the console for the report; they include starting the container
 * through `podman machine ssh` on the development machine.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { containerCli } from '../src/container.ts';
import { assetKeys } from '../src/keys.ts';
import { MemoryAssetObjects } from '../src/objects.ts';
import {
  IMAGE,
  podmanSandbox,
  sandboxReady,
  type PodmanSandboxOptions,
} from '../src/sandbox-podman.ts';
import { DEFAULT_CONTENT_LIMITS } from '../src/sandbox/limits.ts';
import { DOCX, GIF, JPEG, PDF, PNG, SVG } from '../src/sandbox/types.ts';
import {
  createAssetWorker,
  type AssetFailed,
  type AssetOutcome,
  type AssetReady,
} from '../src/worker.ts';
import { isSanitisedSvg } from '../src/verify.ts';
import {
  concat,
  docx,
  enc,
  gifOf,
  jpegOf,
  jpegWithSize,
  png,
  pngInflateBomb,
  pngPixelBomb,
  SVG_OK,
  svgUseBomb,
} from './fixtures.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();
const HOSTILE = 'localhost/docedit-asset-worker-hostile:dev';
const timings: Record<string, number> = {};

afterAll(() => {
  if (ready.ok) console.log(`sandbox wall times (ms, ${ready.reason}): ${JSON.stringify(timings)}`);
});

/** Runs a probe script with `node` in the real image; returns its JSON output. */
async function probe(
  script: string,
  opts: { permission: boolean; limits?: PodmanSandboxOptions['limits'] },
) {
  const flags = opts.permission ? ['--permission', '--allow-fs-read=/opt/docedit/'] : [];
  const sandbox = podmanSandbox({
    entrypoint: 'node',
    command: [...flags, '--input-type=module', '-'],
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  const started = performance.now();
  const r = await sandbox.run(enc(script));
  const ms = Math.round(performance.now() - started);
  const text = new TextDecoder().decode(r.stdout);
  let out: Record<string, unknown> = {};
  try {
    out = JSON.parse(text.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
  } catch {
    // Probes that are killed print nothing.
  }
  return { r, out, ms, text };
}

const PROBE_HEAD = `
import fs from 'node:fs';
const out = {};
const attempt = async (name, f) => { try { out[name] = await f(); } catch (e) { out[name] = 'error:' + (e.code ?? e.name); } };
`;
const PROBE_TAIL = `\nprocess.stdout.write(JSON.stringify(out) + '\\n');\n`;

describe.skipIf(!ready.ok)(`the Podman sandbox (${ready.reason})`, () => {
  describe('probes inside the real image (BE-043 criterion 1; SEC-040 criterion 1)', () => {
    it('runs as an unprivileged user with no capabilities, no new privileges and seccomp filtering', async () => {
      const { out } = await probe(
        PROBE_HEAD +
          `const s = fs.readFileSync('/proc/self/status', 'utf8');
out.uid = process.getuid(); out.gid = process.getgid();
out.capEff = /CapEff:\\s+(\\w+)/.exec(s)[1]; out.capBnd = /CapBnd:\\s+(\\w+)/.exec(s)[1];
out.noNewPrivs = /NoNewPrivs:\\s+(\\d)/.exec(s)[1]; out.seccomp = /Seccomp:\\s+(\\d)/.exec(s)[1];
out.limits = fs.readFileSync('/proc/self/limits', 'utf8').split('\\n').filter((l) => /processes|open files|file size|cpu time|core/.test(l)).map((l) => l.replace(/\\s+/g, ' ').trim());
await attempt('pidsMax', () => fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim());
await attempt('memoryMax', () => fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim());` +
          PROBE_TAIL,
        { permission: false },
      );
      console.log('identity probe', JSON.stringify(out));
      expect(out['uid']).toBe(10001);
      expect(out['gid']).toBe(10001);
      expect(out['capEff']).toBe('0000000000000000');
      expect(out['capBnd']).toBe('0000000000000000');
      expect(out['noNewPrivs']).toBe('1');
      expect(out['seccomp']).toBe('2');
      expect(out['pidsMax']).toBe('32');
      expect(out['memoryMax']).toBe(String(1024 * 1024 * 1024));
    });

    it('has no network: only loopback, no name resolution, no route out, and the services it uses are unreachable', async () => {
      const { out } = await probe(
        PROBE_HEAD +
          `import os from 'node:os'; import net from 'node:net'; import dns from 'node:dns/promises';
out.interfaces = Object.keys(os.networkInterfaces()).sort();
await attempt('dns', async () => (await dns.lookup('example.org')).address);
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: 3000 }); s.on('connect', () => { s.destroy(); r('connected'); }); s.on('error', (e) => r('error:' + e.code)); s.on('timeout', () => { s.destroy(); r('timeout'); }); });
out.internet = await tcp('1.1.1.1', 443);
out.s3 = await tcp('127.0.0.1', 57070);
out.postgres = await tcp('127.0.0.1', 55432);
out.gateway = await tcp('10.88.0.1', 57070);
await attempt('fetch', async () => (await fetch('http://example.org/')).status);` +
          PROBE_TAIL,
        { permission: false },
      );
      console.log('network probe', JSON.stringify(out));
      expect(out['interfaces']).toEqual(['lo']);
      expect(String(out['dns'])).toMatch(/^error:/);
      for (const k of ['internet', 's3', 'postgres', 'gateway'])
        expect(out[k], k).not.toBe('connected');
      expect(String(out['fetch'])).toMatch(/^error:/);
    });

    it('cannot write outside its output: the root is read-only and no path is writable', async () => {
      const { out } = await probe(
        PROBE_HEAD +
          `const paths = ['/', '/tmp', '/var/tmp', '/opt/docedit', '/opt/docedit/sandbox', '/dev', '/dev/shm', '/dev/mqueue', '/run', '/etc', '/home', '/root', '/nonexistent', '/proc/self'];
out.writes = {};
for (const p of paths) { try { fs.writeFileSync(p + '/probe-' + process.pid, 'x'); out.writes[p] = 'WRITTEN'; } catch (e) { out.writes[p] = e.code; } }
await attempt('mkdirTmp', () => { fs.mkdirSync('/tmp/probe-dir'); return 'MADE'; });
out.rwMounts = fs.readFileSync('/proc/self/mounts', 'utf8').split('\\n').filter(Boolean).map((l) => l.split(' ')).filter((f) => f[3].split(',').includes('rw')).map((f) => f[1] + ' ' + f[2]);
await attempt('shm', () => fs.readdirSync('/dev/shm'));` +
          PROBE_TAIL,
        { permission: false },
      );
      console.log('write probe', JSON.stringify(out));
      const writes = out['writes'] as Record<string, string>;
      for (const [p, v] of Object.entries(writes)) expect(v, p).not.toBe('WRITTEN');
      expect(out['mkdirTmp']).not.toBe('MADE');
      expect(String(out['shm'])).toMatch(/^error:/);
      // Only the kernel's own file systems are mounted read-write; none of them stores files.
      for (const m of out['rwMounts'] as string[]) expect(m, m).toMatch(/ (proc|devpts|mqueue)$/);
    });

    it('has no credentials: nothing secret in its environment, its files or /run/secrets', async () => {
      const { out } = await probe(
        PROBE_HEAD +
          `out.env = Object.keys(process.env).sort();
await attempt('secrets', () => fs.readdirSync('/run/secrets'));
await attempt('awsDir', () => fs.readdirSync('/nonexistent/.aws'));
await attempt('containerenv', () => fs.readFileSync('/run/.containerenv', 'utf8').length);` +
          PROBE_TAIL,
        { permission: false },
      );
      console.log('credential probe', JSON.stringify(out));
      const env = out['env'] as string[];
      for (const name of env)
        expect(name).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AWS|S3|DOCEDIT|PG/i);
      expect(env).toContain('NODE_OPTIONS');
      const secrets = out['secrets'];
      expect(Array.isArray(secrets) ? secrets : []).toEqual([]);
      expect(String(out['awsDir'])).toMatch(/^error:/);
    });

    it('refuses files, processes and workers under the permission model, as the real entry point runs', async () => {
      const { out } = await probe(
        PROBE_HEAD +
          `import cp from 'node:child_process'; import { Worker } from 'node:worker_threads';
await attempt('readPasswd', () => fs.readFileSync('/etc/passwd', 'utf8').length);
await attempt('readProc', () => fs.readFileSync('/proc/self/environ').length);
await attempt('readOwnCode', () => fs.readFileSync('/opt/docedit/sandbox/main.ts', 'utf8').length > 0);
await attempt('write', () => { fs.writeFileSync('/opt/docedit/x', 'x'); return 'WRITTEN'; });
await attempt('spawn', () => cp.spawnSync('/bin/sh', ['-c', 'echo pwned']).stdout?.toString());
await attempt('execFile', () => cp.execFileSync('/bin/true').toString());
await attempt('worker', () => { new Worker('1', { eval: true }); return 'STARTED'; });
await attempt('eval', () => eval('1 + 1'));` +
          PROBE_TAIL,
        { permission: true },
      );
      console.log('permission probe', JSON.stringify(out));
      expect(out['readOwnCode']).toBe(true);
      for (const k of ['readPasswd', 'readProc', 'write', 'spawn', 'execFile', 'worker'])
        expect(String(out[k]), k).toBe('error:ERR_ACCESS_DENIED');
    });

    it('stops a job at the wall-clock limit', async () => {
      const { r, ms } = await probe('for (;;) {}', {
        permission: true,
        limits: { wallSeconds: 10 },
      });
      timings['wall_limit_10s'] = ms;
      expect(r.exitCode).not.toBe(0);
      expect(ms).toBeLessThan(30_000);
    });

    it('stops a job at the memory limit', async () => {
      const { r, ms } = await probe(
        'const hold = []; for (;;) hold.push(Buffer.alloc(16 * 1024 * 1024, 1));',
        { permission: true, limits: { memoryMiB: 256, heapMiB: 128 } },
      );
      timings['memory_limit_256MiB'] = ms;
      expect(r.exitCode).toBe(137);
      expect(ms).toBeLessThan(30_000);
    });

    it('caps processes and threads (a fork bomb, without the permission model)', async () => {
      const { out } = await probe(
        `import cp from 'node:child_process';
let started = 0; let refused = '';
for (let i = 0; i < 200; i++) { try { const c = cp.spawn('/bin/sleep', ['20'], { stdio: 'ignore' }); await new Promise((res, rej) => { c.once('spawn', res); c.once('error', rej); }); started++; } catch (e) { refused = e.code; break; } }
process.stdout.write(JSON.stringify({ started, refused }) + '\\n');
process.exit(0);`,
        { permission: false },
      );
      console.log('fork probe', JSON.stringify(out));
      // The cgroup's process limit (32, which Node.js's own threads share) stops it.
      expect(Number(out['started'])).toBeLessThan(32);
      expect(String(out['refused'])).toBe('EAGAIN');
    });
  });

  describe('files through the real sandbox (BE-043 criteria 2 and 3; SEC-038; SEC-040 criterion 2)', () => {
    const objects = new MemoryAssetObjects();
    const events: AssetOutcome[] = [];
    const worker = createAssetWorker({
      objects,
      sandbox: podmanSandbox(),
      outcomes: {
        ready: async (r) => void events.push(r),
        failed: async (f) => void events.push(f),
      },
    });
    const tenant = randomUUID();
    const run = async (name: string, bytes: Uint8Array, mime: string): Promise<AssetOutcome> => {
      const asset = randomUUID();
      await objects.put(assetKeys.quarantine(tenant, asset), bytes, {
        contentType: 'application/octet-stream',
      });
      const started = performance.now();
      const r = await worker.handle({
        tenant,
        id: randomUUID(),
        payload: { asset, mime, size: bytes.length },
      });
      timings[name] = Math.round(performance.now() - started);
      expect(objects.objects.has(assetKeys.quarantine(tenant, asset))).toBe(false);
      return r;
    };

    it('re-encodes valid files and stores only fresh outputs (a PNG polyglot loses its payload)', async () => {
      const polyglot = concat(png(), enc('<html><script>alert(1)</script></html>'), docx());
      const p = (await run('png_polyglot', polyglot, PNG)) as AssetReady;
      expect(p.ok).toBe(true);
      const stored = objects.objects.get(p.objectKey)!.body;
      for (const s of ['<script', 'PK\x03\x04', 'tEXt', 'secret'])
        expect(Buffer.from(stored).includes(Buffer.from(s, 'latin1')), s).toBe(false);
      const g = (await run('gif', gifOf(3), GIF)) as AssetReady;
      expect(g).toMatchObject({ ok: true, frames: 3, renditions: [{ mime: PNG }] });
      const s = (await run('svg', enc(SVG_OK), SVG)) as AssetReady;
      expect(s).toMatchObject({ ok: true, renditions: [{ mime: PDF }] });
      expect(isSanitisedSvg(new TextDecoder().decode(objects.objects.get(s.objectKey)!.body))).toBe(
        true,
      );
      const d = (await run('docx', docx(), DOCX)) as AssetReady;
      expect(d).toMatchObject({ ok: true, mime: DOCX });
    });

    // Close to 1 GiB inside the Podman machine for about 13 s: opt in with DOCEDIT_ASSET_HEAVY_TESTS=1,
    // so that a shared development machine with little memory is not pushed out of memory.
    it.skipIf(process.env['DOCEDIT_ASSET_HEAVY_TESTS'] !== '1')(
      'processes a JPEG at the configured pixel limit within the memory and time limits, and fails one row more',
      async () => {
        // 5000 × 4000 is exactly maxPixels (20 000 000): the defaults must agree with each other.
        const w = 5000;
        const h = DEFAULT_CONTENT_LIMITS.maxPixels / w;
        // A photograph-like gradient with a little noise: about 3 MB at quality 90, under the byte limit.
        const px = new Uint8Array(w * h * 4);
        let seed = 7;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const i = (y * w + x) * 4;
            px[i] = ((x * 255) / w + (seed & 15)) & 255;
            px[i + 1] = ((y * 255) / h + (seed & 15)) & 255;
            px[i + 2] = (x + y) & 255;
            px[i + 3] = 255;
          }
        const atLimit = jpegOf(w, h, px);
        expect(atLimit.length).toBeLessThan(DEFAULT_CONTENT_LIMITS.imageMaxBytes);
        const r = (await run('jpeg_20MP_at_limit', atLimit, JPEG)) as AssetReady;
        expect(r).toMatchObject({ ok: true, width: w, height: h });
        const over = (await run(
          'jpeg_one_row_over',
          jpegWithSize(atLimit, w, h + 1),
          JPEG,
        )) as AssetFailed;
        expect(over).toMatchObject({ ok: false, reason: 'pixel_limit' });
      },
    );

    it('fails bombs at their limits inside the sandbox, and type confusion', async () => {
      const cases: [string, Uint8Array, string, string][] = [
        ['png_pixel_bomb', pngPixelBomb(50_000, 50_000), PNG, 'pixel_limit'],
        ['png_inflate_bomb', pngInflateBomb(256), PNG, 'malformed'],
        ['gif_frame_bomb', gifOf(501, 2, 2, { comment: false }), GIF, 'frame_limit'],
        [
          'zip_ratio_bomb',
          docx([{ name: 'word/media/zeros.bin', data: new Uint8Array(64 * 1024 * 1024) }]),
          DOCX,
          'archive_limit',
        ],
        ['svg_use_bomb', svgUseBomb(10, 10), SVG, 'drawing_limit'],
        ['html_as_png', enc('<html><script>alert(1)</script></html>'), PNG, 'type_mismatch'],
        [
          'svg_script',
          enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          SVG,
          'unsafe_content',
        ],
      ];
      const before = events.length;
      for (const [name, bytes, mime, reason] of cases) {
        const r = (await run(name, bytes, mime)) as AssetFailed;
        expect(r, name).toMatchObject({ ok: false, reason });
      }
      expect(events.slice(before).filter((e) => !e.ok)).toHaveLength(cases.length);
    });
  });

  describe('a hostile decoder under the same limits (BE-043 criterion 6; SEC-038 criterion 4)', () => {
    let built = false;
    beforeAll(async () => {
      const ctx = fileURLToPath(new URL('./hostile/', import.meta.url));
      const b = spawnSync(
        containerCli(),
        ['build', '--pull=never', '--build-arg', `BASE=${IMAGE}`, '-t', HOSTILE, ctx],
        { encoding: 'utf8', timeout: 180_000 },
      );
      built = b.status === 0;
      if (!built) console.log(`hostile image not built: ${b.stderr.slice(0, 300)}`);
    });

    // Listing needs no cgroup limits, so it goes through the plain client (its format is not ssh-safe).
    const leftovers = (): string[] => {
      const r = spawnSync(
        containerCli(),
        ['ps', '--all', '--filter', 'name=docedit-asset-', '--format', '{{.Names}}'],
        {
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      return r.stdout.split('\n').filter(Boolean);
    };

    it('fails the job and discards the sandbox when the decoder hangs, exhausts memory, crashes, floods or forges, while another job goes on', async () => {
      expect(built).toBe(true);
      const objects = new MemoryAssetObjects();
      const events: AssetOutcome[] = [];
      const outcomes = {
        ready: async (r: AssetReady) => void events.push(r),
        failed: async (f: AssetFailed) => void events.push(f),
      };
      const hostile = createAssetWorker({
        objects,
        sandbox: podmanSandbox({
          image: HOSTILE,
          limits: { wallSeconds: 10, memoryMiB: 256, heapMiB: 128, outputBytes: 8 * 1024 * 1024 },
        }),
        outcomes,
      });
      const good = createAssetWorker({ objects, sandbox: podmanSandbox(), outcomes });
      const tenant = randomUUID();
      const submit = async (w: typeof good, bytes: Uint8Array, mime: string) => {
        const asset = randomUUID();
        await objects.put(assetKeys.quarantine(tenant, asset), bytes, { contentType: 'x' });
        const started = performance.now();
        const r = await w.handle({
          tenant,
          id: randomUUID(),
          payload: { asset, mime, size: bytes.length },
        });
        return { r, ms: Math.round(performance.now() - started), asset };
      };
      const payload = (mode: string) => concat(enc(mode), png());
      // The hanging job and a good one run at the same time.
      const [hang, ok] = await Promise.all([
        submit(hostile, payload('HANG'), PNG),
        submit(good, png(), PNG),
      ]);
      timings['hostile_hang'] = hang.ms;
      timings['good_beside_hang'] = ok.ms;
      expect(hang.r).toMatchObject({ ok: false, reason: 'resource_limit', code: 'too_large' });
      expect(ok.r.ok).toBe(true);
      expect(ok.ms).toBeLessThan(hang.ms);
      // A crash ends with SIGABRT, which reaches the supervisor as a non-zero exit: the file failed.
      const others: [string, readonly string[]][] = [
        ['OOM!', ['resource_limit']],
        ['CRSH', ['decode_failed', 'resource_limit']],
        ['FLOD', ['output_limit']],
        ['FAKE', ['bad_reply']],
      ];
      for (const [mode, reasons] of others) {
        const { r, ms } = await submit(hostile, payload(mode), PNG);
        timings[`hostile_${mode}`] = ms;
        expect(r.ok, mode).toBe(false);
        expect(reasons, mode).toContain((r as AssetFailed).reason);
      }
      // Nothing of the hostile jobs was stored, every upload was deleted, and every container is gone.
      const finals = [...objects.objects.keys()].filter((k) => k.includes('/assets/'));
      expect(finals).toHaveLength(1);
      expect([...objects.objects.keys()].filter((k) => k.includes('/quarantine/'))).toEqual([]);
      expect(events.filter((e) => !e.ok)).toHaveLength(5);
      expect(leftovers()).toEqual([]);
    });
  });
});
