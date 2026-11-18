/**
 * `@docedit/backend-local`: the backend ports on a local IndexedDB store, with no server
 * (05 §8.3; PRO-100). It runs the project's own authority package in the page, through
 * `@docedit/backend-mock`, and keeps the log in a store that survives a reload. Tabs of one
 * browser profile follow each other through a `BroadcastChannel`.
 *
 *   const service = await LocalService.open(new IndexedDbStore('my-documents'));
 *   const docId = await service.create(content, { grants });
 *   const backend = service.backend({ sub: 'u1' }, { [docId]: 'editor' });
 *
 * This proves independence from the transport and the server. It does not prove independence from
 * the document semantics: the authority package decides here too (05 §8.3).
 */
export { LocalService, type LocalServiceOptions } from './service.ts';
export { IndexedDbStore } from './idb.ts';
export { MemoryStore, LOCAL_EPOCH, type LocalStore } from './store.ts';
