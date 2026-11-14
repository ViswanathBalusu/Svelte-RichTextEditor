// FRW-061 accepted prefill, applied for real (lane U-FRW-055-072). The control plane accepts a
// prefill and hands its commit to the outbox; with the real data plane (not the stub) the outbox
// delivers it to the room, or a transient authority when no room is open (06 §2.2, §3), and the
// stored value is then read back. Runs against PostgreSQL in Podman when the test environment is up
// (infra/test-env.ps1 run), and against memory storage otherwise.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** A 16-character identifier of the shape the CDM fixtures use. */
const fid = (n: number) => `fa${String(n).padStart(14, '0')}`;

/** The regions fixture with one paragraph holding a text field and a number field. */
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
  const ff = (n: number, key: string, kind: string, label: string, value: unknown) => ({
    type: 'form_field',
    attrs: { id: fid(n), key, kind, label, assignee: 'tenant', value },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pPrefill00000001', style: 'Normal' },
    content: [
      ff(1, 'tenant.name', 'text', 'Name', null),
      { type: 'text', text: ' ' },
      ff(2, 'fee.amount', 'number', 'Fee', null),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`prefill applied through the real data plane (${storage}; FRW-061 criteria 1, 5)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'an accepted prefill is applied as one commit, stored, and read back at the head; the earlier seq keeps the old value',
      async () => {
        const doc = await h.createDocument({ content: prefillDocument() });
        const service = h.serviceJwt();
        const before = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        expect(before.status).toBe(200);
        const etag = before.headers.get('etag')!;
        const beforeSeq = (before.json as { seq?: number }).seq ?? 0;

        const patch = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service,
          body: { values: { 'tenant.name': 'Grace', 'fee.amount': '12.50' } },
          headers: { 'if-match': etag },
        });
        // Delivered within the wait: 200 with the stored values. A 202 would mean the outbox did not
        // settle in time, which this test treats as a failure, not as a pass.
        expect(patch.status, JSON.stringify(patch.json)).toBe(200);
        expect(patch.json.values).toEqual({ 'tenant.name': 'Grace', 'fee.amount': '12.50' });

        const after = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        expect(after.json.values ?? after.json).toMatchObject({
          'tenant.name': 'Grace',
          'fee.amount': '12.50',
        });
        const afterSeq = (after.json as { seq?: number }).seq;
        if (afterSeq !== undefined) expect(afterSeq).toBeGreaterThan(beforeSeq);

        // One server-authored commit with origin `prefill` is in the log (criterion 1).
        const commits = await h.call('GET', `/v1/documents/${doc}/commits?after=0&limit=200`, {
          token: service,
        });
        expect(commits.status).toBe(200);
        const items = (commits.json.items ?? []) as Array<{
          seq: number;
          origin?: string;
          author?: { user?: string };
        }>;
        const prefills = items.filter((c) => c.origin === 'prefill');
        expect(prefills).toHaveLength(1);
        // No DEP-Actor header is sent, so the commit is attributed to `system` (criterion 1).
        expect(prefills[0]!.author?.user).toBe('system');
        if (afterSeq !== undefined) expect(prefills[0]!.seq).toBe(afterSeq);

        // The earlier seq still holds the old values (the commit is an append, not a rewrite).
        const old = await h.call('GET', `/v1/documents/${doc}/field-values?seq=${beforeSeq}`, {
          token: service,
        });
        expect(old.status).toBe(200);
        expect(old.json.values?.['tenant.name'] ?? null).toBeNull();
      },
      60_000,
    );

    it.skipIf(skip)(
      'a prefill sent with DEP-Actor is one prefill commit attributed to the user it names (FRW-061 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: prefillDocument() });
        const service = h.serviceJwt();
        // A user sub unique to this run (lane U-FRW-055-072).
        const sub = `u-frw-061-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const before = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: service });
        expect(before.status).toBe(200);

        const patch = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service,
          body: { values: { 'tenant.name': 'Ada' } },
          headers: { 'if-match': before.headers.get('etag')!, 'DEP-Actor': sub },
        });
        expect(patch.status, JSON.stringify(patch.json)).toBe(200);
        expect(patch.json.values).toEqual({ 'tenant.name': 'Ada' });

        const commits = await h.call('GET', `/v1/documents/${doc}/commits?after=0&limit=200`, {
          token: service,
        });
        expect(commits.status).toBe(200);
        const items = (commits.json.items ?? []) as Array<{
          seq: number;
          origin?: string;
          author?: { user?: string };
        }>;
        const prefills = items.filter((c) => c.origin === 'prefill');
        expect(prefills).toHaveLength(1);
        // The log answers with the author's sub (commit-routes.ts), not `system`. The pipeline resolved
        // the sub to a surrogate for the commit; the answer is the sub, not that surrogate.
        expect(prefills[0]!.author?.user).toBe(sub);
        const surrogate = (await h.parts.users.resolve(h.tenant, sub)).surrogate;
        expect(surrogate).not.toBe(sub);
        expect(prefills[0]!.author?.user).not.toBe('system');
      },
      60_000,
    );
  });
}
