# 0428. Counter and stream keys that hold no tenant

**Status:** accepted (owner decision 268, `docs/owner-decisions-2026-11-26.md`: both kinds of key are accepted as stated exceptions, written into the spec and pinned in a test). Option A applies. The exceptions are written into `docs/spec/10-security.md` section 3.7 and pinned in `tests/security/test/sec-045-w8-key-inventory.test.ts`. Written by lane w8, 2026-11-26, for SEC-045 criterion 5.

## Context

SEC-045 criterion 5 says that every cache, counter and stream key includes the tenant. The test `tests/security/test/sec-045-w8-key-inventory.test.ts` lists the keys the product builds. Most hold the tenant: the tenant and user rate counters (`t:{tenant}`, `u:{tenant}\0{user}`), the idempotency records (tenant first in the scope), the pinned read cache (the tenant in the key) and the search tables (`tenant_id`, row-level security).

Two kinds do not:

1. **Address counters** (`c:{address}`, `f:{address}`, `data-plane/limits.ts`). They run before a token is verified, so no tenant is known. They are kept in the node's memory and are never sent to Redis or Valkey.
2. **Bus streams** (`node:{node}` for the inbox of one node, ADR 0393, and `announce`). One stream per node carries the frames of every channel the node owns, whatever the tenant. The frames name the document; the stream's key does not name the tenant.

## Options

- **A. Accept both as exceptions.** The address counter is not tenant data. The node inbox is a routing path between nodes of one deployment; a tenant's frames are separated by the document reference in the frame, and the nodes are inside one trust boundary. Record the exceptions in 10 §3.7 and keep the pinned list in the test.
- **B. Key the streams by tenant.** One stream per node and tenant (`node:{node}:{tenant}`). The stream count grows with the tenants a node serves, and the reader (one connection per node, ADR 0393) must follow a stream per tenant. Address counters stay as they are, since no tenant is known.
- **C. Dedicated deployment for tenants that need it** (BE-093). The shared bus keeps option A; a dedicated deployment has its own bus.

## Default

The spec's default is not stated for the streams. This lane applies none. Option A is the least change; the criterion stays unticked until the owner chooses. The test pins the two exceptions, so a new key that holds no tenant fails it until it is classified.
