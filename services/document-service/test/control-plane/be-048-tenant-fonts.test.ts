// BE-048 in the composed service (lane w5): an administrator adds a font file with a licence
// declaration, the font is checked in the asset worker's sandbox code (in process,
// `unsandboxed()`; the same code runs in the Podman sandbox) and stored under the tenant by its
// hash, the tenant's manifest names it and another tenant's does not, and a font that fails the
// check is refused with nothing stored, listed or audited. Runs in memory and on PostgreSQL (a
// database of its own, dropped afterwards). The fonts are synthetic (test/support/font-bytes.ts).
import { createHash, randomUUID } from 'node:crypto';
import { unsandboxed } from '@docedit/asset-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { ttf } from '../support/font-bytes.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`tenant fonts in the composed service (${storage}; BE-048)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let other = '';
    let otherKey = '';
    let doc = '';
    const viewer = () => h.userToken({ [doc]: 'viewer' });
    const otherTenant = randomUUID();

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
      });
      await h.parts.registry.putTenant(otherTenant, 'BE-048 other tenant');
      const key = newApiKey(otherTenant);
      await h.parts.registry.addApiKey(otherTenant, {
        id: key.id,
        secretHash: hashSecret(key.secret),
      });
      other = key.credential;
      doc = await h.createDocument();
      otherKey = key.id;
    });
    afterAll(async () => {
      await h?.close();
    });

    const add = (token: string, body: Record<string, unknown>) =>
      h.call('POST', '/v1/tenant-fonts', { token, body });
    const request = (file: Uint8Array, extra: Record<string, unknown> = {}) => ({
      mime: 'font/ttf',
      content: b64(file),
      licence: 'Brand licence 2026-114, desktop and server',
      serverUse: true,
      ...extra,
    });
    const manifest = async (token: string) => {
      const r = await h.call('GET', '/v1/fonts', { token });
      expect(r.status, r.text).toBe(200);
      return r;
    };
    const families = (m: { json: { families: Array<{ family: string }> } }) =>
      m.json.families.map((f) => f.family);

    const brand = ttf({ family: 'Brand Serif' });
    const brandBold = ttf({ family: 'Brand Serif', weight: 700 });

    it.skipIf(skip)(
      'checks the file and stores it under the tenant by its hash (criterion 1)',
      async () => {
        const r = await add(h.apiKey, request(brand, { filename: 'BrandSerif-Regular.ttf' }));
        expect(r.status, r.text).toBe(201);
        expect(r.json).toMatchObject({
          sha256: sha(brand),
          family: 'Brand Serif',
          style: 'regular',
          format: 'truetype',
          licence: 'Brand licence 2026-114, desktop and server',
          serverUse: true,
        });
        // The bytes are in the tenant's prefix, named by their hash, and are the bytes sent.
        const stored = await h.parts.objects.get(`tenants/${h.tenant}/fonts/${sha(brand)}`);
        expect(stored && sha(stored)).toBe(sha(brand));
        const keys = await h.parts.objects.list(`tenants/${h.tenant}/fonts/`);
        expect(keys).toEqual([`tenants/${h.tenant}/fonts/${sha(brand)}`]);
        // A second face of the family; the same file again, and the same face again, conflict.
        expect((await add(h.apiKey, request(brandBold))).status).toBe(201);
        expect((await add(h.apiKey, request(brand))).status).toBe(409);
        const sameFace = ttf({ family: 'brand serif', fsType: 4 });
        expect((await add(h.apiKey, request(sameFace))).status).toBe(409);
        // The addition is audited with the hash and the declaration, not the bytes.
        const events = await h.parts.audit!.query(h.tenant, { kind: 'font.added', limit: 50 });
        expect(events).toHaveLength(2);
        expect(events[0]!.data).toMatchObject({ sha256: sha(brand), serverUse: true });
        expect(JSON.stringify(events)).not.toContain(b64(brand).slice(0, 40));
      },
    );

    it.skipIf(skip)(
      "names the font with its licence in the tenant's manifest and not in another's (criterion 2)",
      async () => {
        const mine = await manifest(h.apiKey);
        const fam = mine.json.families.find((f: { family: string }) => f.family === 'Brand Serif');
        expect(fam).toMatchObject({ role: 'text', tenant: true, serverUse: true });
        expect(fam.faces.map((f: { style: string }) => f.style).sort()).toEqual([
          'bold',
          'regular',
        ]);
        expect(fam.faces[0]).toMatchObject({
          licence: 'Brand licence 2026-114, desktop and server',
          serverUse: true,
          format: 'truetype',
        });
        // Every user of the tenant reads the same list (decision 95).
        const asUser = await manifest(viewer());
        expect(asUser.json).toEqual(mine.json);
        // Another tenant's manifest has no trace of it, and the version differs.
        const theirs = await manifest(other);
        expect(families(theirs)).not.toContain('Brand Serif');
        expect(JSON.stringify(theirs.json)).not.toContain(sha(brand));
        expect(theirs.json.version).not.toBe(mine.json.version);
        // The manifest of a tenant without fonts is the shared one: the version moves only with a font.
        expect(mine.headers.get('etag')).not.toBe(theirs.headers.get('etag'));
        // The file: the tenant reads it, another tenant gets nothing even for the same hash.
        const file = await h.call('GET', `/v1/tenant-fonts/${sha(brand)}`, { token: h.apiKey });
        expect(file.status, file.text).toBe(200);
        expect(Buffer.from(file.json.content, 'base64').equals(Buffer.from(brand))).toBe(true);
        expect(file.json.mime).toBe('font/ttf');
        expect(
          (await h.call('GET', `/v1/tenant-fonts/${sha(brand)}`, { token: other })).status,
        ).toBe(404);
        // The same file added by the other tenant is theirs alone: its own object, its own row.
        expect((await add(other, request(brand, { serverUse: false }))).status).toBe(201);
        const both = await manifest(other);
        expect(
          both.json.families.find((f: { family: string }) => f.family === 'Brand Serif'),
        ).toMatchObject({
          serverUse: false,
        });
        expect(await h.parts.objects.exists(`tenants/${otherTenant}/fonts/${sha(brand)}`)).toBe(
          true,
        );
      },
    );

    it.skipIf(skip)(
      'refuses a font that fails validation and publishes nothing (criterion 4)',
      async () => {
        const before = await manifest(h.apiKey);
        const objectsBefore = await h.parts.objects.list(`tenants/${h.tenant}/fonts/`);
        const auditBefore = await h.parts.audit!.query(h.tenant, { kind: 'font.added', limit: 50 });
        const truncated = brand.subarray(0, brand.length - 40);
        const restricted = ttf({ family: 'Locked Serif', fsType: 2 });
        const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
        const cases: Array<[string, Record<string, unknown>, number]> = [
          ['a truncated file', request(truncated), 400],
          ['a licence that restricts embedding', request(restricted), 400],
          ['an image declared as a font', request(png), 400],
          ['a type that is not a font type', request(brand, { mime: 'image/png' }), 400],
          ['a font declared as WOFF2', request(brand, { mime: 'font/woff2' }), 400],
          ['content that is not base64', request(brand, { content: '***' }), 400],
          ['no licence declaration', request(brand, { licence: '' }), 400],
          ['no server-use flag', { mime: 'font/ttf', content: b64(brand), licence: 'x' }, 400],
          ['an unknown field', request(brand, { extra: 1 }), 400],
        ];
        for (const [what, body, status] of cases) {
          const r = await add(h.apiKey, body);
          expect(r.status, `${what}: ${r.text}`).toBe(status);
        }
        // Nothing was stored, listed or audited.
        expect(await h.parts.objects.list(`tenants/${h.tenant}/fonts/`)).toEqual(objectsBefore);
        expect((await manifest(h.apiKey)).json).toEqual(before.json);
        expect(await h.parts.audit!.query(h.tenant, { kind: 'font.added', limit: 50 })).toEqual(
          auditBefore,
        );
      },
    );

    it.skipIf(skip)(
      'is for the service credential: a user token and no credential are refused',
      async () => {
        const body = request(ttf({ family: 'Nope Sans' }));
        expect([401, 403]).toContain((await h.call('POST', '/v1/tenant-fonts', { body })).status);
        expect((await add(viewer(), body)).status).toBe(403);
        const del = await h.call('DELETE', `/v1/tenant-fonts/${sha(brand)}`, { token: viewer() });
        expect(del.status).toBe(403);
        expect(families(await manifest(h.apiKey))).not.toContain('Nope Sans');
      },
    );

    it.skipIf(skip)("removes a font and its file, and not another tenant's", async () => {
      const gone = await h.call('DELETE', `/v1/tenant-fonts/${sha(brandBold)}`, { token: other });
      expect(gone.status).toBe(404);
      const r = await h.call('DELETE', `/v1/tenant-fonts/${sha(brandBold)}`, { token: h.apiKey });
      expect(r.status, r.text).toBe(200);
      expect(r.json.sha256).toBe(sha(brandBold));
      expect(await h.parts.objects.exists(`tenants/${h.tenant}/fonts/${sha(brandBold)}`)).toBe(
        false,
      );
      const fam = (await manifest(h.apiKey)).json.families.find(
        (f: { family: string }) => f.family === 'Brand Serif',
      );
      expect(fam.faces.map((f: { style: string }) => f.style)).toEqual(['regular']);
      expect(
        (await h.call('GET', `/v1/tenant-fonts/${sha(brandBold)}`, { token: h.apiKey })).status,
      ).toBe(404);
      const events = await h.parts.audit!.query(h.tenant, { kind: 'font.removed', limit: 10 });
      expect(events.map((e) => e.data['sha256'])).toEqual([sha(brandBold)]);
      void otherKey;
    });
  });
}
