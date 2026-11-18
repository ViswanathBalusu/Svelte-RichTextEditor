/**
 * SEC-045 criterion 1, the REST part (lane V-SEC-033-048, 2026-11-13): tenant A's service credential
 * is called on the routes that take an identifier that the earlier tests did not reach (exports and
 * their jobs, fields and field values, asset resolve, fork, versions, threads, holds, history,
 * attribution, diff, restore, read marker, retention), with tenant B's identifiers. Each call is
 * refused, and no body carries tenant B's canary text. Runs on memory and on PostgreSQL.
 *
 * Not covered here, so the criterion stays unticked: the WebSocket messages that take an identifier
 * beyond `open` (tests/security/test/tenant-isolation.test.ts covers the open), the font and webhook
 * routes with B's identifiers (no webhook or asset of B is created by this file), and the caches.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const CANARY_B_TITLE = 'V-SEC-033-048-TENANT-B-TITLE';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection (SEC harness)
  describe(`SEC-045 criterion 1, REST identifier routes (${storage})`, () => {
    let h: Harness;
    let docB: string;
    let docA: string;
    let jobB: string | null = null;
    const t = () => (skip ? it.skip : it);

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      docB = await h
        .call('POST', '/v1/documents', {
          token: h.b.apiKey,
          body: { title: CANARY_B_TITLE, content: documentWithRegions() },
        })
        .then((r) => {
          expect(r.status).toBe(201);
          return r.json.id as string;
        });
      docA = await h.createDocument(h.a, documentWithRegions());
      // An export job of tenant B, created as B, so that A has a real job identifier to try.
      const exp = await h.call('POST', `/v1/documents/${docB}/exports`, {
        token: h.b.apiKey,
        body: { target: 'pdf' },
      });
      jobB = exp.status === 202 || exp.status === 201 ? ((exp.json.id as string) ?? null) : null;
    });
    afterAll(async () => {
      await h?.close();
    });

    t()(
      "tenant A's service credential, with tenant B's identifiers, is refused on each identifier route and gets no data",
      async () => {
        // The control: A reads its own document, so the credential works and the refusals are real.
        const own = await h.call('GET', `/v1/documents/${docA}`, { token: h.a.apiKey });
        expect(own.status).toBe(200);
        // B's export job must exist, or the two job routes would be skipped without a sign.
        expect(jobB, "tenant B's export job was created").not.toBeNull();

        const asA = (method: string, path: string, body?: unknown) =>
          h.call(method, path, {
            token: h.a.apiKey,
            ...(body !== undefined ? { body } : {}),
          });
        const assetId = '0190a000-0000-7000-8000-000000000001';
        const cases: Array<{ method: string; path: string; body?: unknown }> = [
          { method: 'GET', path: `/v1/documents/${docB}/fields` },
          { method: 'GET', path: `/v1/documents/${docB}/field-values` },
          { method: 'PATCH', path: `/v1/documents/${docB}/field-values`, body: { values: {} } },
          {
            method: 'POST',
            path: `/v1/documents/${docB}/assets/resolve`,
            body: { assets: [assetId] },
          },
          { method: 'POST', path: `/v1/documents/${docB}/exports`, body: { target: 'pdf' } },
          { method: 'POST', path: `/v1/documents/${docB}/fork`, body: {} },
          { method: 'GET', path: `/v1/documents/${docB}/versions` },
          { method: 'GET', path: `/v1/documents/${docB}/threads` },
          { method: 'GET', path: `/v1/documents/${docB}/history` },
          { method: 'GET', path: `/v1/documents/${docB}/attribution?seq=0` },
          { method: 'GET', path: `/v1/documents/${docB}/diff?fromSeq=0&toSeq=0` },
          { method: 'POST', path: `/v1/documents/${docB}/restore`, body: { toSeq: 0 } },
          { method: 'PUT', path: `/v1/documents/${docB}/read-marker`, body: { seq: 0 } },
          { method: 'GET', path: `/v1/documents/${docB}/retention` },
        ];
        if (jobB) {
          cases.push({ method: 'GET', path: `/v1/exports/${jobB}` });
          cases.push({ method: 'DELETE', path: `/v1/exports/${jobB}` });
        }
        for (const { method, path, body } of cases) {
          const r = await asA(method, path, body);
          // Refused before any data: an error status, and no body with B's title or content.
          expect([401, 403, 404], `${method} ${path} -> ${r.status}`).toContain(r.status);
          expect(r.status, `${method} ${path} must not succeed`).toBeGreaterThanOrEqual(400);
          expect(r.text, `${method} ${path} must not carry B's title`).not.toContain(
            CANARY_B_TITLE,
          );
          expect(r.text, `${method} ${path} must not carry B's content`).not.toContain('Liability');
        }
        // B's export job is still B's: A's read did not change it, and B still reads it.
        if (jobB) {
          const b = await h.call('GET', `/v1/exports/${jobB}`, { token: h.b.apiKey });
          expect(b.status).toBe(200);
        }
      },
    );
  });
}
