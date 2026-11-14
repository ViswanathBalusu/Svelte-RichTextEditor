# ADR 0006: PostgreSQL plus object storage; no document database

**Status:** proposed, 2026-09-18.

## Context

The question was "SQL or NoSQL". The data falls into classes with different needs:

| Data | Access pattern |
|---|---|
| Tenants, documents, grants, region states, threads, comments, versions, jobs, audit | Relational, transactional, constrained, queried many ways |
| Commit log | Append-only, read by document and sequence range, never queried by content |
| Checkpoints, assets, exports | Large immutable blobs read by key |
| Presence, leases, rate limits | Ephemeral |
| Search | Full-text, derived |

Evidence gathered on 2026-09-18: Figma keeps document state in memory per open file, journals changes and checkpoints to object storage, and keeps metadata in PostgreSQL, which it chose to shard rather than replace because its data is relational. Notion scaled on sharded PostgreSQL. Microsoft's Fluid relay uses MongoDB only as an operation store. A changed `bytea` value in PostgreSQL is rewritten in full, so rewriting a whole document on every save is the pattern to avoid, not PostgreSQL itself.

## Decision

- PostgreSQL is the system of record for all relational data and, at first, for the commit log (hash-partitioned by document, payloads compressed).
- Object storage holds checkpoints, cold log segments, assets and exports.
- Redis or Valkey is added at stage 2 for presence, the internal bus and rate limits, and is never a source of truth.
- The job queue starts as a PostgreSQL table.
- No document database.

The commit log sits behind a `LogStore` interface so it can move to a log-optimised store if insert rate demands it.

## Consequences

Good:
- Two stateful dependencies at stage 1.
- Transactions and constraints where integrity matters most: grants and history metadata.
- The log's primary key doubles as the fencing mechanism against two writers.
- Storage cost is dominated by cheap object storage.

Bad:
- Insert rate on the log is the first database limit at large scale. The response is sharding by tenant or moving the log, both planned for.
- Hash partitioning makes time-based retention a job instead of a partition drop.

## Alternatives considered

| Alternative | Why not |
|---|---|
| MongoDB for documents | A Word document is not a database document: the body is never queried by field, and there is a 16 MB limit per document. The relational part would lose constraints and multi-row transactions |
| DynamoDB or Cassandra for the log from day one | Sound at Figma's scale; an extra system long before it is needed |
| Whole document rewritten in a row on each save | Write amplification in storage and replication; no history |
| Distributed SQL from day one | Needed only for multi-region writes, which the home-region design avoids |
| Kafka as the log | Good ordering, poor per-document random reads, heavy to operate |

## After the first review (2026-09-18)

- The claim that storage cost is dominated by object storage was wrong for a keystroke-level log kept hot for 180 days. Payloads now move to cold segments after 30 days, commit metadata and payload are separate tables, position maps are derived instead of stored, per-scope history uses a side table instead of an index on the log, and checkpoints are time-based and thinned.
- The hot write path touches a narrow head row, not the wide document row. The write transaction checks the ownership epoch and the grants revision, so fencing and authorisation freshness are properties of the store. Any replacement log store must offer the same conditional append.
- A database recovery that rewinds the log would silently reassign sequence numbers. Logs have an incarnation, hosted mode replicates the log synchronously, and recovery objectives are stated.
- Every table carries the tenant identifier, idempotency keys are scoped to the caller, and user identifiers are per-tenant surrogates.
- Stage 1 is a single room-host process with worker threads, which needs no bus.

## Revisit when

Sustained log inserts approach what one primary handles, or a tenant requires multi-region writes.
