# 06 Backend

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Informative. The protocol a backend must speak is normative in [05 Protocol](05-protocol.md); this document describes the reference implementation.

## 1. Services

| Service | State | Responsibility |
|---|---|---|
| Gateway | None beyond connections | Terminates WebSockets, verifies tokens, checks origins, applies per-address, per-connection and per-tenant rate limits, routes each channel to the room that owns the document |
| Room host | In-memory documents | Runs the authority of 04 for every open document it owns; persists commits; writes checkpoints; maps comment ranges; broadcasts; pushes permission and workflow changes |
| Control API | None | REST resources of 05 and 12. Reads straight from storage. Sends anything that must change a document to the owning room through an outbox |
| Export service | None | Converter and compile workers; see 09 |
| Signing service | None; keys in a key service | Seals final PDFs; see 12 |
| Asset worker | None | Validates and processes uploads in a sandbox |
| Indexer | None | Extracts text after checkpoints and updates search |
| Webhook dispatcher | None | Signs and delivers events with retries, through an egress proxy that refuses private addresses |
| Scheduler | None | Retention, thinning, purge, orphan cleanup, time-stamp renewal, expiries |

**Stage 1 is one room-host process.** It also serves the gateway and the control API. Work that would block its event loop runs in worker threads: checkpoint serialisation, log replay for content reads, comparisons, conversions. There is no forwarding between processes and no bus. Several room hosts, and the internal bus they need, arrive with stage 2. The tiers become separate deployables in stage 3.

## 2. Rooms

### 2.1 Ownership

One room owns an open document. Ownership is a row per document holding the owner's node identifier and an `epoch` that increases with every change of owner. A node may own rooms only while it holds a node-level liveness lease, which it renews every few seconds; expiry is judged by the database clock, never by comparing clocks of different machines. A node that cannot prove from its own monotonic clock that its lease is still valid stops serving all its rooms, including rooms with only viewers, which would otherwise never notice.

Every log write is one transaction that checks the writer's epoch on the document's head row and advances the head, and the log's primary key is (document, `seq`). A node that has lost ownership without noticing cannot append. This is the fencing mechanism; the lease only decides who should try. Any future log store must offer the same conditional append.

Routing finds the owner by rendezvous hashing of the document identifier over the live room hosts. From stage 2, a client can ask `GET /documents/{id}/connect` for the WebSocket URL of the owning node, so that in the normal case a channel lands where its room lives. A channel that lands elsewhere is forwarded over the internal bus, on reliable ordered streams with gap detection.

### 2.2 Lifecycle

1. **Open.** On the first channel for a document, acquire ownership, load the latest checkpoint from object storage, replay the log tail from PostgreSQL, derive the position maps of recent steps, and build the indexes (node identifiers, region ranges, definitions in use per region, fields, comment ranges). Load grants, region states, leases and the workflow.
2. **Serve.** Run the algorithm of 04, section 5, keeping a durable state and a tentative state.
3. **Checkpoint.** From the durable state only, write a checkpoint after 2,000 commits or ten minutes of activity, whichever comes first, but not more often than every two minutes; also around a snapshot commit and when the room closes with changes. Serialisation runs in a worker thread. A checkpoint holds the canonical document, the attribution map and the comment ranges, and its hash is verified against a replay before older checkpoints are thinned.
4. **Close.** Sixty seconds after the last channel closes: checkpoint if needed, release ownership, free memory. Under memory pressure only idle rooms are closed.
5. **Drain.** On deploy the host stops accepting channels, sends `goaway` with a jittered reconnect hint, flushes, checkpoints and releases its rooms.

Operations on documents that are not open (a prefill, a bulk import) run in a transient authority that loads, applies, stores and exits, without subscribers or timers.

### 2.3 Persist pipeline

Commits are validated and applied to the tentative state in arrival order and get tentative sequence numbers. One write is in flight per room; commits that arrive meanwhile join the next write. A write is one transaction that:

1. locks the document's head row, checks the ownership epoch and that the head is where the room believes it is;
2. reads the grants revision and compares it with the one the batch was checked against (04, G7);
3. inserts the commit rows and their payloads;
4. advances the head, and applies any side effects of control commits (for example retiring a deleted region's grants).

Acknowledgements and broadcasts are released in order when the transaction commits. If it fails, the room falls back to its durable state. If the outcome is unknown, it re-reads the log tail first. A conflict on a commit identifier is a duplicate submission and is handled as one; only an epoch or sequence conflict means another writer.

### 2.4 Fan-out

Each channel has a bounded send queue. A consumer that falls behind its bound gets `ch.closed` with `slow_consumer` and resumes from its last `seq`. For documents with very large audiences, viewers attach to follower nodes that subscribe to the room's ordered stream on the internal bus.

## 3. Control API behaviour

- Content reads do not need the room. Because a commit is visible only after it is stored, the head in PostgreSQL is always complete. The API serves the nearest checkpoint and lets the channel's catch-up cover the tail, or replays the tail in a worker thread when a caller needs content at an exact `seq`. Reads pinned to a `seq` are immutable and cacheable.
- Operations that change a document are written to an outbox with a deterministic commit identifier and delivered to the owning room, which applies them as server-authored commits and re-checks their preconditions. A retry cannot apply one twice, and a crash between the two systems cannot lose one.
- Grant and region-state changes are written to PostgreSQL with a new grants revision and announced to the room. If the announcement is lost, the persist transaction still refuses commits checked against the old revision.

## 4. Storage

### 4.1 PostgreSQL

Every table that holds tenant data carries `tenant_id` and is protected by row-level security. `node_leases` holds no tenant data (a lease names a node, not a tenant) and has neither (owner decision 195, ADR 0332); the sketch below omits the column for brevity except where it is part of a key. User identifiers in all tables are per-tenant surrogates (08, section 13).

```sql
create table documents (
  id uuid primary key, tenant_id uuid not null, external_id text, title text,
  properties jsonb not null default '{}', label text,
  state text not null default 'active',          -- active | locked | archived
  cdm_version int not null, requires text[] not null default '{}',
  history_visibility text not null default 'editors',
  forked_from uuid, forked_at_seq bigint,
  created_by text not null, created_at timestamptz not null, deleted_at timestamptz,
  unique (tenant_id, external_id));

create table doc_heads (                         -- narrow, hot row
  doc_id uuid primary key, head_seq bigint not null default 0,
  incarnation uuid not null, owner text, epoch bigint not null default 0,
  chain_head bytea);

create table doc_commits (                       -- metadata; kept for the life of the document
  doc_id uuid not null, seq bigint not null, kind text not null,   -- steps | control | snapshot
  commit_id uuid not null, user_id text not null, session_id uuid, agent text,
  server_ts timestamptz not null, origin text not null,
  base bigint, rebased boolean, access_rev bigint, token_jti text,
  cdm_version int not null, engine text not null, size int not null,
  prev_hash bytea, payload_hash bytea not null, hash bytea not null,   -- payload_hash: SHA-256 of the payload (08 §2)
  primary key (doc_id, seq),
  unique (doc_id, commit_id)
) partition by hash (doc_id);

create table doc_commit_payloads (               -- steps or control data; moves to cold segments
  doc_id uuid not null, seq bigint not null, payload bytea not null,   -- Zstandard-compressed JSON
  primary key (doc_id, seq)
) partition by hash (doc_id);

create table commit_scopes (                     -- per-region and per-field history
  doc_id uuid not null, scope text not null, seq bigint not null,
  primary key (doc_id, scope, seq));

create table doc_checkpoints (
  doc_id uuid not null, seq bigint not null, object_key text not null,
  bytes int not null, content_hash bytea not null, created_at timestamptz not null,
  primary key (doc_id, seq));

create table suggestion_introductions (          -- the commit that introduced each suggestion (08 §14; owner decision 86)
  tenant_id uuid not null, doc_id uuid not null, suggestion_id text not null, seq bigint not null,
  primary key (tenant_id, doc_id, suggestion_id));      -- the lowest seq wins; written in the transaction that stores the commit

create table versions (
  doc_id uuid not null, seq bigint not null, kind text not null,   -- named | export | restore | pre-restore | import | sent | completed
  name text, note text, created_by text not null, created_at timestamptz not null,
  primary key (doc_id, seq, kind));

create table region_grants (
  doc_id uuid not null, region_id text not null, principal text not null,  -- user:… | group:… | everyone | role:…
  role text not null, expires_at timestamptz, created_by text not null, created_at timestamptz not null,
  primary key (doc_id, region_id, principal));
create table grant_revisions (doc_id uuid primary key, rev bigint not null);
create table region_states (
  doc_id uuid not null, region_id text not null, state text not null,
  approved_seq bigint, content_hash bytea,
  changed_by text not null, changed_at timestamptz not null, primary key (doc_id, region_id));
create table region_leases (
  doc_id uuid not null, region_id text not null, lease_id uuid not null,
  holder text not null, acquired_at timestamptz not null, expires_at timestamptz not null,
  primary key (doc_id, region_id));
create table retired_regions (doc_id uuid not null, region_id text not null, retired_seq bigint not null, primary key (doc_id, region_id));

create table threads (
  id uuid primary key, doc_id uuid not null, scope text not null, state text not null,
  target jsonb not null, range_from int, range_to int, range_seq bigint,   -- current mapped range
  detached boolean not null default false, assignee text,
  created_by text not null, created_at timestamptz not null, resolved_by text, resolved_at timestamptz);
create table comments (
  id uuid primary key, thread_id uuid not null references threads, author text not null,
  body jsonb not null, created_at timestamptz not null, edited_at timestamptz, deleted_at timestamptz);

create table assets (
  id uuid primary key, tenant_id uuid not null, sha256 bytea, mime text not null,
  bytes bigint, state text not null,               -- quarantined | ready | failed
  object_key text, created_by text not null, created_at timestamptz not null);
create table doc_assets (doc_id uuid not null, asset_id uuid not null, first_seq bigint not null, primary key (doc_id, asset_id));

create table tenant_users (tenant_id uuid not null, sub text not null, surrogate text not null, display_name text,
  revoked_before timestamptz, primary key (tenant_id, sub), unique (tenant_id, surrogate));

create table jobs (
  id uuid primary key, tenant_id uuid not null, doc_id uuid, kind text not null, state text not null,
  payload jsonb not null, result jsonb, attempts int not null default 0,
  run_after timestamptz not null, locked_by text, locked_until timestamptz, created_at timestamptz not null);
create table idempotency_keys (
  tenant_id uuid not null, principal text not null, route text not null, key text not null,
  body_hash bytea not null, response jsonb, created_at timestamptz not null,
  primary key (tenant_id, principal, route, key));

create table outbox (id uuid primary key, doc_id uuid not null, commit_id uuid not null, request jsonb not null, state text not null, created_at timestamptz not null);
create table read_markers (doc_id uuid not null, user_id text not null, seq bigint not null, updated_at timestamptz not null, primary key (doc_id, user_id));
create table doc_sessions (                      -- per session: the user agent family and the client version (08 §2; owner decision 24)
  doc_id uuid not null, session_id text not null, user_id text not null,
  ua_family text not null, ua_major int, client_version text,   -- the header reduced to a family and a major version; no other column
  primary key (doc_id, session_id));                             -- written once, before the channel opens; removed with the document
create table audit_events (id uuid not null, tenant_id uuid not null, doc_id uuid, actor text not null, kind text not null, data jsonb not null, at timestamptz not null) partition by range (at);
```

Tables for tenants and their keys and origins, webhooks and deliveries, workflows, participants and evidence (12), and search are omitted here.

Notes:
- The head row is separate from the wide `documents` row so that the hot write path touches one narrow row.
- Commit metadata and payload are separate tables. Metadata stays for listing, filtering and the hash chain; payloads move to cold segments (08, section 11).
- Position maps are not stored. They are derived from the steps, which needs no document.
- Per-scope history uses the `commit_scopes` side table, not an index on the log.
- The job queue is a table in stage 1. Workers claim jobs with `FOR UPDATE SKIP LOCKED`.

### 4.2 Object storage

```
tenants/{tenant}/docs/{doc}/checkpoints/{seq}.cdm.json.zst
tenants/{tenant}/docs/{doc}/checkpoints/{seq}.side.json.zst          attribution map and comment ranges
tenants/{tenant}/docs/{doc}/segments/{fromSeq}-{toSeq}.payloads.zst  cold log payloads (08)
tenants/{tenant}/quarantine/{asset}                                  uploads before validation
tenants/{tenant}/assets/{sha256}
tenants/{tenant}/exports/{job}/…
tenants/{tenant}/final/{doc}/{workflow}.pdf                          sealed, write-once
```

Buckets use versioning, per-tenant encryption keys and replication to a second location. Database recovery and bucket versioning are not mutually consistent by themselves; the recovery procedure reconciles them from the log, which is the source of truth.

### 4.3 Redis or Valkey (from stage 2)

Presence fan-out between nodes, the internal bus for room forwarding and announcements (Valkey streams, section 16), rate-limit counters, follower streams. Nothing in it is a source of truth. Correctness never depends on an announcement arriving (section 2.3).

### 4.4 Assets

A client declares a file and gets a size-bound upload into the quarantine area. On `complete`, the asset worker checks the real type against the declared one, decodes and re-encodes the file in a sandbox, computes the hash itself, and alone writes the final, content-addressed object. Assets are scoped to a tenant. A document may reference an asset only if it is attached to that document: the authority attaches an asset when the submitting user uploaded it for that document or it is already attached, and rejects other references (invariant I4). Read access follows the attachment. Assets are immutable, so old versions always render with the images they had; an asset no document references is deleted after a retention period.

## 5. Why SQL and not a document database

Grants, threads, versions, workflows, jobs and the audit trail are relational and need transactions and constraints. The document body is never queried by field: it is read whole, by key, as a checkpoint plus a log tail. A document database therefore adds nothing for the body and takes away integrity for the rest. Figma and Notion both scaled collaborative products on sharded PostgreSQL for the same reason. Details are in [ADR 0006](../adr/0006-postgres-plus-object-storage.md).

## 6. Scaling stages

| | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|
| Size (targets) | 2,000 connections, 500 open documents | 50,000 connections, 10,000 open documents | 100,000+ connections, 1,000,000+ stored documents, several regions |
| Compute | One room-host process with worker threads | Several room hosts; rendezvous routing; connect hint; forwarding over the bus | Separate gateway, room and API tiers; placement service; follower nodes; dedicated processes for hot documents |
| PostgreSQL | One primary with a synchronous standby in hosted mode | Plus read replicas for the control API | Sharded by tenant; the commit log can move to a log store with conditional append |
| Object storage | Assets, checkpoints, exports | Same | Same, per region |
| Redis or Valkey | Not needed | Presence, bus, rate limits | Per region |
| Queue | PostgreSQL table | PostgreSQL table or managed queue | Managed queue |
| Export workers | A few | Autoscaled pool | Autoscaled pools per region with a warm floor |

The protocol, the CDM and the storage model do not change between stages.

## 7. Several regions

Each tenant, and optionally each document, has a home region. Clients connect to the nearest gateway, which forwards channels to the home region's room. Local application of edits hides the round trip from the typist. Version-pinned content and assets are cacheable close to the user. Content, history, evidence and control-plane metadata all stay in the home region except through such caches, which can be switched off per tenant.

## 8. Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Room host crashes | Open rooms vanish; no acknowledged commit is lost | The node lease expires, clients reconnect, a new owner loads from storage; clients resubmit in-flight commits with the same identifiers |
| Two hosts believe they own a document | The stale one cannot append | Epoch check in the write transaction and the log's primary key; the stale host stops serving |
| A host is partitioned and serves only viewers | It would show a frozen document | Self-fencing on the node lease |
| Write outcome unknown | The room does not know whether a batch was stored | Re-read the log tail before continuing |
| PostgreSQL unavailable | Commits cannot be acknowledged | Rooms reject with `unavailable`; editors keep working locally, the journal keeps the work, and the indicator shows "unsaved" |
| Database recovery rewinds the log | Clients hold commits the log no longer has | The operator gives affected documents a new incarnation; clients reload and unconfirmed work goes to recovered edits |
| Object storage unavailable | Checkpoints and cold opens fail; open rooms continue | Retry checkpoints; the log alone is sufficient for durability |
| Redis or Valkey unavailable | Presence and cross-node forwarding degrade | Nodes serve the rooms they own; clients use the connect hint to reach owners directly |
| Grant-change announcement lost | The room's cached permissions are stale | The persist transaction refuses the batch; the room reloads grants |
| Slow consumer | Its queue fills | Close its channel; it resumes by `seq` |
| A commit that crashes or stalls validation | Could stall a process that hosts many rooms | Admission control before any work, exception and time limits, structural limits in the CDM, fuzzing of the authority |
| Hot document | One room saturates a core | Coalesced broadcasts, followers for viewers, a dedicated process |
| Huge document | Memory and load time | The 16 MiB limit; parsing and replay in worker threads; room memory budget |
| Export backlog | Slow previews | Separate priority for interactive previews; per-tenant concurrency limits; autoscaling on queue depth |

## 9. Recovery objectives

| Mode | Recovery point | Recovery time |
|---|---|---|
| Hosted | Zero for the loss of one database node (synchronous standby for the log); the last replicated transaction for the loss of a whole location | 15 minutes |
| Self-hosted | Whatever the operator's PostgreSQL gives; the documentation says so plainly | Operator's |

Restores are rehearsed. A document can be rebuilt and verified from any checkpoint plus the log with a command-line tool that also checks the hash chain.

## 10. Cost model

A unit-cost sheet is a phase 0 deliverable. The known drivers and the rules that bound them:

| Driver | Rule |
|---|---|
| Preview compiles | Only while the preview or a view that needs it is visible, never for a document nobody is looking at; at most one per document per ten seconds; skipped when the bundle hash is unchanged. Page-break reconciliation is opt-in per tenant |
| Log volume | A busy typist produces a few commits a second. Payloads move to cold segments after 30 days; metadata rows are small |
| Checkpoints | Time-based as in section 2.2, and thinned with age (08, section 11) |
| Open rooms | Memory per open document is unmeasured; the room budget and idle close bound it |
| Connections | Cheap compared with the above |

## 11. Observability and support

Metrics per node and per tenant: acknowledgement latency, persist batch size and latency, rebase rate, rejections by code, open rooms, memory per room, send-queue depth, catch-up sizes, cold-open time, export queue depth and compile time. Traces follow the W3C trace context across REST calls, room operations and jobs. Logs are structured and carry tenant, document and session identifiers and never document content or tokens.

Support staff must be able to debug a broken document without reading it. The tooling for that: a structural dump in which every text run is replaced by filler of the same length, so the log still replays; the replay-and-verify tool; and a documented repair procedure that ends in a server-authored commit with origin `repair`.

## 12. Tenancy and quotas

- Row-level security on every table, a storage prefix and an encryption key per tenant, and a dedicated deployment for customers who need one.
- Per-tenant quotas: connections, open documents, commit rate, CPU budget in rooms, storage, export concurrency and export minutes. Exceeding one returns `quota_exceeded`, except the CPU budget in rooms: a commit that would exceed the tenant's budget is rejected with `rate_limited` and action `retry`, as for a connection's budget (04, section 12).
- Administration resources for tenants, keys, origins, quotas, fonts, retention and webhooks are outlined in 13, section 10.

## 13. Operations

- **Artefacts.** A compose file for development and the reference host, and a Helm chart for production, are part of the distribution.
- **Database migrations** follow expand and contract, so that two service versions can run side by side during a rollout. The partition count of the log tables is fixed at creation and chosen for stage 3.
- **CDM migrations** are gated by an operator (03, section 11.3), never triggered by opening a document.
- **Self-hosted upgrades** support skipping at most one minor version; each release documents its database and CDM steps and how to roll back.
- **Backups** are encrypted, access to them is audited, and restores are rehearsed.

## 14. Self-hosting adapters

The reference service talks to its environment through interfaces, so a self-hosted deployment can swap parts: `LogStore` (which must offer conditional append), `CheckpointStore`, `AssetStore`, `GrantStore`, `TokenVerifier`, `Queue`, `Bus`, `EventSink`, `KeyService`. Adapters for PostgreSQL, S3-compatible stores and Azure Blob are part of the reference distribution.

## 15. Authority service

Specified in 05, section 10.

## 16. Open issues

- Decided: the internal bus in stage 2 is Valkey streams, with Redis as a compatible substitute (owner decision 136, 2026-11-15; [ADR 0243](../adr/0243-lane-BE-053-065.md)). NATS is the alternative if a stage 2 run shows that the bus is the limit. The choice does not affect the protocol.
- Whether follower nodes are needed before stage 3.
- The memory cost of an open document needs measuring.
- Search across documents is only sketched. Ranking, permissions in results and the move from PostgreSQL full-text search to a search engine need their own document.
- An on-call and abuse-handling process for hosted mode.
