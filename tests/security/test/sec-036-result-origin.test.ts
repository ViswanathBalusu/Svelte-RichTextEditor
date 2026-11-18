/**
 * SEC-036 criterion 6 (lane w8): the result files of an export job are served from the asset origin,
 * with fixed content types and `nosniff`, and not from presigned object-store URLs (owner decision
 * 66 of 2026-11-15; 10 §3.4, §3.5).
 *
 * The real service runs in process with in-memory storage and an asset origin set. The job is created
 * through `POST /v1/documents/{id}/exports`, claimed and completed on the queue the way a worker does,
 * and read through `GET /v1/exports/{jid}`. The origin is the real handler of services/asset-worker
 * (`startAssetOrigin`) over the same object store, on an ephemeral port, and every result URL the
 * route returns is fetched over HTTP. The worker's output is hostile: the content type it stored
 * with the file is `text/html`, and the log holds markup.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  configFromEnv,
  hashSecret,
  memoryParts,
  newApiKey,
  startService,
  type Service,
} from '@docedit/document-service';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { startAssetOrigin, type RunningOrigin } from '../../../services/asset-worker/src/origin.ts';
import {
  signExportUrl,
  verifyAssetUrl,
  verifyExportUrl,
  type AssetUrlKeys,
} from '../../../services/asset-worker/src/signing.ts';
import { documentWithRegions } from './support/harness.ts';
import { keyPair, signJws } from './support/jws.ts';

const HOSTILE_LOG = '<script>alert(document.domain)</script>\n! Package hostile Error.';
const PDF_BYTES = Buffer.from('%PDF-1.7 result');
const LAYOUT_BYTES = Buffer.from('{"pages":[]}');

const secret = randomBytes(32);
const keys: AssetUrlKeys = { current: { id: 'k1', secret } };

let service: Service | null = null;
let origin: RunningOrigin | null = null;
let clock = Date.now();
afterEach(async () => {
  await service?.close();
  await origin?.close();
  service = null;
  origin = null;
  clock = Date.now();
});

async function rig() {
  const parts = memoryParts();
  origin = await startAssetOrigin({
    objects: { get: (key) => parts.objects.get(key) },
    keys,
    now: () => clock,
  });
  service = await startService({
    config: {
      ...configFromEnv({}),
      port: 0,
      workers: 1,
      assetOrigin: origin.url,
      assetUrlKey: `k1:${secret.toString('base64')}`,
    },
    parts,
  });
  const svc = service;
  const tenant = randomUUID();
  await parts.registry.putTenant(tenant, 'Test tenant');
  const host = keyPair('EdDSA');
  await parts.registry.addKey(tenant, {
    kid: `host-${tenant}`,
    use: 'user',
    alg: 'EdDSA',
    jwk: host.jwk,
  });
  const api = newApiKey(tenant);
  await parts.registry.addApiKey(tenant, { id: api.id, secretHash: hashSecret(api.secret) });
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${svc.url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };
  const token = (sub: string, doc: string, role: string): string => {
    const iat = Math.floor(Date.now() / 1000);
    return signJws(
      { alg: host.alg, typ: 'JWT', kid: `host-${tenant}` },
      {
        iss: 'https://host.example.test',
        aud: svc.url,
        iat,
        exp: iat + 600,
        jti: uuid7(),
        tid: tenant,
        sub,
        docs: { [doc]: role },
      },
      { key: host.privateKey },
    );
  };
  const created = await call('POST', '/v1/documents', api.credential, {
    content: documentWithRegions(),
  });
  expect(created.status).toBe(201);
  const doc = created.json.id as string;
  const editor = token('eddie', doc, 'editor');
  const job = await call('POST', `/v1/documents/${doc}/exports`, editor, { target: 'pdf' });
  expect(job.status).toBe(202);
  const jobId = job.json.id as string;
  // The worker's side: files under the job's prefix, stored with a content type that is not safe.
  const claimed = await parts.queue.claim(['export'], 'test-worker', 60_000);
  expect(claimed?.id).toBe(jobId);
  for (const [name, bytes] of [
    ['output.pdf', PDF_BYTES],
    ['compile.log', Buffer.from(HOSTILE_LOG)],
    ['layout.json', LAYOUT_BYTES],
  ] as const)
    await svc.assets.putExport(tenant, jobId, name, bytes, 'text/html');
  const stored = await parts.queue.complete({ tenant, id: jobId }, 'test-worker', {
    output: 'output.pdf',
    pages: 1,
    layout: 'layout.json',
    converged: true,
    log: 'compile.log',
    diagnostics: [],
  });
  expect(stored).toBeTruthy();
  const read = await call('GET', `/v1/exports/${jobId}`, editor);
  expect(read.status, read.text).toBe(200);
  return { tenant, jobId, result: read.json.result as Record<string, string>, origin: origin! };
}

describe('SEC-036 criterion 6: result files come from the asset origin, with fixed types and nosniff', () => {
  it('names the asset origin in every result URL, not the object store', async () => {
    const r = await rig();
    for (const name of ['url', 'layout', 'log'] as const) {
      const url = new URL(r.result[name]!);
      expect(url.origin, name).toBe(new URL(r.origin.url).origin);
      expect(url.pathname.startsWith(`/e/${r.tenant}/${r.jobId}/`), name).toBe(true);
      expect(url.search).toMatch(/^\?exp=\d+&kid=k1&sig=[A-Za-z0-9_-]{43}$/);
    }
    // Nothing of the store's own address (a bucket, a key prefix or a store signature) is in the answer.
    expect(JSON.stringify(r.result)).not.toMatch(/memory:|X-Amz|\/tenants\//);
  });

  it('serves each file with the fixed content type of its kind, nosniff, a sandbox and as a download', async () => {
    const r = await rig();
    const cases = [
      ['url', 'application/pdf', PDF_BYTES.toString()],
      ['layout', 'application/json', LAYOUT_BYTES.toString()],
      ['log', 'text/plain; charset=utf-8', HOSTILE_LOG],
    ] as const;
    for (const [name, type, body] of cases) {
      const res = await fetch(r.result[name]!);
      expect(res.status, name).toBe(200);
      // The type the worker stored (`text/html`) is never the type served.
      expect(res.headers.get('content-type'), name).toBe(type);
      expect(res.headers.get('x-content-type-options'), name).toBe('nosniff');
      expect(res.headers.get('content-security-policy'), name).toContain('sandbox');
      expect(res.headers.get('content-security-policy'), name).toContain("default-src 'none'");
      expect(res.headers.get('content-disposition'), name).toMatch(/^attachment; filename="/);
      expect(res.headers.get('cache-control'), name).toBe('private, no-store');
      expect(res.headers.get('referrer-policy'), name).toBe('no-referrer');
      // The element reads the layout and the viewer the PDF with a cross-origin fetch.
      expect(res.headers.get('access-control-allow-origin'), name).toBe('*');
      expect(await res.text(), name).toBe(body);
    }
    // HEAD answers with the same headers and no body.
    const head = await fetch(r.result['url']!, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('application/pdf');
    expect(await head.text()).toBe('');
  });

  it('refuses a changed, expired, foreign or unlisted result URL, and any other method', async () => {
    const r = await rig();
    const good = new URL(r.result['url']!);
    const refused = async (url: string, status: number, init?: RequestInit) => {
      const res = await fetch(url, init);
      expect(res.status, url).toBe(status);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).not.toContain('%PDF');
    };
    // Another file under the same signature, another job, another tenant, and a changed signature.
    await refused(`${good.origin}/e/${r.tenant}/${r.jobId}/compile.log${good.search}`, 403);
    await refused(`${good.origin}/e/${r.tenant}/${randomUUID()}/output.pdf${good.search}`, 403);
    await refused(`${good.origin}/e/${randomUUID()}/${r.jobId}/output.pdf${good.search}`, 403);
    await refused(`${good.href.slice(0, -2)}AA`, 403);
    // An extra query member, and no query at all.
    await refused(`${good.href}&x=1`, 403);
    await refused(`${good.origin}${good.pathname}`, 403);
    // A name with no served kind has no URL, and the origin answers a missing route for one.
    await refused(`${good.origin}/e/${r.tenant}/${r.jobId}/source.exe${good.search}`, 404);
    await refused(`${good.origin}/e/${r.tenant}/${r.jobId}/..%2Foutput.pdf${good.search}`, 404);
    await refused(good.href, 405, { method: 'POST' });
    // Past its expiry (the origin's clock moves on).
    clock += 3_600_000;
    await refused(good.href, 403);
  });

  it('signs only a listed kind, binds the URL to tenant, job and name, and is no asset URL', () => {
    const tenant = randomUUID();
    const job = randomUUID();
    const url = signExportUrl({
      origin: 'https://assets.example.test',
      tenant,
      job,
      name: 'output.pdf',
      expiresAt: Date.now() + 60_000,
      keys,
    });
    const path = url.slice('https://assets.example.test'.length);
    const ok = verifyExportUrl(path, keys, Date.now());
    expect(ok).toMatchObject({ ok: true, tenant, job, name: 'output.pdf' });
    // The asset check does not accept a result URL, and the result check does not take an asset's.
    expect(verifyAssetUrl(path, keys, Date.now())).toEqual({ ok: false, reason: 'not_found' });
    for (const name of ['output.exe', 'output', '.pdf', 'a/b.pdf', 'output.pdf.exe'])
      expect(() =>
        signExportUrl({
          origin: 'https://assets.example.test',
          tenant,
          job,
          name,
          expiresAt: Date.now() + 60_000,
          keys,
        }),
      ).toThrow(RangeError);
    // A key that is not the signing key does not verify.
    const other: AssetUrlKeys = { current: { id: 'k1', secret: randomBytes(32) } };
    expect(verifyExportUrl(path, other, Date.now())).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
