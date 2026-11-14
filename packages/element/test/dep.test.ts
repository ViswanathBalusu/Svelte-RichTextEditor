// The element's load sequence over the real DEP client (packages/backend-dep) and a DEP server in
// memory (backend-dep's test support: discovery and REST over an in-memory fetch, the socket over
// an in-memory WebSocket, the mock service behind them): PRO-074 criterion 1 and PRO-075
// criterion 1. The server and network are backend-dep's test helpers (agent B3), imported by path.
import { createDepBackend } from '@docedit/backend-dep';
import { describe, expect, it } from 'vitest';
import { MemoryNetwork } from '../../backend-dep/test/support/memory-network.ts';
import { MockDepServer } from '../../backend-dep/test/support/mock-server.ts';
import { endpointBackend, setEndpointBackendFactory } from '../src/backend-source.ts';
import { Session } from '../src/session.ts';
import {
  LEGAL_GRANT,
  USERS,
  contractDocument,
  fakeEditor,
  names,
  recordingHost,
  settle,
} from './support.ts';

function server() {
  const s = new MockDepServer();
  const net = new MemoryNetwork(s);
  const docId = s.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  return { s, net, docId };
}

describe('Session over the DEP client', () => {
  it('reads discovery from the endpoint, connects, loads and raises de-ready; getToken gets { docId }', async () => {
    const { s, net, docId } = server();
    const calls: unknown[] = [];
    const getToken = async (ctx: { docId?: string }) => {
      calls.push(ctx);
      return s.mintToken(USERS.editor, { [docId]: 'editor' });
    };
    // The element's own path from an endpoint to a backend, with the network replaced.
    setEndpointBackendFactory((o) =>
      createDepBackend({
        endpoint: o.endpoint,
        getToken: o.getToken,
        docId: o.docId,
        platform: net.platform(),
      }),
    );
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({
      docId,
      backend: () =>
        endpointBackend({ endpoint: s.endpoint, getToken: (ctx) => getToken(ctx), docId }),
      ownsBackend: true,
      host,
      scheduler: (run) => queueMicrotask(run),
    });
    await session.start();
    await settle(20);
    expect(session.phase).toBe('ready');
    expect(names(host.events).slice(0, 2)).toEqual(['de-ready', 'de-permission-change']);
    expect(host.events[0]!.detail).toEqual({ docId, seq: 0 });
    expect(calls[0]).toEqual({ docId });
    // The content came over REST (in its canonical form, with every attribute present).
    expect(JSON.stringify(editor.mounted[0]!.doc)).toContain('Restricted text');
    await session.close();
    setEndpointBackendFactory(null);
  });

  it('calls getToken again when the server says the token expires (auth.expiring)', async () => {
    const { s, net, docId } = server();
    let calls = 0;
    const backend = createDepBackend({
      endpoint: s.endpoint,
      docId,
      getToken: async () => {
        calls++;
        return s.mintToken(USERS.editor, { [docId]: 'editor' });
      },
      platform: net.platform(),
    });
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const session = new Session({ docId, backend, ownsBackend: false, host });
    await session.start();
    expect(calls).toBe(1);
    // 15 minutes after issue the token ends; auth.expiring comes about a minute before (05 §5.1).
    s.service.advanceClock(14.5 * 60_000);
    await settle(100);
    expect(calls).toBe(2);
    expect(names(host.events)).not.toContain('de-auth-required');
    await session.close({ closeBackend: true });
  });

  it('raises de-error unavailable when discovery cannot be fetched', async () => {
    const editor = fakeEditor();
    const host = recordingHost(editor);
    const backend = createDepBackend({
      endpoint: 'https://unreachable.test',
      getToken: async () => 'token',
      platform: {
        fetch: async () => {
          throw new TypeError('network error');
        },
      },
    });
    const session = new Session({ docId: 'd1', backend, ownsBackend: true, host });
    await session.start();
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({
      name: 'de-error',
      detail: { code: 'unavailable', fatal: true },
    });
  });
});
