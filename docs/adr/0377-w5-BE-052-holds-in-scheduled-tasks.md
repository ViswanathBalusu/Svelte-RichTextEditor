# ADR 0377: Legal holds in scheduled tasks (BE-052 criterion 4)

Status: proposed (lane w5, 2026-11-17). Answers question Q4 of ADR 0104.

## Context

08 §11 says a legal hold suspends thinning and purge for a document. HIS-031 stores a hold on a
document. The scheduler's `onHold(tenant)` hook is a tenant-level switch: wired to a document hold, it would stop every deleting task for the whole tenant. It was therefore never wired in `src/server.ts`.

## Decision (proposed)

- A hold is honoured per document. The scheduler gets an option `heldDocuments(tenant)`, wired in
  `src/server.ts` to the hold service.
- A task marked `deletes` is given `scope.held`, the tenant's held documents read just before its
  run for that tenant, and keeps the data of those documents. Other tasks get an empty set and the
  hold source is not read for them.
- The abandoned-upload sweep (BE-046) uses it. Tasks that arrive later (HIS-029, HIS-030, HIS-032,
  HIS-039) take the same argument.
- Idempotency keys and audit partitions are not document data and are not held. 08 §11 speaks of
  history and documents, so this reading is the proposal's, not the owner's.
- `onHold(tenant)` stays as a tenant-level switch for a whole-tenant freeze. Nothing wires it.

## Consequences

A hold on one document never stops maintenance for the rest of the tenant. A task for a tenant
sets that tenant's context through its store (`inTenant`), so a hold of one tenant never keeps
another tenant's data. The owner may instead want holds to cover idempotency keys; that is a
change to which tasks read `scope.held`, not to the mechanism.
