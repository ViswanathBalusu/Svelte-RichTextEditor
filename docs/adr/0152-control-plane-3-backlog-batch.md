# ADR 0152: Control-plane lane 3 backlog batch (BE-060, BE-064, BE-065, BE-075)

Status: proposed (2026-11-13, lane control-plane-3, round 1). Not decided by the owner; each choice
below is the spec's default or the narrowest reading of the story, and is open for review.

## Context

Lane control-plane-3 took four stories from the end of the BE-backend slice (BE-050 to BE-075) that
can be met inside `services/document-service/src/control-plane`. Each rests on an in-memory stub
rather than PostgreSQL, a real replica, a bus or a region, because none of those is available here.

## Decisions taken in the code (to review)

1. **Room routing hash (BE-060).** The rendezvous score hashes the document identifier and the host
   name only, not the tenant. The story names "the document identifier". Document identifiers are
   generated as UUIDs, so the tenant is not needed to spread documents. Open: if identifiers are
   ever tenant-scoped, the hash input must change, which moves every document once.
2. **Pool policy has no defaults (BE-065).** The warm floor, the ceiling and the jobs per worker are
   inputs. The spec gives no measured numbers (06 §6 says "a warm minimum" and "a ceiling" only), so
   none is invented. The composition must set them and say where they were measured.
3. **Scale-down waits for the running job (BE-065).** A removed worker finishes its attempt; nothing
   is cancelled to make room. The alternative (cancel and re-queue) loses work, which the spec does
   not allow for previews.
4. **Replica reads fall back on any doubt (BE-064).** A pinned read the replica has not applied goes
   to the primary; a read whose documents the session wrote waits for the replica (read-your-writes
   per session, per document; a list checks every document the session wrote in the tenant); a
   replica that fails or has no row sends the read to the primary. The session is the caller's
   `ReadSession`, so its lifetime is the composition's choice.
5. **Pinned cache checks on every request (BE-075).** The permission check and the visibility gate
   run before a hit is served, not only before a miss is stored (criterion 3). A document with hidden
   scopes is neither stored nor read at the edge (SR-C4, from the second review). A tenant with
   caching off has its copies dropped at the next read.

## Open questions (not decided)

- Q1 (BE-064 criterion 4): how often lag is sampled, and by whom. The router records lag only when
  `observeLag` is called; no scheduler calls it yet. Owner: the composition.
- Q2 (BE-060 criterion 3): the epoch check of BE-017 decides ownership; this module only hints. The
  composition must not treat the route as a grant. Owner: data plane.
- Q3 (BE-075 criterion 1): which regions cache. Depends on BE-074 (home region routing), not built.
- Q4 (BE-065): whether the autoscaler should scale down one worker per tick rather than to the target
  at once. The story does not say; the current code scales to the target at once.

## Consequences

- Criteria that need PostgreSQL, a replica, a bus, a region or a running server stay unticked in the
  stories, each with its reason in the story's Notes.
- The stubs in the tests are not evidence of production behaviour under load.

## Round 2 (2026-11-13, lane control-plane-3)

Stories taken from the end of the slice that can be met inside `control-plane`: BE-070 (code),
BE-069 and BE-071 (spike designs). The rest of BE-050 to BE-075 was left unclaimed, with the reason
in each story's Notes: BE-066 and BE-067 need measured load; BE-068 needs separate deployables and
charts; BE-072 needs a managed queue service; BE-073 needs a dedicated process that takes the epoch,
which lives in the data plane. BE-071 criteria 1 and 2 need measured insert rates and candidate
stores, which are not available here.

### BE-070: tenant-to-shard routing (decisions in the code, to review)

- **No default shard.** `ShardMap.shardOf` refuses a tenant the map does not name. A default would
  send a tenant's data to the wrong shard without any error. Owner: composition (the map is config).
- **Claims are fanned out.** `claim` has no tenant, so it asks the shards in turn, starting after the
  shard that gave the last job. The highest-priority-first rule of ADR 0054 holds within one shard
  only. Open question Q5: whether a claim should peek each shard's best priority and pick across
  shards. The story does not say; the current code does not. Owner: data plane and maintainer.
- **Transactions over several tenants.** `assertSingleShard` refuses a set of tenants on more than
  one shard. The commit transaction itself (BE-024) is in the data plane and does not call it yet.
- **Migrations.** The rollout of one migration to every shard (criterion 3) is not written here: the
  migrate runner and the expand-and-contract checks (BE-016) are outside this lane.

### BE-069: placement service design (spike, proposed, not measured)

This is a design from 06 and the code of BE-060. No prototype was built and no load was measured,
so every cost below is a qualitative cost, not a figure.

- **What placement adds.** Rendezvous hashing (BE-060) picks an owner from the document identifier
  and the live hosts. It cannot choose a host for one document. A placement service would keep an
  explicit table of document to host, consulted before rendezvous. That lets a hot document (06 §8)
  move to a host with headroom, and lets a tenant or region be placed on a set of hosts.
- **What it costs.** A new stateful component on the route path, with its own failure domain. One
  more lookup when a channel opens. A table that must follow live leases, so it can name a host that
  has gone; the router must then skip it. Operator surface: rules for who may move a document.
  Migration of existing documents from rendezvous to the table.
- **Ownership stays with the epoch.** Placement only proposes a host, as the route does today. A
  host becomes owner only by the epoch transaction of BE-017, which sets `owner` and raises `epoch`.
  A placement write never changes an owner directly, and a host that loses the epoch race does not
  serve the room.
- **Placement outage.** Rooms already open keep their owners while their node leases hold; nothing
  is re-owned because the placement table is unreachable. A new channel falls back to rendezvous over
  the live hosts, which is safe because the epoch still decides. A room whose host dies is taken over
  after the lease expires, as in BE-076.

### BE-071: moving the commit log off PostgreSQL (spike, proposed)

- **Criterion 1 (the rate at which PostgreSQL stops being enough)** is not stated. It needs measured
  insert rates on one primary, and none exist here. Nothing is invented.
- **Criterion 2 (candidate stores tested against the BE-002 suite)** is not met: no candidate store
  was run.
- **Recommendation (criterion 3).** Stay on PostgreSQL (ADR 0006). If a move is ever made, the
  recommendation requires that a candidate:
  - passes the conditional-append suite of BE-002: an append with a stale epoch or head stores
    nothing, and a correct append stores the commits and advances the head atomically;
  - keeps the hash chain (`prev_hash` and `hash` per commit, and `chain_head`) unbroken across the
    boundary, so a document's chain verifies whichever store holds each commit;
  - keeps the cold segments (BE-041 keys, written from the log) addressable and verifiable with the
    same keys, so a segment written before and after the move reads the same way;
  - is read by the recovery tool (BE-081 rebuild and verify from a checkpoint plus the log), which
    checks the hash chain, so that a restore needs no knowledge of which store held a commit.

Open questions added in round 2: Q5 (claim priority across shards, BE-070) and Q6 (who owns the
placement table's rules, BE-069). Neither is decided here.
