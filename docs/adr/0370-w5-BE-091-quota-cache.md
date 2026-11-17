# 0370 Live-use quotas: where a node reads the values (BE-091)

Status: proposed (lane w5, 2026-11-17). For the owner to confirm.

## Context

BE-091 criterion 3 asks that a quota changed through the administration API applies to the next
request. The values are written by `PUT /quotas` (UX-078) into a store that may be PostgreSQL, whose
reads are asynchronous. The live-use gate (`LiveQuotas`) decides synchronously, in the socket's
message handler and before a REST commit. The spec gives no rule for how fresh a node's copy of
the values must be (06 §12).

## Decisions proposed

1. **The gate reads a cache of the stored values.** `CachedQuotaSource` (in
   `control-plane/quota-admin.ts`) is the `QuotaSource` of the node when the parts compose no
   source of their own. A write through this node's `QuotaAdminService` updates the cache at once, so
   on one node the next request sees the new value.
2. **A node trusts what it read for `QUOTA_CACHE_TTL_MS` (5,000 ms).** A change written through
   another node reaches this one within that time. The figure is a setting of this lane, not a spec
   figure, and has not been measured against any load. A memory store is read directly at each
   decision after the time has passed, so it is never stale in a way that matters.
3. **`hello` and the REST commit routes read the values first.** `LiveQuotas.prepare(tenant)` loads
   a stale entry before the decision, so the first decision of a tenant on a node does not run on
   empty values. A store that fails keeps the values read last (or no quota, when none was read).
   Between a stale read and the next one the node decides on the old values.
4. **Open documents count channels, per node.** `openDocuments` counts the distinct documents a
   tenant has open on this node. Each channel holds its document; the document stops counting when
   the last channel is released. A quota over several nodes is therefore a per-node limit; the spec
   does not say whether the quota is per node or per cluster (06 §12). A cluster-wide count would
   need shared state and is not proposed here.
5. **A refused `ch.open` is answered with an `error`.** `ch.rejected` has no `quota_exceeded` code
   or retry hint (05 §5.2), and `error` is among the replies of `ch.open`. The `error` carries
   `quota_exceeded`, `retryable`, `retryAfterMs` and `re` of the request, and does not close the
   connection.
6. **Room CPU is the synchronous time of the commit.** The session measures the time `room.submit`
   takes (`performance.now()`) and charges it to the tenant. A budget already spent refuses the next
   commit as `rate_limited` with action `retry`, as 06 §12 and 04 §12 say. The window of the
   budget is the one of ADR 0245 (60,000 ms). Storage time is not charged, so the figure is lower
   than a CPU profile would give (04 §12 asks for a cost estimate before the work; this charges the
   work after it).
7. **REST commits count.** `PUT /documents/{id}/content` and the restore of a version count against
   the commit-rate quota and the CPU budget, answered with 429 and `Retry-After` in whole seconds
   (at least 1).

## Not decided here

- Whether quotas are per node or per cluster (item 4).
- The cache time (item 2) and the CPU estimate (item 6).
- BE-091 criterion 2 is a latency claim. The measurement in
  `services/document-service/test/control-plane/be-091-composed-quotas.test.ts` shows the median
  acknowledgement of a second tenant rising from 4.42 ms to 6.46 ms while the first tenant was
  refused in a loop, on one Node.js process with memory storage on a development machine. The
  decisions are per tenant, but the event loop is shared, so the criterion stays open.
