# ADR 0105: Storage packet choices (KeyService and per-tenant object encryption)

**Status:** proposed, 2026-11-13. Records the choices made in `services/document-service/src/storage` and `src/objects` for BE-002 criterion 5 and BE-041. The spec leaves the algorithms, the key layout and the envelope open; every choice below is the spec's default or the smallest choice that meets the criteria, and the owner decides whether to keep it.

## Context

06 §14 lists `KeyService` among the interfaces the reference service reaches its environment through. ADR 0013 says signing keys stay in a key service and workers hold none. BE-041 asks that each tenant's objects be encrypted with that tenant's key obtained through `KeyService`, and that disabling one tenant's key leave the others readable. The spec names no algorithm, no key-size and no envelope format for either.

## Decision

### KeyService (BE-002 criterion 5)

- `KeyService` is a TypeScript interface in `src/storage/key-service.ts` with five operations: `create`, `publicJwk`, `enabled`, `sign` and `unwrap`, plus `disable`. No operation returns private key material; the test lists the operation names and checks that none matches `private`, `export`, `secret`, `raw` or `material`.
- Two purposes exist, fixed at creation. `sign` keys are ECDSA P-256 with SHA-256, so the signatures are ES256, as user tokens use. `unwrap` keys are RSA-OAEP 2048 with SHA-256; a caller wraps a data key with the public JWK, and only the service unwraps it.
- `MemoryKeyService` is the in-process implementation over WebCrypto. A PostgreSQL or KMS-backed implementation is not written. The owner should choose the production store (08 and 10 leave it open).
- A disabled key refuses `sign` and `unwrap`; other keys are unaffected.

### Per-tenant object encryption (BE-041)

- `EncryptedObjectStore` (`src/objects/encrypted-store.ts`) decorates an `ObjectStore`. The tenant is read from the key prefix of 06 §4.2. The tenant's key identifier is `tenant-<tenant>`.
- Each object is sealed with a fresh AES-256-GCM data key and a 12-byte IV. The data key is wrapped with the tenant's `unwrap` public key. The object key is bound as associated data, so an envelope copied to another key does not open.
- Envelope, version 1: `0x01`, wrapped length (uint16, big endian), wrapped data key, IV, ciphertext with its tag.
- Writes under a disabled or missing key are refused before anything is sent. Reads unwrap through the key service, so a disabled key makes that tenant's objects unreadable.
- `signedUrl` returns a URL of the sealed bytes. The asset origin (ADR 0043) serves the original bytes, so a signed URL of an encrypted store is not a read path for viewers. Wiring the decorator into the asset path is for the owner (see below).
- Not decided here: optional per-document keys, tenant-owned sealing keys and key rotation (SEC-062). Rotation would need a new key identifier and a re-seal job.

## Consequences

- BE-002 criterion 5 is met and ticked. Criteria 1 to 4 of BE-002 stay open for the reasons in that story's Notes.
- BE-041 criteria stay unticked: the decorator is built and tested, but the service composition that writes objects is outside `src/storage` and `src/objects`. Criteria 1 and 2 need that wiring and a run through the service. Criterion 3 (hosted buckets) and criterion 4 (database recovery) are out of this packet.
- The environment where the key service runs is not configured. Keys held only in process memory are lost at restart; that is acceptable for tests and a demo, not for production.

## Round 1 additions (2026-11-13): BE-011 and BE-016

- The tenant check of the migrations (`src/storage/tenant-guard.ts`) reads the SQL files and asks that every table a migration creates has a `tenant_id` column and a `docedit_protect` call. It runs in the Node.js suite and in `migrate check`, so it needs no database. `node_leases` is the one exemption (`TENANT_EXEMPT`), with the reason in 0033's header; a test fails if an exemption goes stale. This is a proxy: the catalogue test on a database remains the full check, and it currently expects every table to have a `tenant_id`, which `node_leases` does not. The owner decides whether the catalogue test or the exemption changes.
- The expand-and-contract plan rule (BE-016 criterion 2, `planProblems` in `src/storage/migrate.ts`) is tested in `src/storage/migrate.plan.test.ts` on synthetic plans and on the shipped plan. The rule is the spec's default: a contract step ships at least one release after the expand step it completes; migrations no release lists belong to the next release.
- Not decided here: whether `migrate check` belongs in CI as a separate job (ci.yml does not run it today; the Node.js suite already covers both checks), and how a partition-count check (BE-016 criterion 4) should be written. `src/storage/partitions.test.ts` is a static guard: only the baseline sets the count (64, BE-008), and no later migration re-partitions, attaches, detaches, drops or renames the two log tables. The runtime property stays with a database, so BE-016 criterion 4 is not ticked.

## Round 1 triage (storage packet, backlog run): no further ticks

- BE-002, BE-003, BE-009, BE-013, PRM-002 and PRM-016 were checked against this packet. Their open criteria need a running PostgreSQL or S3 server (none was reachable: ports 5432 and 57070 were closed), a container, the room or data plane, or another package, so none was ticked. The reasons are in each story's Notes.
- BE-008 criteria 1 and 2 wait for ADR 0020 to be accepted; that is the owner's decision, not this packet's.
- BE-078 (the incarnation procedure, `src/data-plane/recovery.ts`), BE-079 (`src/config.ts`), BE-081 (`src/data-plane/recovery-cli.ts`) and BE-020 (`src/data-plane/checkpoints.ts`) are built outside this packet's directories and are not changed here.
- Scoped checks: `pnpm vitest run services/document-service/src/storage services/document-service/src/objects` passed 5 files and 48 tests before the guard was added, and the guard adds 3 passing tests; `pnpm exec tsc --noEmit -p services/document-service` passes.

## Open questions for the owner

1. Which production store holds the `KeyService` keys (PostgreSQL with a wrapping key from the environment, or a KMS)?
2. Is the wrap algorithm RSA-OAEP 2048 acceptable, or should the platform standardise on another size or on AES key wrap?
3. Should the composition root wrap every object store with `EncryptedObjectStore` for every tenant from the first release, or only for tenants that opt in (SEC-062)?
