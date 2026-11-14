# ADR 0036: The control plane of the reference document service

**Status:** proposed, 2026-11-06. Records the choices made while building the control plane and the process of `services/document-service` (PLAN-1a packet A2: BE-001, BE-003, BE-012, BE-013, BE-032 to BE-036, BE-049, BE-088; PRO-008 to PRO-012, PRO-038 to PRO-064; PRM-002, PRM-018). The choices that change the wire are in the protocol's decision register as D60 to D74 (`packages/protocol/src/definition/decisions.ts`, listed in the S6 report); this record holds the ones inside the service. The project owner has not reviewed any of it.

## Context

05 §6 names the routes and the conventions of the control plane but almost no bodies or statuses (S6 gaps G50 to G77). 06 describes the reference service, 07 §12 the authorisation matrix (now data: `packages/authority/src/permissions/matrix.ts`), 10 §3.2 and §3.7 the security rules. Several things the service needs are not described anywhere: how platform work reads under row-level security (BE-011 open question), the format of an API key, how surrogates meet grants, what the queue's states are, and the many settings a process has.

## Decision

### One process (BE-001)

`src/server.ts` composes one HTTP server: the control plane (REST under `/v1`, discovery at `/.well-known/dep`, the JWKS of minted tokens at `/.well-known/jwks.json`, probes at `/healthz` and `/readyz`) and the data plane of packet A1, to which upgrades of `/dep` go. There is no bus. Replays for content reads run in a pool of worker threads (`control-plane/workers/`); a worker that crashes or passes its time limit fails its task with `internal` and is replaced. Readiness is the database answering and its newest applied migration being the code's; migration 0007 lets the service role read the bookkeeping table for it.

### Reads that cannot know their tenant

Row-level security has one policy per table (BE-011). Two reads cannot name a tenant: whether a CORS preflight's origin is allowed by some tenant (D66), and a worker's claim of the next job of any tenant (BE-049). Each is one function defined by the schema owner with `SECURITY DEFINER` (`docedit_origin_registered`, `docedit_claim_job`), executable by the service role, returning a boolean or the claimed row. Everything after a claim runs under the row's tenant. The functions read across tenants only when their owner bypasses row-level security: the reference deployment migrates as a superuser; a deployment that migrates as a plain owner must give that role `BYPASSRLS`. This answers BE-011's open question for these two reads only.

### Credentials (BE-012, BE-033; PRO-010, PRO-012)

- Both credentials are bearer tokens (D18). A service credential is an API key `dsk_<tenant>_<key id>_<secret>` (32 random bytes, base64url) or a JWT whose type header is `dep-svc+jwt`; anything else is a user token. The tenant is in the key so that it can be checked under its tenant; only a SHA-256 of the secret is stored. A key with an expiry stops at it, which is how a rotation overlap ends.
- Keys are registered per tenant with a use (`user` or `service`), one algorithm of ES256, EdDSA and RS256, and optionally the `iss` their tokens carry. The same key material cannot be registered under both uses (RFC 7638 thumbprint). Verification uses only `node:crypto`: no dependency to audit, and the rules are few. Header members that name or carry keys are never read; `crit` is refused.
- The service signs the tokens it mints with its own key (`DOCEDIT_SIGNING_JWK`, or one drawn at start, which ends with the process), published at `jwks_uri` (D60).
- Registrations are read from storage on every request, so changes apply without a restart. Phase 1a seeds them from `DOCEDIT_TENANTS_FILE` or the `tenant` command (`src/tenant-cli.ts`); the administration routes are UX-076.

### Surrogates (BE-013)

Every verified `sub` is mapped to a random UUID per tenant. The data plane's `connection.sub` is the surrogate, so commits, leases and grants hold surrogates: the grants API takes and shows `user:<sub>` and stores `user:<surrogate>`. A grant to a user never seen creates their mapping. Erasing a user deletes the mapping row; grants and history keep the surrogate, which nothing resolves any more. Whether clients see the `sub` or the surrogate on the data plane is gap G11, packet A1's.

The data plane gets the same mapping through `DataPlaneDeps.users` (`UserLookup`: `subsOf`, `surrogateOf`), so that it can show hosts' `sub` values on the wire while it stores surrogates (G11, as asked of packet A1).

### Routes the room carries out

`PUT /documents/{id}/content` is checked by the control plane (service credential, If-Match against the content at the head, `model.validate`) and carried out by the data plane through `DataPlane.replaceContent`, since a snapshot commit is a log write the owning room must make (BE-037, PRO-050). Without it the route answers `not_found`. `PUT /documents/{id}/regions/{rid}/state` is the control plane's: no route reads a region state (G99), so its precondition is the grants ETag or `*`; an approval answers with the `seq` and the hash of the region's canonical content at the head, which storage does not yet keep with the state (07 §11; PRM, phase 2).

### Revocation (D73)

The watermark is the second of the revocation: `iat` has seconds, so a token issued in the same second before the revocation survives it, and one issued after it in the same second works. A watermark for one document removes that document from the tokens issued before it.

### Content reads (BE-036; ADR 0019)

The content at a `seq` is the newest checkpoint at or before it (in phase 1a only the content at 0, D67) plus the stored commits after it, replayed in a worker. Rebuilt content is cached by tenant, document, incarnation and `seq`; responses by those and the view token and the grants revision. The reader's class is derived from the grants in storage at each read (S12 change 3), through one function per kind of read (`control-plane/visibility.ts`), all the full view until ADR 0019 is accepted. When the data plane offers `readContent`, user reads go through it, so that the view token is the one its channels use; both planes share one view key.

### Jobs (BE-049)

States `queued`, `running`, `completed`, `failed`, `cancelled`; a running job reports a stage and a progress. A claim holds a lease renewed by heartbeats; a job whose lease passed is claimed again with one more attempt, up to the job's `max_attempts` (default 3), then fails. A failed attempt is retried after a delay only when the handler asks for it. Cancelling a running job marks it cancelled at once; the worker learns it at its next heartbeat and its result is refused. An export job's result holds file names under the job's prefix, never URLs; the control plane signs URLs at each read, after the requester check of SR-C4 (D68, D69). This is the contract with the compile worker of packet D (`ExportOutputs`, `control-plane/handlers.ts`).

### Object storage (BE-003)

An S3 adapter signed with Signature Version 4 over `fetch`, path-style, and an in-memory one. Every call goes through a guard that refuses a key outside the tenant's prefix before a request is sent. Write-once checks that the key is absent and sends `If-None-Match: *`; on a server that ignores the header the check and the write are not atomic.

### Logs (BE-088)

One JSON object per line with a fixed set of members: identifiers, codes, numbers and messages the service writes itself. There is no member for a body, a header or a query string; paths are logged with query values dropped; errors by name and stack frames. Problem details name the JSON Pointer and the rule broken, never the value.

### Settings

Every number below is a setting with a default, not a measurement (`src/config.ts`): request bodies 1 MiB, bodies with CDM content 16 MiB (the document limit of 03 and 06 §8); signed URLs 300 seconds; two worker threads with a task limit of 60 seconds; 64 rebuilt contents and 256 responses cached; job leases 30 seconds, an idle poll of 1 second, a retry delay of 5 seconds, 3 attempts; list pages of 50 by default and 200 at most (05 §6.1; D72).

## Consequences

- A second implementation of the control plane can follow D60 to D74; nothing in this record is visible on the wire except the API key format, which is opaque to clients.
- The two security-definer functions are the only reads across tenants; a test of the catalogue (BE-011) still finds one tenant policy on every table.
- Export workers hold no URLs and no credentials beyond the object store; the requester rule and the `no-export` restriction are checked at every read of a job.
- Until BE-020 writes checkpoints, a content read at a late `seq` replays every commit since 0, so the bound of 2,000 commits of BE-036 does not hold yet.

## Open questions

- Whether holders of `manage` may read other users' export jobs (D69; review SR-C4): owner.
- Whether pinned reads may be cached at shared edges for documents without hidden scopes (BE-036 criterion 4 against SR-C4; D70): owner.
- Platform reads in general under row-level security, beyond the two functions above (BE-011).
