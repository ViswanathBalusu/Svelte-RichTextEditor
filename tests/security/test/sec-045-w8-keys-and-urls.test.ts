/**
 * SEC-045 criterion 4 (lane w8, 2026-11-26): the full two-tenant scenario, and signed URLs.
 *
 * Part 1. Two tenants each run a scenario that now writes every kind of object the service keeps:
 * a document with a content replacement (checkpoints), an uploaded and checked asset, a completed
 * export job (output and compile log), a tenant font, a sealed final and the anchors of a workflow.
 * Then every key of the service's object store is listed. Each starts with `tenants/{tenant}/` of
 * the tenant that wrote it, each tenant has keys of every kind, and a key of one tenant never has
 * the prefix of the other. `TenantObjects` refuses to sign a URL for a key of another tenant.
 *
 * Part 2. The signed URL of the store (S3-compatible, the test environment of FND-010; skipped, with
 * the reason, when it is down): a URL signed for tenant A's object opens it; the same query moved to
 * the path of tenant B's object opens nothing. The signature covers the path, so the store itself
 * refuses it.
 */
import { createHash } from 'node:crypto';
import { unsandboxed } from '../../../services/asset-worker/src/index.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  S3ObjectStore,
  type S3Settings,
} from '../../../services/document-service/src/objects/s3.ts';
import {
  ForeignKeyError,
  objectKeys,
  TenantObjects,
} from '../../../services/document-service/src/objects/store.ts';
import type { JobHandler } from '../../../services/document-service/src/control-plane/jobs/runner.ts';
import { ttf } from '../../../services/document-service/test/support/font-bytes.ts';
import { settings } from '../../../services/document-service/test/support/env.ts';
import { documentWithRegions, startHarness, type Harness } from './support/harness.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SEC-045 criterion 4: the keys of a full two-tenant scenario', () => {
  let h: Harness;
  const workflowId = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c45';

  const compile: JobHandler = async (job, ctx) => {
    await ctx.report('compiling', 60);
    await h.service.assets.putExport(
      job.tenant,
      job.id,
      'output.pdf',
      Buffer.from('%PDF-1.7 test'),
      'application/pdf',
    );
    await h.service.assets.putExport(
      job.tenant,
      job.id,
      'compile.log',
      Buffer.from('log'),
      'text/plain',
    );
    return {
      output: 'output.pdf',
      pages: 1,
      layout: null,
      converged: true,
      log: 'compile.log',
      diagnostics: [],
    };
  };

  beforeAll(async () => {
    h = await startHarness('memory', {
      jobHandlers: { export: compile },
      assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
      env: { DOCEDIT_JOB_IDLE_MS: '20' },
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  /** One tenant's scenario: every kind of object, by the product's own routes where they exist. */
  async function scenario(t: Harness['a'], label: string) {
    const doc = await h.createDocument(t, documentWithRegions());
    const editor = await h.mintToken(t, `editor-${label}`, { [doc]: 'editor' });
    // A content replacement writes a checkpoint.
    const got = await h.call('GET', `/v1/documents/${doc}/content`, { token: t.apiKey });
    const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
      token: t.apiKey,
      body: documentWithRegions(),
      headers: { 'If-Match': got.headers.get('etag')! },
    });
    expect(put.status, put.text).toBe(204);
    // An asset: upload, check, ready.
    const up = await h.call('POST', `/v1/documents/${doc}/assets`, {
      token: editor,
      body: { filename: 'a.png', mime: 'image/png', size: PNG.length },
    });
    expect(up.status, up.text).toBe(201);
    const asset = up.json.asset as string;
    await h.service.assets.putQuarantined(t.id, asset, PNG);
    expect((await h.call('POST', `/v1/assets/${asset}/complete`, { token: editor })).status).toBe(
      202,
    );
    let row = await h.parts.assetRegistry.get(t.id, asset);
    for (let i = 0; i < 300 && row?.state !== 'ready' && row?.state !== 'failed'; i++) {
      await sleep(20);
      row = await h.parts.assetRegistry.get(t.id, asset);
    }
    expect(row?.state).toBe('ready');
    // An export job, run to the end.
    const made = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf', options: { profile: 'final' } },
    });
    expect(made.status, made.text).toBeLessThan(300);
    for (let i = 0; i < 300; i++) {
      const r = await h.call('GET', `/v1/exports/${made.json.id}`, { token: editor });
      if (r.json?.state === 'completed') break;
      expect(r.json?.state).not.toBe('failed');
      await sleep(20);
    }
    // A tenant font.
    const font = ttf({ family: `Brand ${label}` });
    const added = await h.call('POST', '/v1/tenant-fonts', {
      token: t.apiKey,
      body: {
        mime: 'font/ttf',
        content: Buffer.from(font).toString('base64'),
        licence: 'Brand licence, desktop and server',
        serverUse: true,
      },
    });
    expect(added.status, added.text).toBe(201);
    // A sealed final of a workflow, and the anchor of its chain head.
    await h.service.assets.putSealed(t.id, doc, workflowId, Buffer.from(`%PDF sealed ${label}`));
    await h.parts.objects.put(
      objectKeys.anchor(t.id, doc, workflowId),
      Buffer.from('{"anchor":true}'),
    );
    return { doc, fontSha: sha(font) };
  }

  it('every key written by either tenant starts with its own tenant prefix, and each tenant wrote every kind', async () => {
    const a = await scenario(h.a, 'a');
    const b = await scenario(h.b, 'b');
    const keys = await h.parts.objects.list('');
    const prefixA = objectKeys.prefix(h.a.id);
    const prefixB = objectKeys.prefix(h.b.id);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys)
      expect(key.startsWith(prefixA) || key.startsWith(prefixB), `key ${key}`).toBe(true);

    // The document of one tenant is only ever under that tenant's prefix.
    for (const key of keys) {
      if (key.includes(a.doc)) expect(key.startsWith(prefixA), key).toBe(true);
      if (key.includes(b.doc)) expect(key.startsWith(prefixB), key).toBe(true);
    }
    // Every kind of object was written, for each tenant.
    const kinds: Array<[string, (k: string) => boolean]> = [
      ['checkpoint', (k) => k.includes('/checkpoints/')],
      ['asset', (k) => k.includes('/assets/')],
      ['export', (k) => k.includes('/exports/')],
      ['font', (k) => k.includes('/fonts/')],
      ['sealed final', (k) => k.includes('/final/')],
      ['anchor', (k) => k.includes('/anchors/')],
    ];
    for (const [tenantPrefix, label] of [
      [prefixA, 'A'],
      [prefixB, 'B'],
    ] as const) {
      const mine = keys.filter((k) => k.startsWith(tenantPrefix));
      for (const [kind, is] of kinds)
        expect(mine.some(is), `tenant ${label} has a key of kind ${kind}: ${mine.join(' ')}`).toBe(
          true,
        );
    }
    // The font of one tenant is not a key of the other.
    expect(keys).toContain(`${prefixA}fonts/${a.fontSha}`);
    expect(keys).not.toContain(`${prefixB}fonts/${a.fontSha}`);
  }, 120_000);

  it("the tenant's view of the store signs no URL for a key of another tenant, and none for a traversal", async () => {
    const a = new TenantObjects(h.parts.objects, h.a.id);
    const own = `${objectKeys.prefix(h.a.id)}fonts/${'0'.repeat(64)}`;
    const foreign = `${objectKeys.prefix(h.b.id)}fonts/${'0'.repeat(64)}`;
    expect(a.signedUrl(own, Date.now() + 60_000)).toContain(encodeURIComponent('0'.repeat(64)));
    expect(() => a.signedUrl(foreign, Date.now() + 60_000)).toThrow(ForeignKeyError);
    expect(() =>
      a.signedUrl(`${objectKeys.prefix(h.a.id)}../${h.b.id}/x`, Date.now() + 60_000),
    ).toThrow(ForeignKeyError);
  });
});

const S = settings();
const s3Settings: S3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).get('tenants/probe-sec-045-w8/none');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

describe('SEC-045 criterion 4: a signed URL of the store for tenant A does not open tenant B', async () => {
  const skip = await s3Unavailable();
  if (skip) console.warn(`skipped: ${skip}`);
  const a = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c4a';
  const b = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c4b';
  const name = `${'e'.repeat(8)}-${Date.now().toString(16)}`;
  const keyA = `tenants/${a}/exports/${name}/output.pdf`;
  const keyB = `tenants/${b}/exports/${name}/output.pdf`;

  it.skipIf(skip !== null)(
    'A URL opens A object; its query on the path of B object opens nothing; B own URL opens B object',
    async () => {
      const store = new S3ObjectStore(s3Settings);
      const bytesA = Buffer.from('tenant A secret');
      const bytesB = Buffer.from('tenant B secret');
      await store.put(keyA, bytesA);
      await store.put(keyB, bytesB);
      try {
        const expiresAt = Date.now() + 60_000;
        const urlA = new URL(new TenantObjects(store, a).signedUrl(keyA, expiresAt));
        const urlB = new URL(new TenantObjects(store, b).signedUrl(keyB, expiresAt));
        const open = (u: URL | string) => fetch(u, { signal: AbortSignal.timeout(20_000) });

        const own = await open(urlA);
        expect(own.status).toBe(200);
        expect(Buffer.from(await own.arrayBuffer()).equals(bytesA)).toBe(true);

        // A's signature and expiry, on B's object path: the store refuses it.
        const moved = new URL(urlA);
        moved.pathname = moved.pathname.replace(keyA, keyB);
        expect(moved.pathname).not.toBe(urlA.pathname);
        const refused = await open(moved);
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(Buffer.from(await refused.arrayBuffer()).includes(bytesB)).toBe(false);

        // B's own URL opens B's object (the control: the refusal is not an outage).
        const ownB = await open(urlB);
        expect(ownB.status).toBe(200);
        expect(Buffer.from(await ownB.arrayBuffer()).equals(bytesB)).toBe(true);
      } finally {
        await store.delete(keyA);
        await store.delete(keyB);
      }
    },
    60_000,
  );
});
