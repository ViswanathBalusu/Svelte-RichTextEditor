# @docedit/backend-local

The backend ports on a local IndexedDB store, with no server (05 §8.3; PRO-100). A page that
only has a browser can embed the editor, keep its documents across reloads and open the same
document in several tabs.

```ts
import { LocalService, IndexedDbStore } from '@docedit/backend-local';

const service = await LocalService.open(new IndexedDbStore('my-documents'));
const docId = await service.create(content, { grants });
const backend = service.backend({ sub: 'u1' }, { [docId]: 'editor' });
await backend.connect();
```

## What it is

- The project's own authority package runs in the page, through `@docedit/backend-mock`. Roles,
  regions, suggestions and the step rules are decided by the same code as on a server.
- The log lives in IndexedDB: one row per document (incarnation, permission state, segments) and
  one row per commit. A write is one transaction, conditional on the head it extends and on the
  grants revision it was checked against, and it asks for strict durability. A commit is
  acknowledged only after the store holds it.
- Tabs of one browser profile share the store. After a tab stores something it posts the new head
  on a `BroadcastChannel`. The other tabs read the store, build the room again and let every open
  channel resume where it was, so the commit arrives in order. If two tabs write at once, the
  store takes one commit for each sequence number; the other tab's channels close with
  `unavailable`, reconnect and resubmit, as after any lost race (04 §5).
- It passes the same port contract suite as `backend-mock` and `backend-dep`
  (`@docedit/protocol/contract`), unchanged.

## What it is not

- It is not offline-first editing (assumption A1). There is no synchronisation with a server.
- It proves independence from the transport and the server. It does not prove independence from
  the document semantics, because it runs the project's own authority package.
- A store is the data of one browser profile. Clearing site data removes the documents.
- It has no host calls that need a second process: no prefill by key, no workflow, no export.

## Tests

- `test/contract.test.ts`: the contract and smoke suites over a memory store, in Node.js.
- `test/local.test.ts`: the scenarios of `test/scenarios.ts` over a memory store, in Node.js.
- `src/local.universal.test.ts`: the same suites and scenarios over IndexedDB, in Chromium,
  Firefox and WebKit (`pnpm test:browsers`). It skips in Node.js, which has no IndexedDB.
