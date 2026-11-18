/**
 * `@docedit/backend-mock`: an in-memory backend for tests and demos (05 §8.3; PRO-099). It runs
 * the real authority (`Room` from @docedit/authority) in process over an in-memory log, and
 * implements the core ports and the `presence` port of @docedit/protocol. Universal: no Node.js or
 * browser API, so it runs in a page, a worker or a test.
 *
 *   const service = new MockService();
 *   const docId = service.createDocument(content, { grants });
 *   const backend = service.backend({ sub: 'u1' }, { [docId]: 'editor' });
 *   await backend.connect();
 */
export {
  MockService,
  TOKEN_LIFETIME_MS,
  type MockServiceOptions,
  type MockUser,
} from './service.ts';
export { MockBackend, type MockBackendOptions, type MockToken } from './backend.ts';
export { MockDocument, type GrantSpec } from './document.ts';
export { MockChannel } from './channel.ts';
export { MemoryLog } from './storage.ts';
export { PersistedLog, type SegmentLog } from './storage.ts';
export {
  packPerms,
  unpackPerms,
  type DocumentPersistence,
  type DocumentRecord,
  type RestoredDocument,
  type SegmentRecord,
  type StoredEntry,
  type StoredPerms,
} from './persist.ts';
export type { DocumentHooks } from './document.ts';
