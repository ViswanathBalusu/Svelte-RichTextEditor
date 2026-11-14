// Fork over the control plane on both storages (HIS-022; 08 §8; 05 §6.2). The memory cases are in
// src/control-plane/history-routes.test.ts; this file runs the same refusals and copies against
// PostgreSQL (FND-010 integration environment: pwsh -NoProfile -File infra/test-env.ps1 up). Each
// PostgreSQL harness creates its own database and drops it on close.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const unavailable = await skipReason('postgres');
if (unavailable) console.warn(`skipped: ${unavailable}`);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe.skipIf(storage === 'postgres' && unavailable !== null)(
    `fork a version (HIS-022, ${storage})`,
    () => {
      let h: Harness;

      beforeAll(async () => {
        h = await startHarness(storage, {});
      });
      afterAll(async () => {
        await h?.close();
      });

      /** A source document with one viewer grant on the legal region, read by the service credential. */
      async function source(): Promise<string> {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'HIS-022 source',
        });
        const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
        const p = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.apiKey,
          headers: { 'If-Match': g.headers.get('etag')! },
          body: { grants: [{ region: LEGAL, principal: 'user:alice', role: 'viewer' }] },
        });
        expect(p.status).toBe(200);
        return doc;
      }

      const fork = (doc: string, body: Record<string, unknown>, token = h.apiKey) =>
        h.call('POST', `/v1/documents/${doc}/fork`, {
          token,
          headers: { 'Idempotency-Key': randomUUID() },
          body,
        });

      it('copies the content at atSeq 0 into a document with its own log and incarnation', async () => {
        const doc = await source();
        const before = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const r = await fork(doc, { atSeq: 0 });
        expect(r.status).toBe(201);
        const copy = r.json.id as string;
        expect(copy).not.toBe(doc);
        const content = await h.call('GET', `/v1/documents/${copy}/content`, { token: h.apiKey });
        expect(content.status).toBe(200);
        expect(content.json.doc).toEqual(before.json.doc);
        expect(content.json.seq).toBe(0);
        expect(content.json.incarnation).not.toBe(before.json.incarnation);
      });

      it('copies grants only when the request says so (criterion 3)', async () => {
        const doc = await source();
        const plain = (await fork(doc, { atSeq: 0 })).json.id as string;
        const withGrants = (await fork(doc, { atSeq: 0, copyGrants: true })).json.id as string;
        const grantsOf = async (id: string) =>
          (await h.call('GET', `/v1/documents/${id}/grants`, { token: h.apiKey })).json
            .grants as Array<{
            region: string;
            role: string;
          }>;
        expect(await grantsOf(plain)).toEqual([]);
        expect((await grantsOf(withGrants)).map((g) => [g.region, g.role])).toEqual([
          [LEGAL, 'viewer'],
        ]);
      });

      it('leaves the original unchanged and gives no merge back (criterion 6)', async () => {
        const doc = await source();
        const beforeMeta = await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey });
        const beforeContent = await h.call('GET', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
        });
        const beforeGrants = await h.call('GET', `/v1/documents/${doc}/grants`, {
          token: h.apiKey,
        });
        expect((await fork(doc, { atSeq: 0, copyGrants: true })).status).toBe(201);
        const afterMeta = await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey });
        const afterContent = await h.call('GET', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
        });
        const afterGrants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
        expect(afterMeta.headers.get('etag')).toBe(beforeMeta.headers.get('etag'));
        expect(afterContent.json).toEqual(beforeContent.json);
        expect(afterGrants.json).toEqual(beforeGrants.json);
      });

      it('refuses a user credential as forbidden (criterion 1, service-credential operation)', async () => {
        const doc = await source();
        expect((await fork(doc, { atSeq: 0 }, h.userToken({ [doc]: 'owner' }))).status).toBe(403);
      });

      it('refuses a seq above the head as not_found', async () => {
        const doc = await source();
        expect((await fork(doc, { atSeq: 1 })).status).toBe(404);
      });
    },
  );
}
