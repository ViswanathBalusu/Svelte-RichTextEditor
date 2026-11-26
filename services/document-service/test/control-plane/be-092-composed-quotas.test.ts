/**
 * BE-092 on a composed service (lane w5): the quota values are written through `PUT /v1/quotas`
 * (UX-078), and the storage quota (asset uploads), the export concurrency quota and the monthly
 * compile-minute budget read them at the next request. Memory storage, and PostgreSQL in Podman
 * where it is available. Test values only.
 *
 * An import starts from a Word file uploaded as an asset, so the storage quota of an import is the
 * one of that upload (ADR 0371). Not covered: the usage figures an administrator reads (UX-076 and
 * UX-078 have no usage route).
 */
import { randomUUID } from 'node:crypto';
import { unsandboxed } from '@docedit/asset-worker';
import { checkProblem } from '@docedit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCX_CONTENT_TYPE } from '../../src/control-plane/imports.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { signJws } from '../../src/control-plane/jwt.ts';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  hostKey,
  type CallResult,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** An export that holds its worker until `release` is called, then writes its output. */
function heldExport(gate: { release: () => void; promise: Promise<void> }): JobHandler {
  return async (job, ctx) => {
    await ctx.report('compiling', 50);
    await gate.promise;
    await harnesses[0]!.service.assets.putExport(
      job.tenant,
      job.id,
      'output.pdf',
      Buffer.from('%PDF-1.7 test'),
      'application/pdf',
    );
    return {
      output: 'output.pdf',
      pages: 1,
      layout: null,
      converged: true,
      log: null,
      diagnostics: [],
    };
  };
}

function gate(): { release: () => void; promise: Promise<void> } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { release, promise };
}

async function putQuotas(h: Harness, body: Record<string, number>): Promise<void> {
  const read = await h.call('GET', '/v1/quotas', { token: h.apiKey });
  const r = await h.call('PUT', '/v1/quotas', {
    token: h.apiKey,
    body,
    headers: { 'If-Match': read.headers.get('etag')! },
  });
  expect(r.status, r.text).toBe(200);
}

function expectQuotaRefusal(r: CallResult): void {
  expect(r.status).toBe(429);
  expect(r.json.code).toBe('quota_exceeded');
  expect(
    checkProblem({
      surface: 'rest',
      code: r.json.code,
      retryAfterHeader: r.headers.get('retry-after') ?? undefined,
    }),
  ).toEqual([]);
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`BE-092 storage and export quotas written through PUT /quotas (${storage})`, async () => {
    const skip = await skipReason(storage);

    it.skipIf(skip)(
      'answers an asset upload over the storage quota with quota_exceeded, counts failed uploads as nothing, and applies a raised quota to the next upload',
      async () => {
        const h = await startHarness(storage, {
          assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
          config: { jobIdleMs: 20 },
        });
        harnesses.push(h);
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const upload = (size: number) =>
          h.call('POST', `/v1/documents/${doc}/assets`, {
            token: editor,
            body: { filename: 'a.png', mime: 'image/png', size },
          });

        // No quota set: the upload is admitted. Its declared size counts from now on.
        expect((await upload(600)).status).toBe(201);
        expect(await h.parts.assetRegistry!.storedBytes(h.tenant)).toBe(600);

        await putQuotas(h, { storage: 1000 });
        expect((await upload(400)).status).toBe(201);
        const refused = await upload(1);
        expectQuotaRefusal(refused);

        await putQuotas(h, { storage: 2000 });
        expect((await upload(1000)).status).toBe(201);
        expect(await h.parts.assetRegistry!.storedBytes(h.tenant)).toBe(2000);
        expectQuotaRefusal(await upload(1));
      },
    );

    it.skipIf(skip)(
      'answers the upload of a Word file for an import over the storage quota with quota_exceeded, so no import can start from it (criterion 1, the import half)',
      async () => {
        const h = await startHarness(storage, {
          assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
          importer: async () => {
            throw new Error('no import job runs in this test');
          },
          config: { jobIdleMs: 20 },
        });
        harnesses.push(h);
        const doc = await h.createDocument({ content: documentWithRegions() });
        const editor = h.userToken({ [doc]: 'editor' });
        const upload = (size: number) =>
          h.call('POST', `/v1/documents/${doc}/assets`, {
            token: editor,
            body: { filename: 'draft.docx', mime: DOCX_CONTENT_TYPE, size },
          });
        const startImport = (asset: string) =>
          h.call('POST', `/v1/documents/${doc}/imports`, {
            token: h.apiKey,
            body: { asset, format: 'docx' },
          });

        await putQuotas(h, { storage: 1000 });
        const admitted = await upload(900);
        expect(admitted.status, admitted.text).toBe(201);
        // The Word file that would take the tenant past its quota is refused at the upload, and
        // nothing is stored for it: the import has no asset to start from.
        const refused = await upload(101);
        expectQuotaRefusal(refused);
        expect(await h.parts.assetRegistry!.storedBytes(h.tenant)).toBe(900);
        const missing = await startImport(uuid7());
        expect(missing.status).toBe(404);

        // The asset that was admitted is the one an import may use: it is not yet ready (the
        // worker has not accepted a file that was never sent), and the answer says so, not
        // `quota_exceeded`.
        const pending = await startImport(admitted.json.id as string);
        expect(pending.json.code).not.toBe('quota_exceeded');

        await putQuotas(h, { storage: 2000 });
        expect((await upload(101)).status).toBe(201);
      },
    );

    it.skipIf(skip)(
      'refuses an export over the concurrency quota instead of queueing it, leaves jobs already running alone, and admits again when one ends',
      async () => {
        const g = gate();
        const h = await startHarness(storage, {
          jobHandlers: { export: heldExport(g) },
          config: { jobIdleMs: 20, jobLeaseMs: 5000 },
        });
        harnesses.push(h);
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' });
        const request = (fields: string) =>
          h.call('POST', `/v1/documents/${doc}/exports`, {
            token: owner,
            body: { target: 'pdf', options: { fields } },
          });
        await putQuotas(h, { exportConcurrency: 1 });

        const first = await request('flatten');
        expect(first.status, first.text).toBe(202);
        const refused = await request('blank');
        expectQuotaRefusal(refused);

        // The job already in the queue is not killed, and finishes once released.
        g.release();
        for (let i = 0; i < 300; i++) {
          const r = await h.call('GET', `/v1/exports/${first.json.id}`, { token: owner });
          if (r.json?.state === 'completed') break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const done = await h.call('GET', `/v1/exports/${first.json.id}`, { token: owner });
        expect(done.json.state).toBe('completed');
        // Nothing is queued any more, so the next export is admitted.
        expect((await request('blank')).status).toBe(202);
      },
    );
  });
}

describe('BE-092 criterion 3: the export concurrency quota of one tenant leaves another alone', () => {
  it('refuses the tenant at its limit and admits a second tenant that has none', async () => {
    const g = gate();
    const h = await startHarness('memory', {
      jobHandlers: { export: heldExport(g) },
      config: { jobIdleMs: 20, jobLeaseMs: 5000 },
    });
    harnesses.push(h);
    const docA = await h.createDocument({ content: documentWithRegions() });
    const ownerA = h.userToken({ [docA]: 'owner' });
    await putQuotas(h, { exportConcurrency: 1 });

    // A second tenant on the same service, without a quota.
    const tenantB = randomUUID();
    await h.parts.registry.putTenant(tenantB, 'Second tenant');
    const key = hostKey('EdDSA');
    await h.parts.registry.addKey(tenantB, {
      kid: key.kid,
      use: 'user',
      alg: key.alg,
      jwk: key.jwk,
    });
    const api = newApiKey(tenantB);
    await h.parts.registry.addApiKey(tenantB, { id: api.id, secretHash: hashSecret(api.secret) });
    const created = await h.call('POST', '/v1/documents', {
      token: api.credential,
      body: { content: documentWithRegions() },
    });
    expect(created.status, created.text).toBe(201);
    const docB = created.json.id as string;
    const iat = Math.floor(h.now() / 1000);
    const ownerB = signJws(
      { alg: key.alg, typ: 'JWT', kid: key.kid },
      {
        iss: 'https://host.example.test',
        aud: h.serviceId,
        iat,
        exp: iat + 600,
        jti: uuid7(),
        tid: tenantB,
        sub: 'bob',
        docs: { [docB]: 'owner' },
      },
      key.privateKey,
    );

    const a1 = await h.call('POST', `/v1/documents/${docA}/exports`, {
      token: ownerA,
      body: { target: 'pdf' },
    });
    expect(a1.status, a1.text).toBe(202);
    expectQuotaRefusal(
      await h.call('POST', `/v1/documents/${docA}/exports`, {
        token: ownerA,
        body: { target: 'pdf', options: { fields: 'blank' } },
      }),
    );
    // The other tenant has no concurrency quota: both of its exports are admitted.
    for (const fields of ['flatten', 'blank']) {
      const b = await h.call('POST', `/v1/documents/${docB}/exports`, {
        token: ownerB,
        body: { target: 'pdf', options: { fields } },
      });
      expect(b.status, b.text).toBe(202);
    }
    g.release();
  });
});
