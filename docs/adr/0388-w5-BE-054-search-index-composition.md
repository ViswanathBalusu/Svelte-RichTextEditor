# ADR 0388: The search index in the composed service (BE-054)

**Status:** proposed, 2026-11-18, lane w5. The spec names the indexer (06 §1) and `GET /search` (05 §6.2) and leaves the composition open. Each choice below is the spec's default or the smallest choice that meets the criteria. The owner decides whether to keep it. ADR 0243 holds the design of the index itself.

## Decisions

1. **Off by default.** `DOCEDIT_SEARCH_INDEX` (`config.searchIndex`) is false. When it is on, every stored checkpoint queues an indexer job and the service offers `GET /search`. The index copies the words of every document into more tables, which erasure and purge must then reach (SEC-045, SEC-057, HIS-039), so a deployment chooses it. The owner may make it the default.
2. **Only the class `full` is indexed.** The route answers a service credential, and a service credential reads the full document (ADR 0019). The acting-user filter and the document-level `view` check stay unbuilt (ADR 0243).
3. **The queue is the trigger.** The data plane calls `onCheckpoint(ref, seq)` after each checkpoint it stores (`Checkpointer.save`); the composition queues a `search-index` job for the tenant of the document. A failure of the call is reported by name and never fails the checkpoint.
4. **Counting is off the event loop.** The job counts the words in a worker thread (`searchTokens` task, `data-plane/tasks.ts`) of a pool the composition makes for it: one thread, 30 seconds a task. Both numbers are proposed defaults, not measurements. The database write is asynchronous input and output on the job runner of the same process.
5. **Tables.** Migration 0086 creates `search_entries` and `search_tokens` with `tenant_id`, forced row-level security and the tenant policy (BE-011). `doc_id` is not a reference to `documents`, so the order of a purge cannot fail on it; the purge calls the index (`searchPurge`) and the purge role may also delete from both tables.
6. **Purge order.** The purge deleted `outbox` after `doc_heads`, which `outbox` references, so a document with an outbox row could not be purged. `outbox` now goes first (`PURGE_TABLES`).

## Open for the owner

- Whether the index is on by default.
- Whether restricted classes are ever indexed for a service credential that names a user (ADR 0243).
