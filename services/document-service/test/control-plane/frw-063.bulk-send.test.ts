// FRW-063 through the real service: a bulk send of a template. `POST /bulk-sends` queues a job that
// makes one fork of the template for each row, at a pinned seq, binds the row's participants and
// prefills its values; `GET /bulk-sends/{bid}` reports each row with the new document or its
// failure. The job runs in the service's own runner. Memory storage and, when the test environment
// is up, PostgreSQL in Podman. docs/adr/0407-w4-FRW-063-bulk-send.md (proposed).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bulkRowDocumentId } from '../../src/control-plane/bulk-send.ts';
import {
  skipReason,
  startHarness,
  documentWithRegions,
  type Harness,
  type Storage,
} from './support.ts';

/** A template: roles `tenant` and `landlord`, and two fields of the tenant. */
function templateContent(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  for (const role of ['tenant', 'landlord'])
    defs.push({ type: 'role_def', attrs: { id: role, name: role, color: '#1F77B4' } });
  const field = (id: string, key: string, kind: string) => ({
    type: 'form_field',
    attrs: { id, key, kind, label: key, assignee: 'tenant', required: false, value: null },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pBulkTemplate001' },
    content: [
      field('fbTenantName0001', 'tenant.name', 'text'),
      { type: 'text', text: ' ' },
      field('fbLeaseTotal0001', 'lease.total', 'number'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const person = (id: string, role: string, order: number) => ({
  id,
  roles: [role],
  kind: 'filler',
  order,
  sub: `sub-${id}`,
});

interface Row {
  index: number;
  document: string | null;
  error?: { code: string; message: string; violations?: Array<{ path: string; rule: string }> };
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`bulk send of a template (${storage}; FRW-063)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, { realDataPlane: true, config: { jobIdleMs: 20 } });
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    const service = () => h.serviceJwt();
    const call = (
      method: string,
      path: string,
      body?: unknown,
      token = service(),
      headers: Record<string, string> = {},
    ) => h.call(method, `/v1${path}`, { token, ...(body !== undefined ? { body } : {}), headers });
    const values = async (doc: string) =>
      (await call('GET', `/documents/${doc}/field-values`)).json.values as Record<string, unknown>;

    async function newTemplate() {
      const doc = await h.createDocument({ content: templateContent() });
      const made = await call('POST', '/templates', { document: doc, name: 'Lease' });
      expect(made.status, made.text).toBe(201);
      return { doc, template: made.json.id as string, ref: { tenant: h.tenant, doc } };
    }

    /** Waits for the job to finish and returns the bulk send as `GET` reports it. */
    async function finished(bid: string) {
      let last = (await call('GET', `/bulk-sends/${bid}`)).json;
      for (let i = 0; i < 400 && last.state !== 'completed' && last.state !== 'failed'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        last = (await call('GET', `/bulk-sends/${bid}`)).json;
      }
      return last as {
        id: string;
        state: string;
        template: string;
        seq: number;
        total: number;
        done: number;
        rows: Row[];
        error?: { code: string; message: string };
      };
    }

    it.skipIf(skip)(
      'makes one fork per row at the pinned seq, binds the row’s participants and applies its values (criterion 1)',
      async () => {
        const { doc, template, ref } = await newTemplate();
        // The template changes after seq 0, so the pin shows: the forks are made at seq 0.
        const etag = (await call('GET', `/documents/${doc}/field-values`)).headers.get('etag')!;
        const patch = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service(),
          body: { values: { 'tenant.name': 'Changed template' } },
          headers: { 'if-match': etag },
        });
        expect(patch.status, patch.text).toBe(200);
        const head = (await h.parts.logs.head(ref)).seq;
        expect(head).toBeGreaterThan(0);

        const started = await call(
          'POST',
          '/bulk-sends',
          {
            template,
            templateSeq: 0,
            rows: [
              {
                participants: [person('a1', 'tenant', 1)],
                values: { 'tenant.name': 'Ada', 'lease.total': '100' },
                title: 'Ada',
              },
              {
                participants: [person('b1', 'tenant', 1), person('b2', 'landlord', 2)],
                values: { 'tenant.name': 'Bea' },
              },
              { title: 'Bare' },
            ],
          },
          service(),
          { 'idempotency-key': randomUUID() },
        );
        expect(started.status, started.text).toBe(202);
        expect(started.json).toMatchObject({ template, seq: 0, total: 3 });
        const done = await finished(started.json.id);
        expect(done.state, JSON.stringify(done)).toBe('completed');
        expect(done.seq).toBe(0);
        expect(done.rows.map((r) => r.index)).toEqual([0, 1, 2]);
        expect(done.rows.every((r) => r.document !== null && r.error === undefined)).toBe(true);

        const [a, b, c] = done.rows.map((r) => r.document!);
        expect(new Set([a, b, c]).size).toBe(3);
        for (const copy of [a!, b!, c!]) {
          const record = await h.parts.documents.get({ tenant: h.tenant, doc: copy });
          expect([record?.forkedFrom, record?.forkedAtSeq]).toEqual([doc, 0]);
        }
        expect(await values(a!)).toMatchObject({ 'tenant.name': 'Ada', 'lease.total': '100' });
        expect(await values(b!)).toMatchObject({ 'tenant.name': 'Bea', 'lease.total': null });
        // Row 3 has no values, and the template's later change is not in it (the pinned seq).
        expect(await values(c!)).toMatchObject({ 'tenant.name': null });
        const wfB = await call('GET', `/documents/${b}/workflow`);
        expect(wfB.status, wfB.text).toBe(200);
        expect((wfB.json.participants as Array<{ id: string }>).map((p) => p.id)).toEqual([
          'b1',
          'b2',
        ]);
        expect((await call('GET', `/documents/${c}/workflow`)).status).toBe(404);
        expect(((await call('GET', `/documents/${a}`)).json as { title: string }).title).toBe(
          'Ada',
        );
      },
      90_000,
    );

    it.skipIf(skip)(
      'reports a failing row with its reason and leaves the other rows alone (criteria 2 and 5)',
      async () => {
        const { template } = await newTemplate();
        const started = await call('POST', '/bulk-sends', {
          template,
          rows: [
            { values: { 'tenant.name': 'Good one' } },
            { values: { 'no.such.key': 'x' } },
            { participants: [person('p1', 'witness', 1)] },
            { values: { 'lease.total': 'not a number' } },
            { values: { 'tenant.name': 'Good two' }, participants: [person('p9', 'tenant', 1)] },
          ],
        });
        expect(started.status, started.text).toBe(202);
        const done = await finished(started.json.id);
        expect(done.state).toBe('completed');
        expect(done.total).toBe(5);
        expect(done.done).toBe(5);
        // Each row is listed, in order, with the new document or the failure.
        expect(done.rows.map((r) => [r.index, r.document !== null])).toEqual([
          [0, true],
          [1, false],
          [2, false],
          [3, false],
          [4, true],
        ]);
        expect(done.rows[1]!.error).toMatchObject({
          code: 'field_invalid',
          violations: [{ path: '/values/no.such.key', rule: expect.stringContaining('field') }],
        });
        expect(done.rows[2]!.error).toMatchObject({
          code: 'validation_failed',
          violations: [{ path: '/participants/0/roles', rule: expect.stringContaining('witness') }],
        });
        expect(done.rows[3]!.error?.code).toBe('field_invalid');
        // The rows that were fine were made, and the failed ones left no document.
        expect(await values(done.rows[0]!.document!)).toMatchObject({ 'tenant.name': 'Good one' });
        expect(await values(done.rows[4]!.document!)).toMatchObject({ 'tenant.name': 'Good two' });
        for (const i of [1, 2, 3])
          expect(
            await h.parts.documents.get({ tenant: h.tenant, doc: bulkRowDocumentId(done.id, i) }),
          ).toBeNull();
      },
      90_000,
    );

    it.skipIf(skip)(
      'makes no fork twice when the request is repeated with the same Idempotency-Key (criterion 3)',
      async () => {
        const { template } = await newTemplate();
        const key = randomUUID();
        const body = { template, rows: [{ title: 'one' }, { title: 'two' }] };
        const first = await call('POST', '/bulk-sends', body, service(), {
          'idempotency-key': key,
        });
        expect(first.status, first.text).toBe(202);
        const done = await finished(first.json.id);
        expect(done.rows.every((r) => r.document !== null)).toBe(true);
        const count = async () =>
          ((await call('GET', '/documents?limit=200')).json.items as unknown[]).length;
        const before = await count();

        const again = await call('POST', '/bulk-sends', body, service(), {
          'idempotency-key': key,
        });
        expect(again.status, again.text).toBe(202);
        expect(again.json.id).toBe(first.json.id);
        // A moment for a second job, if one had been queued, to make its documents.
        await new Promise((r) => setTimeout(r, 300));
        expect(await count()).toBe(before);
        // The same key with another body is refused, and another key is another bulk send.
        const mismatch = await call('POST', '/bulk-sends', { ...body, rows: [{}] }, service(), {
          'idempotency-key': key,
        });
        expect(mismatch.status).toBe(422);
        const other = await call('POST', '/bulk-sends', body, service(), {
          'idempotency-key': randomUUID(),
        });
        expect(other.json.id).not.toBe(first.json.id);
      },
      90_000,
    );

    it.skipIf(skip)(
      'derives the document of each row from the job and the row, so a row is made once',
      () => {
        const job = randomUUID();
        expect(bulkRowDocumentId(job, 0)).toBe(bulkRowDocumentId(job, 0));
        expect(bulkRowDocumentId(job, 0)).not.toBe(bulkRowDocumentId(job, 1));
        expect(bulkRowDocumentId(job, 0)).not.toBe(bulkRowDocumentId(randomUUID(), 0));
        expect(bulkRowDocumentId(job, 3)).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      },
    );

    it.skipIf(skip)(
      'refuses a request that is not valid, a user credential and an unknown template or bulk send',
      async () => {
        const { doc, template } = await newTemplate();
        const ghost = '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c03';
        expect((await call('POST', '/bulk-sends', { template, rows: [] })).status).toBe(400);
        const member = await call('POST', '/bulk-sends', { template, rows: [{ bogus: 1 }] });
        expect(member.status, member.text).toBe(400);
        expect(member.json.violations).toEqual([
          { path: '/rows/0/bogus', rule: expect.any(String) },
        ]);
        expect((await call('POST', '/bulk-sends', { template: ghost, rows: [{}] })).status).toBe(
          404,
        );
        expect(
          (await call('POST', '/bulk-sends', { template, templateSeq: 999, rows: [{}] })).status,
        ).toBe(404);
        expect((await call('GET', `/bulk-sends/${ghost}`)).status).toBe(404);

        const user = h.userToken({ [doc]: 'owner' });
        expect((await call('POST', '/bulk-sends', { template, rows: [{}] }, user)).status).toBe(
          403,
        );
        expect((await call('GET', `/bulk-sends/${ghost}`, undefined, user)).status).toBe(403);
      },
      60_000,
    );
  });
}
