# ADR 0020: Storage of the commit log in PostgreSQL

**Status:** proposed, 2026-11-06. Records the decision of BE-008 and the choices made while building the PostgreSQL storage of `services/document-service` (BE-009, BE-010, BE-024). The hash-chain layout is provisional until HIS-002 publishes one with test vectors. The project owner has not reviewed any of it.

## Context

06 §4.1 sketches the tables; 06 §13 says the partition count of the log tables "is fixed at creation and chosen for stage 3" and gives no number. 08 §2 gives the hash formula but not the byte layout, the canonical form of the metadata or the previous hash of the first commit (HIS-002 notes). The room's write contract (`WriteRequest`, `WriteResult`, `StoredCommit` in `packages/authority/src/room/types.ts`) fixes what reaches storage.

## Decision

### Partition count (BE-008)

`doc_commits` and `doc_commit_payloads` are hash-partitioned on `doc_id` into **64** partitions. The count is set once, in `services/document-service/migrations/0002_documents_and_log.sql`.

- A power of two, so that a partition can later be split: PostgreSQL accepts hash partitions of different moduli when each modulus divides the next larger one, so partition *r* of 64 can be replaced by partitions *r* and *r* + 64 of 128, one partition at a time.
- Stage 3 shards by tenant (06 §6; BE-070), so no single database holds the logs of all 1,000,000+ documents.
- Every statement on the log names `doc_id`. The store sends unnamed statements, which PostgreSQL plans with the parameter values, so each prunes to one partition when it is planned and the partition count does not add locks to the write path.
- Not measured: the size of a partition at stage 3 volumes. BE-084 and BE-058 should confirm the count before the first production deployment; until then, changing it means editing the one constant.

Changing the count after deployment means either splitting partitions as above (detach, create the two halves, copy, attach, for each partition, inside a maintenance window or behind logical replication) or creating new tables and copying the whole log. Neither is an expand-and-contract migration (BE-016). `commit_scopes` is not partitioned, as in the sketch.

### Payload

The payload of a commit is the RFC 8785 JSON (`@docedit/model` `canonicalize`) of `{ steps, retired, claimed }`: the steps as applied, the region identifiers the commit retired and the suggestion identifiers it used first, which a room needs when it rebuilds from the log. It is stored Zstandard-compressed (`node:zlib`, default level), FND-005. A control commit has empty lists; the revision it records is its `access_rev`. `size` is the byte length of the canonical payload before compression.

### Hash chain (provisional, HIS-002)

`hash = SHA-256(prev ‖ M ‖ SHA-256(P))`, where

- `prev` is the `hash` of the commit at `seq − 1`, or 32 zero bytes for `seq` 1 (stored as `prev_hash` NULL);
- `M` is the UTF-8 of the RFC 8785 JSON of `{ doc, seq, kind, id, user, session, agent, time, origin, scopes, base, rebased, revision, jti, cdm, engine, size }`, with `time` in RFC 3339 UTC with milliseconds, `scopes` sorted by UTF-16 code units, and `null` for what is absent (today `agent`, `base`, `rebased` and `jti`, which `StoredCommit` does not carry);
- `P` is the canonical payload.

`doc_commits.payload_hash` keeps `SHA-256(P)`, so the chain still verifies after a payload is thinned, moved or erased. The head row's `chain_head` is the hash of the head commit and advances in the write transaction. `PgLogStore.verify` recomputes the chain from the stored rows.

### Departures from the 06 §4.1 sketch

| Point | Choice | Why |
|---|---|---|
| `doc_commits.session_id` | `text` | `StoredCommit.session` is a string; the simulation's sessions are not UUIDs |
| `doc_commits.payload_hash` | added | Verifying the chain after thinning (HIS-002 notes) |
| `tenant_id` and row-level security | on every table and every partition, forced, one policy on `docedit_current_tenant()` | 06 §4.1, §12; BE-011 |
| `grant_history (doc_id, rev, state jsonb, changed_by, changed_at)` | added | The whole permission state in force at each revision, written in the same transaction as the change: audits and the property tests' oracle read it (04 G7) |
| `grant_revisions.workflow_active` | added, provisional | `PermissionState.workflowActive` has no home until FRW's workflow tables |
| `region_states`, `region_leases` | created now (BE-015 is phase 2) | `PermissionState` holds them and every change of them raises the revision |
| Index `commit_scopes (doc_id, seq)` | added | Reading a commit's scopes back with the commit; per-scope history uses the primary key |
| Foreign keys | log rows reference the head row, payloads and scopes reference their commit; nothing on the write path references `documents` | Integrity without touching the wide row (BE-009) |
| Check constraints | principals of the four forms of 07 §1, region-grant roles of 07 §2, region identifiers of the CDM grammar, document and region states | BE-009, BE-010 |
| Service privileges | `SELECT` and `INSERT` only on the log tables, `grant_history` and `retired_regions` | Stored history is append-only for the service; thinning and erasure get their own role later |

### Retiring a region

The write that removes a region (a commit whose `retired` is not empty) inserts the region into `retired_regions` and deletes its grants, state and lease in the same transaction (07 §3; PRM-003). It does not raise the grants revision: no capability changes, because the identifier can never return (I3), and `grant_history` keeps what was in force at each revision. A trigger refuses any later grant, state or lease for a retired region (BE-010). A change and the retiring write are serialised on the revision row, so the trigger always sees a retirement that committed first.

### The write transaction

Four round trips: `BEGIN` with the tenant and a lock timeout; one statement that locks the head row `FOR UPDATE` and the revision row `FOR SHARE`; one statement that inserts the commits, payloads, scopes and retirements and advances the head; `COMMIT`. Measured on 2026-11-06 on the development machine (Windows 11, PostgreSQL 17.11 in the Podman WSL machine, node-postgres 8.23.1): 0.30 ms per round trip for 500 sequential `select $1`.

## Consequences

Good:
- Fencing, authorisation freshness and atomicity are properties of the store, as ADR 0006 requires of any log store.
- The service role cannot change stored history.

Bad:
- The partition count is a guess with stated reasoning, not a measurement.
- The hash-chain layout may change when HIS-002 is written; nothing is in production, so that is free now and expensive later.

## Alternatives considered

| Alternative | Why not |
|---|---|
| 32, 128 or 256 partitions | 32 leaves less room before a split; 128 or 256 add catalogue and migration cost in stage 1 for volumes nobody has measured |
| Scopes as a `text[]` column in `doc_commits` | Two homes for the same fact; 06 §4.1 keeps per-scope history in its own table |
| One PL/pgSQL function per write (one round trip) | Logic in SQL that the contract tests would reach only indirectly, for about a millisecond at the measured round-trip time |
| Retiring a region with a new grants revision | Every batch after a region deletion would be refused with `revision_moved` for a change that alters no capability |

## Revisit when

BE-084 or BE-058 measures partition sizes or planning cost, HIS-002 publishes the chain layout, or the room's `StoredCommit` gains `base`, `rebased`, `jti` and `agent`.
