// UX-080 criteria 1 and 4 over real HTTP, through the request pipeline and the router, with
// in-memory storage (lane U-UX-076-090): a tenant policy and a document policy are set, read back
// with their ETags, validated, kept apart between tenants and audited. Test values only. The
// PostgreSQL store is tested in ux-080-retention-pg.test.ts. Not claimed here: the holds
// (criteria 2 and 3, which need `@docedit/history`), and the list of holds.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { MemoryRetentionStore, RetentionService } from '../../src/control-plane/retention.ts';
import { startHarness, type Harness } from './support.ts';

describe('/retention over HTTP (UX-080)', () => {
  let h: Harness;
  let other: string;
  const docs = new Map<string, string>();
  const audit = new MemoryAudit();

  beforeAll(async () => {
    const retention = new RetentionService({
      store: new MemoryRetentionStore(),
      audit,
      documentExists: async (tenant, id) => docs.get(id) === tenant,
      now: () => Date.now(),
    });
    h = await startHarness('memory', { parts: { audit, retention } });
    // A second tenant with its own service key, to check that its policies stay its own.
    const tenant = randomUUID();
    await h.parts.registry.putTenant(tenant, 'Other tenant');
    const key = newApiKey(tenant);
    await h.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
    other = key.credential;
  });

  afterAll(async () => {
    await h?.close();
  });

  const newDoc = async (): Promise<string> => {
    const id = await h.createDocument();
    docs.set(id, h.tenant);
    return id;
  };

  it('answers keep_all at version 0 until a tenant policy is set, then stores and returns it', async () => {
    const before = await h.call('GET', '/v1/retention', { token: h.apiKey });
    expect(before.status).toBe(200);
    expect(before.json).toEqual({ mode: 'keep_all' });
    expect(before.headers.get('etag')).toBe('"0"');

    const noMatch = await h.call('PUT', '/v1/retention', {
      token: h.apiKey,
      body: { mode: 'thin_payloads', afterDays: 30 },
    });
    expect(noMatch.status).toBe(428);

    const set = await h.call('PUT', '/v1/retention', {
      token: h.apiKey,
      body: { mode: 'thin_payloads', afterDays: 30 },
      headers: { 'If-Match': '"0"' },
    });
    expect(set.status, set.text).toBe(200);
    expect(set.json).toEqual({ mode: 'thin_payloads', afterDays: 30 });
    expect(set.headers.get('etag')).toBe('"1"');

    const read = await h.call('GET', '/v1/retention', { token: h.apiKey });
    expect(read.json).toEqual({ mode: 'thin_payloads', afterDays: 30 });
    expect(read.headers.get('etag')).toBe('"1"');

    // A stale If-Match is refused and changes nothing.
    const stale = await h.call('PUT', '/v1/retention', {
      token: h.apiKey,
      body: { mode: 'keep_all' },
      headers: { 'If-Match': '"0"' },
    });
    expect(stale.status).toBe(412);
    expect((await h.call('GET', '/v1/retention', { token: h.apiKey })).json).toEqual({
      mode: 'thin_payloads',
      afterDays: 30,
    });
  });

  it('refuses an invalid policy with validation_failed and stores nothing', async () => {
    const etag = (await h.call('GET', '/v1/retention', { token: h.apiKey })).headers.get('etag')!;
    const bad: unknown[] = [
      { mode: 'thin_payloads' },
      { mode: 'thin_payloads', afterDays: 0 },
      { mode: 'thin_payloads', afterDays: 1.5 },
      { mode: 'thin_payloads', afterDays: '30' },
      { mode: 'keep_all', afterDays: 30 },
      { mode: 'delete_all' },
      { mode: 'keep_all', extra: true },
    ];
    for (const body of bad) {
      const r = await h.call('PUT', '/v1/retention', {
        token: h.apiKey,
        body,
        headers: { 'If-Match': etag },
      });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.code ?? r.json.type ?? '', JSON.stringify(r.json)).toMatch(/validation_failed/);
    }
    const after = await h.call('GET', '/v1/retention', { token: h.apiKey });
    expect(after.headers.get('etag')).toBe(etag);
  });

  it('sets a document policy that overrides the tenant policy, and reports where the effective one comes from', async () => {
    const doc = await newDoc();
    const first = await h.call('GET', `/v1/documents/${doc}/retention`, { token: h.apiKey });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      policy: null,
      effective: { mode: 'thin_payloads', afterDays: 30 },
      source: 'tenant',
    });
    expect(first.headers.get('etag')).toBe('"0"');

    const set = await h.call('PUT', `/v1/documents/${doc}/retention`, {
      token: h.apiKey,
      body: { mode: 'keep_all' },
      headers: { 'If-Match': '"0"' },
    });
    expect(set.status, set.text).toBe(200);
    expect(set.json).toEqual({
      policy: { mode: 'keep_all' },
      effective: { mode: 'keep_all' },
      source: 'document',
    });
    expect(set.headers.get('etag')).toBe('"1"');

    const read = await h.call('GET', `/v1/documents/${doc}/retention`, { token: h.apiKey });
    expect(read.json).toEqual({
      policy: { mode: 'keep_all' },
      effective: { mode: 'keep_all' },
      source: 'document',
    });
  });

  it('answers the default when neither the tenant nor the document sets a policy', async () => {
    const ownTenant = randomUUID();
    await h.parts.registry.putTenant(ownTenant, 'Third tenant');
    const key = newApiKey(ownTenant);
    await h.parts.registry.addApiKey(ownTenant, { id: key.id, secretHash: hashSecret(key.secret) });
    const doc = randomUUID();
    docs.set(doc, ownTenant);
    const read = await h.call('GET', `/v1/documents/${doc}/retention`, { token: key.credential });
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ policy: null, effective: { mode: 'keep_all' }, source: 'default' });
  });

  it('keeps tenants apart: another tenant sees neither the policy nor the document', async () => {
    const doc = await newDoc();
    expect((await h.call('GET', `/v1/documents/${doc}/retention`, { token: other })).status).toBe(
      404,
    );
    expect(
      (
        await h.call('PUT', `/v1/documents/${doc}/retention`, {
          token: other,
          body: { mode: 'keep_all' },
          headers: { 'If-Match': '"0"' },
        })
      ).status,
    ).toBe(404);
    // Its own tenant policy is still the default.
    expect((await h.call('GET', '/v1/retention', { token: other })).json).toEqual({
      mode: 'keep_all',
    });
  });

  it('refuses a user token with forbidden on every retention route', async () => {
    const doc = await newDoc();
    const user = h.userToken({ [doc]: 'editor' });
    expect((await h.call('GET', '/v1/retention', { token: user })).status).toBe(403);
    expect((await h.call('GET', `/v1/documents/${doc}/retention`, { token: user })).status).toBe(
      403,
    );
    expect(
      (
        await h.call('PUT', '/v1/retention', {
          token: user,
          body: { mode: 'keep_all' },
          headers: { 'If-Match': '"1"' },
        })
      ).status,
    ).toBe(403);
  });

  it('audits each change with its scope, previous and new policy, and serves the events to the service', async () => {
    const page = await h.call('GET', '/v1/audit?kind=retention.changed', { token: h.apiKey });
    expect(page.status, page.text).toBe(200);
    const events = await audit.query(h.tenant, { kind: 'retention.changed', limit: 1000 });
    // Two tenant changes (set, then the refused stale one did not change) and one document change.
    const tenantEvents = events.filter((e) => e.doc === null);
    const docEvents = events.filter((e) => e.doc !== null);
    expect(tenantEvents).toHaveLength(1);
    expect(tenantEvents[0]?.data).toMatchObject({
      scope: 'tenant',
      previous: { mode: 'keep_all' },
      policy: { mode: 'thin_payloads', afterDays: 30 },
    });
    expect(docEvents.length).toBeGreaterThanOrEqual(1);
    expect(docEvents[0]?.data).toMatchObject({ scope: 'document', previous: null });
    expect(page.json.items.length).toBeGreaterThanOrEqual(2);
    for (const e of events) expect(e.actor).toBe('system');
  });
});
