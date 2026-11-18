# 0380 BE-030: tenant limits in the registry and counters behind a store

Status: proposed (lane w5, 2026-11-17). Story: BE-030. Spec: 06 §8, 10 §3.2.

## Context

BE-030 criterion 3 asks for limits held per tenant in the registry of BE-012. Criterion 5 asks for
the counters to move from process memory to Redis or Valkey without changing the limits'
behaviour. The spec names the layers and no figures.

## Decisions (proposed; the owner has not been asked)

1. A tenant's limits are one nullable `jsonb` column, `tenants.rate_limits` (migration 0072), with
   a `tenant` bucket and a `user` bucket, each `{ capacity, refillPerSecond }`. A scope left out is
   the node's default (ADR 0053). The registry checks the shape on write.
2. The gateway reads a tenant's limits at most once in 5 seconds (`DEFAULT_TENANT_LIMITS_TTL_MS`).
   A change applies within that time with no restart. The figure is a setting chosen here, not a
   spec value. A registry that cannot be read leaves the last answer, or the defaults, in force.
3. `RateLimits.message` and `rest` are asynchronous, because a shared store answers over the
   network. The session already runs each message in a queue, so only that session waits.
4. Address counters (upgrades and frames before `hello`) stay in the node's memory in stage 2.
   They protect the node that receives the traffic, run before any token is verified, and a round
   trip per frame would cost more than it saves. Tenant and user counters use the store.
5. With `DOCEDIT_VALKEY_URL` set, the tenant and user counters are in Valkey
   (`ValkeyTokenBuckets`, BE-063). When Valkey cannot be reached the store answers from a local
   bucket (ADR 0336), so limits loosen across nodes and nothing fails.

## Not decided

- Administration endpoints for editing a tenant's limits (UX-076, phase 2).
- Whether a tenant may raise its limits above the default (an operator-only setting for now).
