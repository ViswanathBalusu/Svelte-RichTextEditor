# ADR 0385: Per-document encryption keys (HIS-041)

Status: proposed. The owner decided to build the feature (decision 43 in `docs/owner-decisions-2026-11-15.md`); the design below is the developer's and is not reviewed. Lane w7, 2026-11-17.

## Context

Spec 08 §13 says optional per-document encryption keys allow deletion by destroying the key. 06 §12 has per-tenant keys in the key service; `EncryptedObjectStore` (BE-041) seals objects per tenant. Nothing was per document.

## Decision (proposed)

- Two levels. The key encryption key (KEK) is an `unwrap` key of the key service, `document-<doc>`. The data key (DEK) is one AES-256-GCM key per document, stored only wrapped with the KEK in `document_keys` (migration 0075). A reader unwraps it through the key service on each read call, so an outage of the key service makes the document unavailable and never readable without the key.
- Sealed with the DEK: the payload of each commit and the content of each snapshot commit (PostgreSQL, `PgLogStore`), and every object under `tenants/<t>/docs/<d>/` (checkpoints, cold segments, set-aside checkpoints; `DocumentKeyedObjectStore`). The envelope is `DKS1`, a 12-byte IV and the AES-GCM ciphertext; the place is the additional data.
- Not sealed: the commit rows, the payload hashes and the chain. The chain covers the hash of the plain payload, so it verifies after the key is destroyed.
- `KeyService.destroy` removes the KEK for good and keeps the identifier taken. `DocumentKeys.destroy` calls it, then marks the row destroyed and drops the wrapped DEK. A copy of the table or of an object taken before holds only sealed data and a wrapped DEK that nothing can unwrap.
- A key is given only while the log is empty (head seq 0), so no commit is ever written in the clear. The content the document was created with (an object at seq 0) is sealed at that moment.
- The option is per tenant (`tenant_document_keys`, off by default). With it off the service gives no key, and the rest of the tenant's documents are read and written as before. A tenant that turns it off later keeps the keys it already has.
- A destroyed key answers `not_found` ("the key of this document was destroyed") and an unreachable key service answers `unavailable`, on every route that needs content, which includes the history list (it projects with the head content).

## Not decided, and not built

- No REST route to give or destroy a key. A route changes the protocol (DEP), so it needs the owner and the protocol lane. The operations are `DocumentKeys.provision`, `destroy` and `setTenantOption`, on `service.parts.documentKeys`.
- No audit event for giving or destroying a key yet.
- No KMS-backed key service: only `MemoryKeyService` implements `destroy`. A real one must make destruction irreversible in every replica and backup of the key service itself.
- The title and properties of a document, the search index, the outbox, comments, assets and export files are not sealed. A document that needs those gone is purged (HIS-039). The purge removes the key row but not the KEK in the key service.
- Giving a key to a document that has history is refused. Re-sealing history would need an update of payload rows, which the service role may not do.
- Cost: one RSA-OAEP unwrap per read call and per object read or write. It is not measured.
