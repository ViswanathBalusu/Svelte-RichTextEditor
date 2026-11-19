// FRW-046 criterion 1, the client's half: the fields port of backend-dep is present only while
// `fields` is negotiated, and `sign` posts the adopted image to the field's sign route with the bearer
// token and nothing else. The in-memory network records the wire. Universal: Node.js and browsers.
import { describe, expect, it } from 'vitest';
import { createDepBackend } from './index.ts';
import { LEGAL_GRANT, USERS, contractDocument } from '../test/support/fixtures.ts';
import { MemoryNetwork, type MemoryServer } from '../test/support/memory-network.ts';
import { MockDepServer } from '../test/support/mock-server.ts';

interface Call {
  method: string;
  path: string;
  auth: string;
  body: string | undefined;
}

function fieldsServer(opts: { features?: boolean } = {}) {
  const base = new MockDepServer({
    welcome: (d) => {
      const rest = (d['features'] as string[]).filter((f) => f !== 'fields');
      return { ...d, features: opts.features === false ? rest : [...rest, 'fields'] };
    },
  });
  const calls: Call[] = [];
  const server: MemoryServer = {
    accept: (socket) => base.accept(socket),
    async http(req) {
      const url = new URL(req.url);
      if (!/^\/v1\/documents\/[^/]+\/fields\/[^/]+\/sign$/.test(url.pathname))
        return base.http(req);
      calls.push({
        method: req.method,
        path: url.pathname,
        auth: (req.headers['authorization'] ?? '').replace(/Bearer .*/, 'Bearer ...'),
        body: typeof req.body === 'string' ? req.body : undefined,
      });
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      };
    },
  };
  return { base, server, calls };
}

function backendFor(f: ReturnType<typeof fieldsServer>, docId: string) {
  const net = new MemoryNetwork(f.server);
  return createDepBackend({
    endpoint: f.base.endpoint,
    getToken: async () => f.base.mintToken(USERS.editor, { [docId]: 'editor' }),
    features: ['presence', 'regions', 'suggest-enforced', 'fields'],
    platform: { random: () => 0, ...net.platform() },
  });
}

describe('the fields port of backend-dep (FRW-046 criterion 1)', () => {
  it('is present only while `fields` is negotiated', async () => {
    const off = fieldsServer({ features: false });
    const a = backendFor(
      off,
      off.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] }),
    );
    await a.connect();
    expect(a.fields).toBeUndefined();
    await a.close();

    const on = fieldsServer();
    const b = backendFor(
      on,
      on.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] }),
    );
    await b.connect();
    expect(b.fields).toBeDefined();
    await b.close();
  });

  it('posts the adopted image to the sign route of the field, with the bearer token', async () => {
    const f = fieldsServer();
    const docId = f.base.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
    const b = backendFor(f, docId);
    await b.connect();
    await b.fields!.sign(docId, 'ff 1', { asset: 'asset-1', mode: 'typed' });
    expect(f.calls).toEqual([
      {
        method: 'POST',
        path: `/v1/documents/${docId}/fields/ff%201/sign`,
        auth: 'Bearer ...',
        body: JSON.stringify({ asset: 'asset-1', mode: 'typed' }),
      },
    ]);
    await b.close();
  });
});
