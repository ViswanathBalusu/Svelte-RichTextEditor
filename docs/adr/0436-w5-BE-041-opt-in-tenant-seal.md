# ADR 0436: Sealing of tenant files for tenants that opt in (proposed)

Status: proposed. Lane w5, story BE-041. Owner decision 274 of
[the 2026-11-26 decisions](../owner-decisions-2026-11-26.md) answers open question 3 of
[ADR 0105](0105-storage-backlog-batch.md): "Only tenants who opt in have their files sealed with
their own key." This record says what was built for that answer and what it leaves open.

## Built

`OptInTenantSealStore` (`services/document-service/src/objects/opt-in-seal-store.ts`) decorates an
object store. For a tenant in the opted-in set, the objects under `tenants/<tenant>/docs/<doc>/`
(checkpoints, cold segments, set-aside checkpoints) are sealed through `EncryptedObjectStore`, with
the tenant's key from `KeyService`. All other keys, and all objects of other tenants, pass through.
`startService` takes `parts.sealedTenants` (with `parts.keyService`), provisions each tenant's key and
puts the decorator under the per-document store (HIS-041), so both layers can apply.

## Not decided here

1. **How a tenant opts in.** The set is a start-up part. A per-tenant flag in the control plane
   (a column, an administration call, an audit event) is not built.
2. **Objects other readers use.** The client writes `quarantine/` through a pre-signed URL, the
   asset origin reads `assets/` without keys (ADR 0013), and exports and final PDFs are downloaded
   through signed URLs. Sealing them needs the asset origin and the downloads to go through the
   service, or a key-service unwrap at the edge. Until the owner chooses, they stay unsealed, so
   BE-041 criterion 1 ("any of its objects") is not met.
3. **Objects written before opt-in.** They are plain. A read of one as sealed fails with
   `SealError`. A tool to seal existing objects (as `sealExistingObjects` does for one document) is
   not built.
4. **The production key store** is open question 1 of ADR 0105. The document service reads no key
   service from its configuration (`main.ts` composes none); only a test or an embedding host passes
   one in `parts.keyService`.
