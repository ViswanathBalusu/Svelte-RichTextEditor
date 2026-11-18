// FRW-061 criterion 6 (lane V-FRW-055-072): a prefill repeated writes one commit. The first request
// is applied through the real data plane (the room or a transient authority); the repeat, sent with
// the same `Idempotency-Key`, gets the first answer back (the route carries the key since ADR 0342,
// decision 184), so the log holds one commit with origin `prefill`; a repeat under another key is
// refused by its stale If-Match. Runs against
// PostgreSQL in Podman when the test environment is up, and against memory storage otherwise.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** A 16-character identifier of the shape the CDM fixtures use. */
const fid = (n: number) => `fb${String(n).padStart(14, '0')}`;

/** The regions fixture with one paragraph holding a text field and a number field (FRW-061). */
function prefillDocument(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  const ff = (n: number, key: string, kind: string, label: string) => ({
    type: 'form_field',
    attrs: { id: fid(n), key, kind, label, assignee: 'tenant', value: null },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pPrefillIdem0001', style: 'Normal' },
    content: [
      ff(1, 'tenant.name', 'text', 'Name'),
      { type: 'text', text: ' ' },
      ff(2, 'fee.amount', 'number', 'Fee'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`prefill repeated with one Idempotency-Key (${storage}; FRW-061 criterion 6)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'a repeat of an applied prefill is refused and writes no second commit',
      async () => {
        const doc = await h.createDocument({ content: prefillDocument() });
        const service = h.serviceJwt();
        const before = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        expect(before.status).toBe(200);
        const etag = before.headers.get('etag')!;
        const key = randomUUID();
        const request = {
          token: service,
          body: { values: { 'tenant.name': 'Grace', 'fee.amount': '12.50' } },
          headers: { 'if-match': etag, 'Idempotency-Key': key },
        };

        const first = await h.call('PATCH', `/v1/documents/${doc}/field-values`, request);
        expect(first.status, JSON.stringify(first.json)).toBe(200);

        // The repeat is the same request under the same key: the first answer is replayed and
        // nothing is applied again (ADR 0342; owner decision 184).
        const again = await h.call('PATCH', `/v1/documents/${doc}/field-values`, request);
        expect(again.status, JSON.stringify(again.json)).toBe(200);
        expect(again.json).toEqual(first.json);
        // The same body under another key is a new request: its stale If-Match refuses it.
        const other = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          ...request,
          headers: { 'if-match': etag, 'Idempotency-Key': randomUUID() },
        });
        expect(other.status, JSON.stringify(other.json)).toBe(412);
        expect(other.json.code).toBe('precondition_failed');

        const commits = await h.call('GET', `/v1/documents/${doc}/commits?after=0&limit=200`, {
          token: service,
        });
        expect(commits.status).toBe(200);
        const items = (commits.json.items ?? []) as Array<{ origin?: string }>;
        expect(items.filter((c) => c.origin === 'prefill')).toHaveLength(1);
      },
      60_000,
    );
  });
}
