# ADR 0403: Home regions and the routing that uses them (BE-074)

Status: proposed (2026-11-18, lane w5). Not decided by the owner. Each choice below is the narrowest reading of 06 §7 that the story needs; it is open for review.

## Context

06 §7: each tenant, and optionally each document, has a home region. Clients connect to the nearest gateway, which forwards channels to the home region's room. Content, history, evidence and control-plane metadata stay in the home region except through caches. Forwarding between nodes exists (BE-062) and so does routing over the live nodes (BE-060). The commit store can be spread over databases by tenant (BE-070, `storage/shards.ts`).

## Decisions taken in the code

1. **The assignment is a table.** `home_regions` (migration 0092): a row without a document is the tenant's region, a row with one overrides it for that document. It is under row-level security like every table of tenant data, and the purge of a deleted document removes the document's row. `HomeRegionStore.resolve(ref)` answers the document's own region, else the tenant's, else null. A tenant with no row has no home region and routing is as on one region.
2. **A region is a name, announced by the nodes.** A node writes its region on its lease row (`DOCEDIT_NODE_REGION`, migration 0091). A region is 1 to 100 characters with no control characters and is compared as written. The spec names no region list, so none is kept: a region exists while a node announces it.
3. **Routing considers the nodes of the home region only.** `eligibleHosts` filters the live nodes by region, after the rule of ADR 0402 for dedicated nodes. The forwarder and the connect hint use it. A node that announced no region is in no region: with a home region set it is not a candidate.
4. **No live node in the home region means `unavailable`.** The forwarder refuses the channel (`ch.rejected`, `unavailable`) before any room is opened or any owner claimed, and the connect route answers `unavailable`. Nothing falls back to another region, because that would write the tenant's data there. A client retries; the refusal carries no `retryInMs` of its own.
5. **A room that is already open stays where it is.** Routing never moves an owner (BE-060 criterion 3), so a region assigned to a document whose room is open elsewhere takes effect when that room closes. Moving a tenant between regions is not designed.
6. **Where the region store lives.** It is read through the same `ServiceParts` as every store, so with `shardedPgParts` (BE-070) it follows the tenant's shard. In a deployment where each region has its own database, the assignment of a tenant must be readable from every gateway (a replicated or global directory) or each gateway must hold its own copy; which of the two is open question 1.

## What is not done

- **Criterion 3 (stored only in the home region).** The code does not yet keep a gateway outside the region from reading the tenant's rows: `Forwarder.route` reads the document's head and the home region through the stores it is given. With one database per region (BE-070), the gateway's stores would be the routed stores and would reach into the home region's database for that read. Whether a read of control-plane metadata across regions is allowed is open question 2. Writes: a channel refused or forwarded writes nothing at the gateway (tested: no owner claim, no commit), and every write of a forwarded channel is made by the room of the home region.
- **Criterion 5 (per-region object storage, Redis or Valkey, export worker pool with a warm floor).** These are deployment: several regions of the stack deployed, which needs the separate tiers of BE-068 (not built) and a place to run them.
- The nearest gateway is chosen by the network (DNS or an anycast address), not by the service.

## Open questions for the owner

1. Where does the assignment live when each region has its own database: one global directory, or a copy in each region?
2. May a gateway outside the home region read the document's head and the tenant's region from the home region's database to route a channel? If not, the gateway must route from the region alone and leave the owner check to the node that receives the channel.
3. When no node of the home region is live, should the answer carry a `retryInMs`?
