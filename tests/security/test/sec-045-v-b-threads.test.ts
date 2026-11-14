/**
 * SEC-045 criterion 1, the thread and comment routes (lane V-SEC-033-048, round 7): tenant A's
 * service credential and a user token of tenant A are called on the routes that take a thread or
 * comment identifier (`GET|PATCH|DELETE /threads/{tid}`, `POST /threads/{tid}/comments`,
 * `PATCH|DELETE /comments/{cid}`) with tenant B's identifiers, and on the export list of B's
 * document. Each call is refused with 401, 403 or 404 and no body carries tenant B's canary text.
 * Tenant B still reads its own thread afterwards. Runs on memory and on PostgreSQL.
 *
 * Not covered here: the webhook routes (`/webhooks/{id}` is not offered by the default harness, which
 * keeps no webhook store), the font routes and the legal-hold routes (not offered by the default
 * harness either), so criterion 1 stays unticked for those.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const CANARY_B_THREAD = 'V-SEC-033-048-TENANT-B-THREAD-BODY';
const CANARY_B_REPLY = 'V-SEC-033-048-TENANT-B-REPLY-BODY';
const OWNER_SUB = 'v-sec-045-threads-owner-b';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection (SEC harness)
  describe(`SEC-045 criterion 1, thread and comment identifier routes (${storage})`, () => {
    let h: Harness;
    let docB: string;
    let docA: string;
    let tidB: string | null = null;
    let cidB: string | null = null;
    let bOwnerToken: string;
    let aOwnerToken: string;
    const t = () => (skip ? it.skip : it);

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      docB = await h.createDocument(h.b, documentWithRegions());
      docA = await h.createDocument(h.a, documentWithRegions());
      bOwnerToken = await h.mintToken(h.b, OWNER_SUB, { [docB]: 'owner' });
      aOwnerToken = await h.mintToken(h.a, OWNER_SUB, { [docA]: 'owner' });
      // A thread of tenant B with a reply, so that A has real thread and comment identifiers to try.
      const thread = await h.call('POST', `/v1/documents/${docB}/threads`, {
        token: bOwnerToken,
        body: { target: { block: 'pIntro0000000001' }, comment: { body: CANARY_B_THREAD } },
      });
      tidB = thread.status === 201 ? ((thread.json.id as string) ?? null) : null;
      if (tidB) {
        const reply = await h.call('POST', `/v1/threads/${tidB}/comments`, {
          token: bOwnerToken,
          body: { body: CANARY_B_REPLY },
        });
        cidB = reply.status === 201 ? ((reply.json.id as string) ?? null) : null;
      }
    });
    afterAll(async () => {
      await h?.close();
    });

    t()(
      "tenant A's credentials, with tenant B's thread and comment identifiers, are refused and get no data",
      async () => {
        // The control: A's own owner token creates and reads a thread on A's document.
        const own = await h.call('POST', `/v1/documents/${docA}/threads`, {
          token: aOwnerToken,
          body: { target: { block: 'pIntro0000000001' }, comment: { body: 'A own thread.' } },
        });
        expect(own.status, own.text).toBe(201);
        expect(tidB, "tenant B's thread was created").not.toBeNull();
        expect(cidB, "tenant B's reply was created").not.toBeNull();

        const cases: Array<{ method: string; path: string; body?: unknown }> = [
          { method: 'GET', path: `/v1/threads/${tidB}` },
          { method: 'PATCH', path: `/v1/threads/${tidB}`, body: { state: 'resolved' } },
          { method: 'POST', path: `/v1/threads/${tidB}/comments`, body: { body: 'from A' } },
          { method: 'PATCH', path: `/v1/comments/${cidB}`, body: { body: 'from A' } },
          { method: 'DELETE', path: `/v1/comments/${cidB}` },
          { method: 'DELETE', path: `/v1/threads/${tidB}` },
          { method: 'GET', path: `/v1/documents/${docB}/exports` },
        ];
        for (const tokenName of ['service', 'user'] as const) {
          const token = tokenName === 'service' ? h.a.apiKey : aOwnerToken;
          for (const { method, path, body } of cases) {
            const r = await h.call(method, path, {
              token,
              ...(body !== undefined ? { body } : {}),
            });
            expect([401, 403, 404], `${tokenName} ${method} ${path} -> ${r.status}`).toContain(
              r.status,
            );
            expect(
              r.text,
              `${tokenName} ${method} ${path} must not carry B's thread`,
            ).not.toContain(CANARY_B_THREAD);
            expect(r.text, `${tokenName} ${method} ${path} must not carry B's reply`).not.toContain(
              CANARY_B_REPLY,
            );
          }
        }
        // B's thread is unchanged and still readable by B under its own identifier.
        const b = await h.call('GET', `/v1/threads/${tidB}`, { token: bOwnerToken });
        expect(b.status).toBe(200);
        expect((b.json as { id?: unknown } | undefined)?.id).toBe(tidB);
      },
    );
  });
}
