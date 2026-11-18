// `GET /documents/{id}/connect` (BE-061 criteria 1 and 4): the WebSocket URL of the node that owns
// the document, or of the node routing would choose; `forbidden` for a caller without `view`.
// In-memory storage; nodes are lease rows with the address each wrote.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { StubDataPlane, documentWithRegions, hostKey } from '../../test/control-plane/support.ts';
import { configFromEnv } from '../config.ts';
import type { MemoryNodeLeases } from '../data-plane/memory-ports.ts';
import { memoryParts, startService, type Service } from '../server.ts';
import { signJws } from './jwt.ts';
import { routeDocument } from './room-routing.ts';
import { hashSecret } from './tenants.ts';
import { newApiKey, signingKey } from './tokens.ts';
import { FULL_VIEWS } from './visibility.ts';

let service: Service | null = null;
afterEach(async () => {
  await service?.close();
  service = null;
});

async function start() {
  const parts = memoryParts();
  const svc = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1 },
    parts,
    signing: signingKey(undefined, 'be-061-test'),
    createDataPlane: () => new StubDataPlane(),
    views: FULL_VIEWS,
  });
  service = svc;
  const tenant = randomUUID();
  await parts.registry.putTenant(tenant, 'Test tenant');
  const host = hostKey('EdDSA');
  await parts.registry.addKey(tenant, { kid: host.kid, use: 'user', alg: host.alg, jwk: host.jwk });
  const key = newApiKey(tenant);
  await parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
  const userToken = (docs: Record<string, string>) => {
    const iat = Math.floor(Date.now() / 1000);
    return signJws(
      { alg: host.alg, typ: 'JWT', kid: host.kid },
      {
        iss: 'https://host.example.test',
        aud: svc.url,
        iat,
        exp: iat + 600,
        jti: uuid7(),
        tid: tenant,
        sub: 'alice',
        docs,
      },
      host.privateKey,
    );
  };
  const call = async (path: string, token: string) => {
    const res = await fetch(`${svc.url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
    const json: any = text ? JSON.parse(text) : undefined;
    return { status: res.status, headers: res.headers, json };
  };
  const createDocument = async () => {
    const res = await fetch(`${svc.url}/v1/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: documentWithRegions() }),
    });
    return ((await res.json()) as { id: string }).id;
  };
  return {
    parts,
    tenant,
    call,
    userToken,
    createDocument,
    apiKey: key.credential,
    leases: parts.leases as MemoryNodeLeases,
  };
}

describe('the connect hint names the owning node (BE-061 criterion 1)', () => {
  it('names the node that owns the document, with the address it wrote on its lease row', async () => {
    const t = await start();
    await t.leases.renew('node-a', 60_000, 'wss://a.example.test/dep');
    await t.leases.renew('node-b', 60_000, 'wss://b.example.test/dep');
    const doc = await t.createDocument();
    // The owner is the node that is not the one routing prefers, so the answer is the owner's.
    const routed = routeDocument(doc, ['node-a', 'node-b']);
    const owner = routed === 'node-a' ? 'node-b' : 'node-a';
    await t.parts.ownership.claim({ tenant: t.tenant, doc }, owner);
    const r = await t.call(`/v1/documents/${doc}/connect`, t.userToken({ [doc]: 'viewer' }));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      url: `wss://${owner.slice(-1)}.example.test/dep`,
      node: owner,
      source: 'owner',
    });
    expect(r.headers.get('cache-control')).toContain('no-store');
  });

  it('names the node routing would choose when the document has no owner', async () => {
    const t = await start();
    await t.leases.renew('node-a', 60_000, 'wss://a.example.test/dep');
    await t.leases.renew('node-b', 60_000, 'wss://b.example.test/dep');
    const doc = await t.createDocument();
    const named = routeDocument(doc, ['node-a', 'node-b']);
    const r = await t.call(`/v1/documents/${doc}/connect`, t.apiKey);
    expect(r.json).toEqual({
      url: `wss://${named.slice(-1)}.example.test/dep`,
      node: named,
      source: 'routing',
    });
  });

  it('routes again when the owner has no live lease', async () => {
    const t = await start();
    await t.leases.renew('node-a', 60_000, 'wss://a.example.test/dep');
    const doc = await t.createDocument();
    await t.parts.ownership.claim({ tenant: t.tenant, doc }, 'node-gone');
    const r = await t.call(`/v1/documents/${doc}/connect`, t.apiKey);
    expect(r.json).toMatchObject({ node: 'node-a', source: 'routing' });
  });

  it('offers the address of the service itself when the named node announced none', async () => {
    const t = await start();
    await t.leases.renew('node-a', 60_000);
    const doc = await t.createDocument();
    const r = await t.call(`/v1/documents/${doc}/connect`, t.apiKey);
    expect(r.json).toMatchObject({ node: 'node-a', source: 'entry' });
    expect(String(r.json.url)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);
  });

  it('offers the address of the service itself when no node is live', async () => {
    const t = await start();
    const doc = await t.createDocument();
    const r = await t.call(`/v1/documents/${doc}/connect`, t.apiKey);
    expect(r.json).toMatchObject({ node: '', source: 'entry' });
  });
});

describe('the connect hint needs view (BE-061 criterion 4)', () => {
  it('answers forbidden to a token that does not cover the document', async () => {
    const t = await start();
    const doc = await t.createDocument();
    const other = await t.createDocument();
    const r = await t.call(`/v1/documents/${doc}/connect`, t.userToken({ [other]: 'editor' }));
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: 'forbidden' });
  });

  it('answers a viewer, and not_found for a document that does not exist', async () => {
    const t = await start();
    const doc = await t.createDocument();
    const ok = await t.call(`/v1/documents/${doc}/connect`, t.userToken({ [doc]: 'viewer' }));
    expect(ok.status).toBe(200);
    const r = await t.call(`/v1/documents/${uuid7()}/connect`, t.apiKey);
    expect(r.status).toBe(404);
  });
});
