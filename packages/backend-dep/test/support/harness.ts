/**
 * The contract harness for backend-dep against the DEP server built on backend-mock (05 §11
 * bootstrap contract): documents, grants, content and revocations go to the in-memory service as a
 * host's service-credential calls would; every backend is a real `DepBackend` that reaches the
 * server only through the in-memory network, frame by frame.
 */
import type { ContractHarness, HarnessFactory } from '@docedit/protocol/contract';
import { createDepBackend, type DepBackend, type DepBackendOptions } from '../../src/index.ts';
import { MemoryNetwork } from './memory-network.ts';
import { MockDepServer, type MockDepServerOptions } from './mock-server.ts';

export interface DepHarness extends ContractHarness {
  readonly server: MockDepServer;
  readonly network: MemoryNetwork;
  readonly backends: readonly DepBackend[];
}

export interface DepHarnessOptions {
  server?: MockDepServerOptions;
  backend?: Partial<DepBackendOptions>;
  /** Called with each harness, for tests that keep a handle on it. */
  created?: (h: DepHarness) => void;
}

export function depHarness(opts: DepHarnessOptions = {}): HarnessFactory {
  return async (): Promise<DepHarness> => {
    const server = new MockDepServer(opts.server);
    const network = new MemoryNetwork(server);
    const backends: DepBackend[] = [];
    const h: DepHarness = {
      server,
      network,
      backends,
      createDocument: async (content, o) =>
        server.service.createDocument(content, o?.grants ? { grants: o.grants } : {}),
      backend: async (user, docs) => {
        const b = createDepBackend({
          endpoint: server.endpoint,
          getToken: async () => server.mintToken(user, docs),
          platform: network.platform(),
          ...opts.backend,
        });
        backends.push(b);
        return b;
      },
      setGrants: async (docId, grants) => server.service.setGrants(docId, grants),
      replaceContent: async (docId, content) => server.service.replaceContent(docId, content),
      setDocumentState: async (docId, state) => server.service.setDocumentState(docId, state),
      revokeSessions: async (sub) => server.service.revokeSessions(sub),
      denyTokens: (sub) => server.service.denyTokens(sub),
      holdWrites: (docId) => {
        // Over a network a submit reaches the room a little later than over the mock's ports: let
        // frames in flight arrive before the held writes are released or failed.
        const inner = server.service.holdWrites(docId);
        return {
          release: async () => {
            await sleep(5);
            await inner.release();
          },
          fail: async () => {
            await sleep(5);
            await inner.fail();
          },
        };
      },
      checkpoint: (docId) => server.service.checkpoint(docId),
      advanceClock: async (ms) => server.service.advanceClock(ms),
      dispose: async () => {
        for (const b of backends) await b.close();
        await server.service.dispose();
      },
    };
    opts.created?.(h);
    return h;
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
