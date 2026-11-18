/**
 * FRW-052 criterion 1, as far as a test can show it: the signing service runs as its own process
 * (`node src/main.ts`, the entry of its own image), reached only over HTTP with a credential, and
 * the export worker's credential does not open it. The key, the chain and the authority belong to
 * the child (test/support/service-config.ts); this process holds none of them.
 *
 * What a test here cannot show is the deployment's trust boundary (a separate host or network
 * segment, and no route from the compile workers to the service): that is the deployment's, and the
 * story's Notes say so. The static half, that the compile side names no key service and holds no
 * credential for it, is spk-021-no-key-on-worker.test.ts.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classicPdf } from './support/classic-pdf.ts';
import { opensslAvailable } from './support/pki.ts';
import { DOCUMENT_SERVICE_SECRET, sha256Hex, WORKER_SECRET } from './support/service-world.ts';
import { startsWith } from './support/world.ts';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

describe.skipIf(!opensslAvailable())(
  'FRW-052 criterion 1: the service is a process of its own',
  () => {
    let child: ChildProcessWithoutNullStreams;
    let base = '';
    let stderr = '';
    let stdout = '';
    const input = classicPdf();
    const h = sha256Hex(input);

    const body = (): string =>
      JSON.stringify({
        tenant: 'tenant-a',
        documentId: 'doc-proc',
        seq: 1,
        pdfSha256: h,
        compileSha256: [h, h],
        pdf: Buffer.from(input).toString('base64'),
      });
    const post = (secret: string | null, text: string = body()): Promise<Response> =>
      fetch(`${base}/v1/seal`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: text,
      });

    beforeAll(async () => {
      child = spawn(process.execPath, [here('../src/main.ts')], {
        env: { ...process.env, DOCEDIT_SIGNING_CONFIG: here('./support/service-config.ts') },
        windowsHide: true,
      });
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no listening line: ${stderr}`)), 120_000);
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
          const m = /"port":(\d+)/.exec(stdout);
          if (m) {
            clearTimeout(timer);
            base = `http://127.0.0.1:${m[1]}`;
            resolve();
          }
        });
        child.on('exit', (code) => reject(new Error(`exited with ${code}: ${stderr}`)));
      });
    }, 180_000);

    afterAll(async () => {
      if (!child || child.exitCode !== null) return;
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill();
          resolve();
        }, 20_000);
        child.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }, 60_000);

    it('answers its health route and has no other route', async () => {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/v1/keys`)).status).toBe(404);
      expect((await fetch(`${base}/v1/seal`)).status).toBe(404);
    });

    it("refuses a request with no credential, a wrong one and the export worker's", async () => {
      expect((await post(null)).status).toBe(401);
      expect((await post('guess')).status).toBe(401);
      const worker = await post(WORKER_SECRET);
      expect(worker.status).toBe(403);
      expect(await worker.json()).toEqual({ ok: false, code: 'wrong_caller', retryable: false });
    });

    it('refuses a body that is not a request, and one that is too large', async () => {
      expect((await post(DOCUMENT_SERVICE_SECRET, 'not json')).status).toBe(400);
      expect((await post(DOCUMENT_SERVICE_SECRET, JSON.stringify({ tenant: 1 }))).status).toBe(400);
      expect((await post(DOCUMENT_SERVICE_SECRET, 'x'.repeat(1_000_001))).status).toBe(413);
    });

    it('seals for the document service and returns the sealed bytes with their hash', async () => {
      const res = await post(DOCUMENT_SERVICE_SECRET);
      expect(res.status).toBe(200);
      const out = (await res.json()) as {
        ok: true;
        pdf: string;
        sealedSha256: string;
        profile: string;
        timestamped: boolean;
        timestampTime: string;
        keyOwner: string;
      };
      const pdf = new Uint8Array(Buffer.from(out.pdf, 'base64'));
      expect(startsWith(pdf, input)).toBe(true);
      expect(out.sealedSha256).toBe(sha256Hex(pdf));
      expect(out).toMatchObject({ profile: 'B-LT', timestamped: true, keyOwner: 'operator' });
      expect(Number.isNaN(Date.parse(out.timestampTime))).toBe(false);
    }, 120_000);

    it('writes no secret, key or document byte to its output', () => {
      const all = `${stdout}${stderr}`;
      expect(all).not.toContain(DOCUMENT_SERVICE_SECRET);
      expect(all).not.toContain(WORKER_SECRET);
      expect(all).not.toContain('PRIVATE KEY');
      expect(all).not.toContain(Buffer.from(input).toString('base64').slice(0, 40));
    });
  },
);
