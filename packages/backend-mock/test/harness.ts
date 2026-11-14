// The contract harness for backend-mock: each call is the in-memory equivalent of the
// service-credential call the harness interface names (05 §11 bootstrap contract).
import type { ContractHarness, HarnessFactory } from '@docedit/protocol/contract';
import { MockService, type MockServiceOptions } from '../src/index.ts';

export function mockHarness(opts: MockServiceOptions = {}): HarnessFactory {
  return async (): Promise<ContractHarness> => {
    const service = new MockService(opts);
    return {
      createDocument: async (content, o) =>
        service.createDocument(content, o?.grants ? { grants: o.grants } : {}),
      backend: async (user, docs) => service.backend(user, docs),
      setGrants: async (docId, grants) => service.setGrants(docId, grants),
      replaceContent: async (docId, content) => service.replaceContent(docId, content),
      setDocumentState: async (docId, state) => service.setDocumentState(docId, state),
      revokeSessions: async (sub) => service.revokeSessions(sub),
      denyTokens: (sub) => service.denyTokens(sub),
      holdWrites: (docId) => service.holdWrites(docId),
      checkpoint: (docId) => service.checkpoint(docId),
      advanceClock: async (ms) => service.advanceClock(ms),
      dispose: () => service.dispose(),
    };
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
