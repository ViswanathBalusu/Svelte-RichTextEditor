/**
 * UX-089: the administration console. Node.js tests of its client and of the shape of its
 * bundle. The mock is built from spec/dep/dep-1.openapi.json alone (admin-mock.ts): a route the
 * published contract does not have is answered `not_found` and recorded, so these tests show
 * that the console uses no private endpoint. The page itself (axe, keyboard) is
 * e2e/ux-089-admin-console.spec.ts.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { AdminApiError, AdminClient, parseQuota } from '../admin/src/api.ts';
import { createAdminMock, MOCK_BASE, SERVICE_CREDENTIAL } from './admin-mock.ts';

const adminDir = fileURLToPath(new URL('../admin', import.meta.url));

function clientFor(credential = SERVICE_CREDENTIAL) {
  const mock = createAdminMock();
  const client = new AdminClient({
    endpoint: MOCK_BASE,
    credential,
    fetch: mock.fetch,
    actor: 'admin@example.test',
  });
  return { mock, client };
}

describe('UX-089 console against a mock of the published API only', () => {
  it('reaches an operation of the published contract for every function of the console', async () => {
    const { mock, client } = clientFor();

    // Quotas: blank dimensions are null; a change needs the ETag and is read back.
    const q = await client.getQuotas();
    expect(q.value.connections).toBeNull();
    const q2 = await client.setQuotas({ connections: 50, storage: 1000 }, q.etag!);
    expect(q2.value.connections).toBe(50);
    expect(q2.etag).not.toBe(q.etag);

    // Origins and keys.
    await client.addOrigin('https://admin.example.test');
    expect(await client.listOrigins()).toContain('https://admin.example.test');
    await client.removeOrigin('https://admin.example.test');
    expect(await client.listOrigins()).not.toContain('https://admin.example.test');
    await client.registerKey({
      kid: 'host-2',
      use: 'user',
      alg: 'ES256',
      jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
    });
    expect((await client.listKeys()).map((k) => k.kid)).toEqual(['host-1', 'host-2']);
    await client.removeKey('host-1');
    expect((await client.listKeys()).map((k) => k.kid)).toEqual(['host-2']);

    // Retention (tenant and document) and holds.
    const r = await client.getRetention();
    const r2 = await client.setRetention({ mode: 'thin_payloads', afterDays: 90 }, r.etag!);
    expect(r2.value).toEqual({ mode: 'thin_payloads', afterDays: 90 });
    const doc = '0190a000-0000-7000-8000-000000000001';
    const d = await client.getDocumentRetention(doc);
    expect(d.value.source).toBe('tenant');
    const d2 = await client.setDocumentRetention(doc, { mode: 'keep_all' }, d.etag!);
    expect(d2.value.source).toBe('document');
    const hold = await client.placeHold(doc, '  Litigation 2026  ');
    expect(hold.reason).toBe('Litigation 2026');
    expect((await client.listHolds()).items.map((h) => h.id)).toEqual([hold.id]);

    // Webhooks: create (secret once), rotate, retire, test, replay, delete.
    const w = await client.createWebhook('https://hooks.example.test/a', [
      'dep.document.changed.v1',
    ]);
    expect(w.secret).toMatch(/^whsec_/);
    const listed = (await client.listWebhooks()).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');
    expect((await client.updateWebhook(w.id, { rotate: true })).activeSecrets).toBe(2);
    expect((await client.updateWebhook(w.id, { retire: true })).activeSecrets).toBe(1);
    expect((await client.updateWebhook(w.id, { url: 'https://hooks.example.test/b' })).url).toBe(
      'https://hooks.example.test/b',
    );
    expect(await client.pingWebhook(w.id)).toMatch(/^dl-/);
    expect(await client.replayWebhookDelivery(w.id, 'dl-0001')).toMatch(/^dl-/);
    await client.deleteWebhook(w.id);
    expect((await client.listWebhooks()).items).toEqual([]);

    // Fonts and the audit viewer; every change above is on the trail, by the named actor.
    expect((await client.getFonts()).families[0]?.licence).toBe('OFL-1.1');
    const all = await client.queryAudit();
    const kinds = new Set(all.items.map((e) => e.kind));
    for (const k of [
      'quota.changed',
      'origin.added',
      'origin.removed',
      'key.registered',
      'key.removed',
      'retention.changed',
      'hold.placed',
      'webhook.changed',
    ])
      expect(kinds, k).toContain(k);
    expect(all.items.every((e) => e.actor === 'admin@example.test')).toBe(true);
    expect((await client.queryAudit({ kind: 'hold.placed' })).items).toHaveLength(1);
    expect((await client.queryAudit({ document: doc })).items.length).toBeGreaterThan(0);

    // The point of the criterion: nothing outside the published contract was called.
    expect(mock.unpublished).toEqual([]);
    expect(new Set(mock.matched).size).toBeGreaterThanOrEqual(23);
  });

  it('shows that the mock would catch a private endpoint', async () => {
    const mock = createAdminMock();
    const res = await mock.fetch(`${MOCK_BASE}/internal/state`, {
      headers: { Authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    });
    expect(res.status).toBe(404);
    expect((await mock.fetch(`${MOCK_BASE}/admin/usage`, { method: 'POST' })).status).toBe(404);
    expect(mock.unpublished).toEqual(['GET /v1/internal/state', 'POST /v1/admin/usage']);
  });

  it('sends the credential as a bearer header, never in a URL, and `If-Match` on updates', async () => {
    const urls: string[] = [];
    const seen: Array<Record<string, string>> = [];
    const mock = createAdminMock();
    const client = new AdminClient({
      endpoint: MOCK_BASE,
      credential: SERVICE_CREDENTIAL,
      fetch: async (input, init) => {
        urls.push(String(input));
        seen.push(Object.fromEntries(new Headers(init?.headers)));
        return mock.fetch(input, init);
      },
    });
    const q = await client.getQuotas();
    await client.setQuotas({ storage: 1 }, q.etag!);
    await client.addOrigin('https://x.example.test');
    expect(urls.every((u) => !u.includes(SERVICE_CREDENTIAL))).toBe(true);
    expect(seen.every((h) => h['authorization'] === `Bearer ${SERVICE_CREDENTIAL}`)).toBe(true);
    expect(seen[1]?.['if-match']).toBe(q.etag);
    expect(seen[2]?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(mock.unpublished).toEqual([]);
  });

  it('turns problem details into errors, and refuses a stale update', async () => {
    const { client } = clientFor();
    const q = await client.getQuotas();
    await client.setQuotas({ storage: 5 }, q.etag!);
    await expect(client.setQuotas({ storage: 6 }, q.etag!)).rejects.toMatchObject({
      status: 412,
      code: 'conflict',
    });
    await expect(client.setQuotas({ storage: -1 }, '"q2"')).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
    });
    await expect(
      client.registerKey({ kid: 'sym', use: 'user', alg: 'ES256', jwk: { kty: 'oct', k: 'x' } }),
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it('refuses a user without administration rights (criterion 5)', async () => {
    const user = clientFor('user-token-abc');
    expect(await user.client.checkAccess()).toMatchObject({ ok: false, code: 'forbidden' });
    const service = clientFor();
    expect(await service.client.checkAccess()).toEqual({ ok: true });
    const none = createAdminMock();
    const anon = new AdminClient({
      endpoint: MOCK_BASE,
      credential: '',
      fetch: (i, init) => none.fetch(i, { ...init, headers: {} }),
    });
    expect(await anon.checkAccess()).toMatchObject({ ok: false, code: 'unauthenticated' });
    // A network failure is `unavailable`, not a refusal of rights.
    const down = new AdminClient({
      endpoint: MOCK_BASE,
      credential: 'x',
      fetch: () => Promise.reject(new Error('down')),
    });
    expect(await down.checkAccess()).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('reads quota fields: blank means unchanged, otherwise a whole number of 0 or more', () => {
    expect(parseQuota('')).toEqual({ ok: true, value: null });
    expect(parseQuota(' 12 ')).toEqual({ ok: true, value: 12 });
    for (const bad of ['-1', '1.5', '1e3', 'abc', '9'.repeat(16)])
      expect(parseQuota(bad).ok).toBe(false);
  });
});

describe('UX-089 the console is a bundle of its own (criterion 4)', () => {
  it('imports nothing of the component, and calls the network only from api.ts', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(join(adminDir, 'src'));
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/@docedit\/(element|ui|engine|painter|model)/);
      expect(text, f).not.toMatch(/prosemirror/);
      if (!f.endsWith('api.ts')) expect(text, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
    }
  });

  it('builds on its own into one page with scripts and styles, without the component', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ux089-'));
    try {
      await build({
        configFile: join(adminDir, 'vite.config.ts'),
        logLevel: 'silent',
        build: { outDir: out, emptyOutDir: true },
      });
      const all: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else all.push(p);
        }
      };
      walk(out);
      expect(all.some((f) => f.endsWith('index.html'))).toBe(true);
      const js = all
        .filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      expect(js.length).toBeGreaterThan(1000);
      expect(js).not.toContain('doc-editor');
      expect(js).not.toContain('prosemirror');
      expect(js).toContain('/quotas');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
