# 0156. Security backlog batch: decision records for SEC-061, SEC-062 and SEC-063

**Status:** proposed (2026-11-13). Written by the security-3 developer in the backlog batch, round 1. Not decided by the owner. Each option below is a draft for the owner to accept, change or reject.

## Context

Three open items of 10 §6 are `decision` stories: abuse handling for hosted mode (SEC-061, `cond`), key management for per-document and tenant-owned keys (SEC-062), and anchoring chain heads in a public transparency log (SEC-063). The owner's decisions are the owner's. Where the spec gives a default, this record takes it and says so. Where the spec gives none, the record proposes one and marks it as a proposal. No figure in this record is a measurement, and none is a new target.

Facts the records rely on, all from the spec:

- 08 §12: the service publishes the chain head in the `dep.document.changed` webhook and in every export manifest, and periodically writes signed, time-stamped heads to write-once storage.
- 08 §11: legal hold suspends thinning and purge for a document. Commit payloads older than 30 days move to segment files in object storage.
- 08 §13: the log holds surrogate identifiers only. Optional per-document encryption keys allow deletion by destroying the key.
- 10 §3.6 and 12 §8: signing keys live in a hardware security module or a key service. LaTeX workers never hold keys.
- 11 §10: decision 8 (hosted or self-hosted first) is decided as the default, "both are designed for; neither is scheduled first". Decision 11 (the sealing party: the operator or each tenant) is undecided.

## SEC-063: anchoring chain heads in a public transparency log

**Existing anchors.** The host anchors a head it receives in a webhook or in an export manifest, in its own store. The operator writes signed, time-stamped heads to write-once storage. The host is the customer, and the write-once store is configured by the operator, so whoever runs that store can change its retention setting. A public log adds a party that neither the operator nor the host controls.

**Options.**

| Option | Effect | Privacy |
|---|---|---|
| A. No public log (proposed default) | Tamper evidence rests on host anchors and the operator's write-once store, as 08 §12 states | No change |
| B. Publish each document's head hash | Each head is public and linkable | A stable per-document hash lets anyone see that a document exists and when it changed. Not acceptable without a salt |
| C. Publish a salted periodic root over one tenant's heads | One public entry per tenant per period, a Merkle root over salted leaves | The public log holds no document, tenant or user identifier. The salt stays with the tenant. Timing of changes is visible at the period's resolution |

**What would be published (for option C).** A root hash only, plus the period and the number of leaves if the relying party needs it. No content, no seq, no identifiers. A relying party that holds a head and its salt can check inclusion.

**Proposed default.** Option A for version 1, with the option C design kept on file. Reason: option C adds a dependency on an external log and a new privacy surface, and the spec does not show a relying party that needs it yet. Criterion 3 of SEC-063 (the stories to build it) applies only if the owner says yes.

**Status of the criteria.** Criteria 1 and 2 are met by this record. Criterion 3 stays open until the owner decides.

## SEC-062: key management for per-document and tenant-owned keys

**Who holds what (proposed).**

- Tenant data keys: envelope encryption. A key service, backed by an HSM where the platform offers one, holds a key-encryption key per tenant. It wraps the data keys. The operator holds the key service's administration; no application process holds a wrapped key's plaintext for longer than one operation.
- Per-document keys: optional and off by default, as 08 §13 says. When on, a per-document data key is wrapped by the tenant key-encryption key, and the wrapped key is stored with the document.
- Signing keys (PAdES seal and time-stamp): an HSM or key service reached only by the signing service. No LaTeX worker, asset worker or document-service process holds one (10 §3.6).

**Rotation.** Key-encryption keys rotate by version. A wrapped key records its key version. Old versions stay available for decryption until the wrapped data is rewrapped under the new version. Signing keys rotate on a schedule that the signing service's certificate policy sets. No period is proposed here.

**Recovery.** Recovery uses the key service's own backup under a documented procedure. The proposal is that recovering a key-encryption key requires two named people. The owner decides whether that rule applies.

**Audit.** Every unwrap and every signing operation writes an audit event with the key identifier, the actor and the time. The event holds no content (SEC-047).

**Effect of per-document keys.**

- Deletion by key destruction (08 §13) makes the document's rows unreadable without a rewrite, so the document's data is unreadable from storage and from backups that use the same key.
- Cold segments (08 §11) are encrypted under the document key, so they follow the key.
- Search entries must either be encrypted under the document key or hold no text. The choice is open and is recorded here, not decided.
- Caches hold decrypted content only in a process that already has the key. Shared caches must be keyed per document, or switched off for tenants on per-document keys.
- Backups age out on their own schedule (08 §13). Destroying a key makes a backup unreadable before it ages out. The documentation has to state both.

**Sealing party (decision 11, undecided).** Both branches are given, and the record does not choose one.

- If the operator seals: the signing key sits in the operator's key service, and the signing service is the operator's.
- If each tenant seals: a signing key sits in the tenant's own key service or is customer-held, and the signing service refers to it through a per-tenant key reference. Workers do not change.

**Status of the criteria.** Criteria 1 and 2 are met by this record. Criterion 3 stays open until decision 11 is made. Criterion 4 (BE-041 and the signing stories are updated) stays open until the record is accepted, and it is a change to other epics that this batch does not make.

## SEC-061: abuse handling for hosted mode

This policy applies only if the owner chooses hosted mode (SEC-061 is `cond`). 11 §10 decision 8 has a default (both modes are designed for, neither is scheduled first) and does not choose between them.

**How reports arrive (proposed).** One intake channel run by the operator. Automated checks on uploaded assets (SEC-037, SEC-038) feed the same queue when they are built.

**Who decides (proposed).** The operator's abuse function decides. A second person from that function approves any tenant suspension. The tenant administrator is told of an action on the tenant's documents, unless the policy's legal duties say otherwise.

**What can be done (proposed), in increasing severity.**

1. Quarantine an asset: the asset resolves to nothing, and its signed URLs are not renewed. Existing URLs end at their expiry (SEC-046).
2. Lock a document: no commits, no new exports. Readers keep their access.
3. Archive a document: it leaves listings and search, and is kept.
4. Delete a document: the purge of SEC-057, unless a legal hold applies.
5. Suspend a tenant: no new sessions and no new documents. Existing data is kept.

**What the operator may read.** The default is the structural dump of BE-089, which shows structure and not text. Reading content beyond that needs the second approver's agreement and is written to the audit trail. Whether the dump hides attribute strings is an open question in the spec (08 and 06 §11), so this record does not claim it does.

**Which wins: abuse or legal hold (proposed).** A legal hold wins over deletion and purge: nothing under hold is deleted or purged, as 08 §11 requires. An abuse lock or quarantine still applies while the hold lasts, and it does not lift the hold. When the hold is released, the abuse decision applies again.

**Tooling if accepted.** Each of these becomes a story: the intake channel, the asset quarantine flag, the document lock and archive flags, the tenant suspension control, and the audit of operator reads of content.

**Status of the criteria.** Criteria 1 to 3 are met by this proposed policy. Criterion 4 (the tooling becomes stories) applies only when the policy is accepted.

## Open questions

1. Owner: accept or change option A for SEC-063.
2. Owner: decide what the search index holds for per-document keys (SEC-062).
3. Owner: decision 11, the sealing party (SEC-062 criterion 3).
4. Owner: accept the abuse policy, including which of abuse lock or legal hold wins (SEC-061), and who the second approver is.
5. Owner: whether the two-person rule for key recovery applies (SEC-062).

## Needs from others

- Stories BE-041 and the signing stories must change when SEC-062 is accepted (SEC-062 criterion 4).
- BE-089 must state whether the structural dump hides attribute strings (SEC-061, SEC-047).

## SEC-064: read projection open questions (lane security-3, 2026-11-13)

Found by the leak tests of SEC-064 (\	ests/security/test/read-restrictions.test.ts\), memory storage:

- **Commit envelope to a reader without access.** An edit inside a hidden region reaches the reader as a \sync.commit\ with its sequence number, author (user and session), time and an empty \steps\ list. No text leaves, but the fact of the edit, who made it and when do. Proposed default, not decided: keep the envelope and hide only content (current behaviour). The owner decides whether the author and time of hidden edits are hidden too (ADR 0019 open question).
- **Revoked channel not told.** A grant removed while a channel is open produced no \perm.changed\ and no close within one second. Later commits are still projected, so no canary left, but the reader's client is not told that its access ended. Proposed default: the notice belongs to the data plane (07 §8); no change is made here.
