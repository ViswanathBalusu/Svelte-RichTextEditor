# ADR 0153: Control plane lane 4, backlog batch (HIS-history, service side)

Status: proposed. Owner decisions are not made here; each open point below uses the spec's default and says so.

## Context

Lane control-plane-4 worked the service side of the HIS epic from the end of its slice (HIS-022 backwards). Most stories in HIS-006 to HIS-022 already have ticked criteria, so they were not claimed. Of the rest, only HIS-022 had criteria that the service in `services/document-service/src/control-plane` could meet.

## Decisions taken in this batch

1. **Name of "whether grants are copied" (HIS-022 criterion 3; gap G69).** The fork request takes an optional boolean `copyGrants`, default `false`. A fork without it has no grants; with `true` it keeps the source's grants (regions, principals, roles) and nothing else: approvals, leases and the workflow state are not copied. Default: the spec leaves the name open (05 §6.2; the protocol's `ForkRequest` has no such member). The protocol definition in `packages/protocol` must name it before the contract suite can check it.
2. **Fork content.** The copy's content is the source's content at `atSeq`, stored as its checkpoint at seq 0, as `createDocument` does (D67). The copy has no title unless a later `PATCH` sets one. Default: the spec names no title rule.
3. **Who may fork.** Only a service credential (05 §8.1; `de-fork-request` is raised by the component and the host calls the route). A user credential gets `forbidden`.

## Not built here (stay unticked in HIS-022)

- `forked_from` and `forked_at_seq` are not recorded: the migration `0002_documents_and_log.sql` has the columns, but `DocumentStore.create` and the memory store take no fork fields. Needs a change in `services/document-service/src/storage` (another lane).
- The `DEP-Actor` gate (criterion 4) needs the acting user's role on the source, which a service credential does not carry. Needs a rule decision (08 §7 and 07 §8 do not say which role to use).
- Asset attachment (criterion 5): an asset row names one document, so the copy cannot share an asset id. Needs a storage decision on shared asset rows (06 §4.4).
- HIS-021 (dry run through the service) and HIS-018 to HIS-020 (apply path) need `@docedit/history` (`planRestore`) in `services/document-service/package.json`, which is a root or package change this lane may not make. Needs the main session.
- HIS-008, HIS-006 and HIS-016 service routes need the history package's `groupCommits`, `createVersion` and field history, for the same reason, plus a versions store that the storage layer does not have.

## Consequences

- `services/document-service/src/control-plane/history-routes.ts` serves `forkDocument`, wired in `handlers.ts`.
- `services/document-service/src/control-plane/history-routes.test.ts` runs five memory-storage tests (criteria 2 in part, 3, 6, and the refusals).
