// backend-dep over a real network in Node.js (PRO-093, PRO-094): the platform's global WebSocket and
// fetch against an HTTP and WebSocket server on 127.0.0.1, with the DEP server built on
// backend-mock behind it. The port contract and the smoke suite of the `core` profile run here as
// they run over the in-memory network, and the socket-level facts are checked on the server side:
// the subprotocol it selected and the close code it received.
import { describe, expect, it } from 'vitest';
import {
  coreSmoke,
  portContract,
  type ContractCase,
  type ContractHarness,
  type HarnessFactory,
} from '@docedit/protocol/contract';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import { USERS, contractDocument, LEGAL_GRANT } from './support/fixtures.ts';
import { sleep } from './support/harness.ts';
import { MockDepServer } from './support/mock-server.ts';
import { listen } from './support/node-server.ts';

function nodeHarness(): HarnessFactory {
  return async (): Promise<ContractHarness> => {
    let mock!: MockDepServer;
    const net = await listen((origin) => (mock = new MockDepServer({ origin })));
    const backends: DepBackend[] = [];
    return {
      createDocument: async (content, o) =>
        mock.service.createDocument(content, o?.grants ? { grants: o.grants } : {}),
      backend: async (user, docs) => {
        const b = createDepBackend({
          endpoint: net.origin,
          getToken: async () => mock.mintToken(user, docs),
          platform: { random: () => 0 },
        });
        backends.push(b);
        return b;
      },
      setGrants: async (docId, grants) => mock.service.setGrants(docId, grants),
      replaceContent: async (docId, content) => mock.service.replaceContent(docId, content),
      setDocumentState: async (docId, state) => mock.service.setDocumentState(docId, state),
      revokeSessions: async (sub) => mock.service.revokeSessions(sub),
      denyTokens: (sub) => mock.service.denyTokens(sub),
      holdWrites: (docId) => {
        const inner = mock.service.holdWrites(docId);
        return {
          release: async () => {
            await sleep(30);
            await inner.release();
          },
          fail: async () => {
            await sleep(30);
            await inner.fail();
          },
        };
      },
      checkpoint: (docId) => mock.service.checkpoint(docId),
      advanceClock: async (ms) => mock.service.advanceClock(ms),
      dispose: async () => {
        for (const b of backends) await b.close();
        await mock.service.dispose();
        await net.close();
      },
    };
  };
}

const register = (cases: readonly ContractCase[]) => {
  for (const k of cases)
    it(`${k.id}: ${k.title}`, (ctx) => k.run({ skip: (reason) => ctx.skip(reason) }));
};

describe('backend-dep over a real socket: port contract', () => {
  register(portContract(nodeHarness(), { sleep, timeoutMs: 8000 }));
});

describe('backend-dep over a real socket: smoke suite for the core profile', () => {
  register(coreSmoke(nodeHarness(), { sleep, timeoutMs: 8000 }));
});

describe('the socket itself (05 §4; PRO-093)', () => {
  it('is opened with dep.v1, closed with 1000, and leaves no timer behind', async () => {
    let mock!: MockDepServer;
    const net = await listen((origin) => (mock = new MockDepServer({ origin })));
    try {
      const docId = mock.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
      const minted: string[] = [];
      const b = createDepBackend({
        endpoint: net.origin,
        getToken: async () => {
          const t = mock.mintToken(USERS.editor, { [docId]: 'editor' });
          minted.push(t);
          return t;
        },
      });
      await b.connect();
      const c = await b.sync.loadContent(docId);
      await b.sync.open(docId, { resume: { seq: c.seq, incarnation: c.incarnation } });
      await b.close();
      for (let i = 0; i < 100 && net.closes.length === 0; i++) await sleep(10);
      expect(net.protocols).toEqual(['dep.v1']);
      expect(net.closes).toEqual([1000]);
      expect(b.timers.size).toBe(0);
      for (const r of net.requests) for (const t of minted) expect(r.url.includes(t)).toBe(false);
      expect(
        net.requests.filter((r) => r.headers['authorization']?.startsWith('Bearer ')),
      ).toHaveLength(1);
    } finally {
      await mock.service.dispose();
      await net.close();
    }
  });
});
