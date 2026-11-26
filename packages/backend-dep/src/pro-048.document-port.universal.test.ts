// PRO-048 criteria 2 and 3, the client's half: `sync.document` reads `GET /documents/{id}`, returns
// the label with the ETag, and ignores a field it does not know (PRO-005). The in-memory network
// answers the one route; everything else goes to the mock server. Universal.
import { describe, expect, it } from 'vitest';
import { createDepBackend } from './index.ts';
import { USERS, contractDocument } from '../test/support/fixtures.ts';
import { MemoryNetwork, type MemoryServer } from '../test/support/memory-network.ts';
import { MockDepServer } from '../test/support/mock-server.ts';

function documentServer(answer: (docId: string) => Record<string, unknown>) {
  const base = new MockDepServer();
  const calls: Array<{ method: string; path: string; auth: string }> = [];
  const server: MemoryServer = {
    accept: (socket) => base.accept(socket),
    async http(req) {
      const url = new URL(req.url);
      const m = /^\/v1\/documents\/([^/]+)$/.exec(url.pathname);
      if (!m || req.method !== 'GET') return base.http(req);
      calls.push({
        method: req.method,
        path: url.pathname,
        auth: (req.headers['authorization'] ?? '').replace(/Bearer .*/, 'Bearer ...'),
      });
      return {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"m3"' },
        body: JSON.stringify(answer(decodeURIComponent(m[1]!))),
      };
    },
  };
  return { base, server, calls };
}

function resource(docId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: docId,
    externalId: null,
    title: null,
    properties: {},
    classification: 'Internal use only',
    state: 'active',
    cdm: 1,
    requires: [],
    createdAt: '2026-11-18T10:00:00.000Z',
    ...extra,
  };
}

describe('the document read of backend-dep (PRO-048)', () => {
  it('returns the label with the ETag, with the bearer token and no body', async () => {
    const f = documentServer((id) => resource(id, {}));
    const docId = f.base.service.createDocument(contractDocument());
    const net = new MemoryNetwork(f.server);
    const b = createDepBackend({
      endpoint: f.base.endpoint,
      getToken: async () => f.base.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
    await b.connect();
    const got = await b.sync.document!(docId);
    expect(got.value.classification).toBe('Internal use only');
    expect(got.etag).toBe('"m3"');
    expect(f.calls).toEqual([
      { method: 'GET', path: `/v1/documents/${docId}`, auth: 'Bearer ...' },
    ]);
    await b.close();
  });

  it('ignores a field it does not know (criterion 3)', async () => {
    const f = documentServer((id) => resource(id, { futureField: { nested: [1, 2] } }));
    const docId = f.base.service.createDocument(contractDocument());
    const net = new MemoryNetwork(f.server);
    const b = createDepBackend({
      endpoint: f.base.endpoint,
      getToken: async () => f.base.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
    await b.connect();
    const got = await b.sync.document!(docId);
    expect(got.value.classification).toBe('Internal use only');
    expect(got.value.state).toBe('active');
    await b.close();
  });

  it('reads a document with no label as null', async () => {
    const f = documentServer((id) => resource(id, { classification: null }));
    const docId = f.base.service.createDocument(contractDocument());
    const net = new MemoryNetwork(f.server);
    const b = createDepBackend({
      endpoint: f.base.endpoint,
      getToken: async () => f.base.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
    await b.connect();
    expect((await b.sync.document!(docId)).value.classification).toBeNull();
    await b.close();
  });
});
