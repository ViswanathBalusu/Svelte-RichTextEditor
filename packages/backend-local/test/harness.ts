// The contract harness for backend-local: each call is the local equivalent of the
// service-credential call the harness interface names (05 §11 bootstrap contract).
import type { ContractHarness, HarnessFactory } from '@docedit/protocol/contract';
import { LocalService, type LocalServiceOptions, type LocalStore } from '../src/index.ts';

export function localHarness(
  makeStore: () => LocalStore,
  opts: Omit<LocalServiceOptions, 'channel'> = {},
): HarnessFactory {
  return async (): Promise<ContractHarness> => {
    const service = await LocalService.open(makeStore(), { ...opts, channel: null });
    return {
      createDocument: async (content, o) =>
        service.create(content, o?.grants ? { grants: o.grants } : {}),
      backend: async (user, docs) => service.backend(user, docs),
      setGrants: async (docId, grants) => {
        service.setGrants(docId, grants);
        await service.flush();
      },
      replaceContent: async (docId, content) => service.replace(docId, content),
      setDocumentState: async (docId, state) => {
        service.setDocumentState(docId, state);
        await service.flush();
      },
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
