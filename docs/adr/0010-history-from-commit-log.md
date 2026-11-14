# ADR 0010: The commit log is the history; versions are pointers; restore moves forward

**Status:** proposed, 2026-09-18.

## Context

Users need to see who changed what and when, across sessions that happen at different times, and to compare, name and restore versions, per document and per region (R4).

Prior art on 2026-09-18: Google Docs' revision log is the document, with author, session and time per revision, grouped for display. Overleaf stores history in chunks (a snapshot plus up to 2,000 changes or 5 MB), keeps chunk content in object storage, and groups versions when the list is read. Figma checkpoints to object storage every 30 to 60 seconds and journals changes by sequence number. SharePoint keeps file snapshots and thins them with age. Ink & Switch's research found that tracking every edit by default, keeping history linear and making the visualisation optional tested best.

CRDT libraries offer history features, but Yjs snapshots require garbage collection to be disabled, Yjs's attribution work was still a release candidate, and in every library the author and time of a change are asserted by the client.

## Decision

- Every accepted commit is stored with server-stamped user, session, time, origin, the scopes it touched, schema and engine versions, and a hash chained to the previous commit (08, section 2). This starts in the first release, before any history user interface exists.
- Checkpoints (full copies with an attribution map) are written every 500 commits or 1 MiB of steps. Any version is the nearest checkpoint plus a short replay.
- A version is a pointer to a sequence number. Only named and semantic versions are stored; automatic grouping is computed when the list is read.
- Comparison is computed by the service, from recorded steps for short ranges and from block-aligned documents for long ones.
- Restore computes steps from the current document to the target content and applies them as a new commit. History is never rewritten. Fork is one-way.

## Consequences

Good:
- History cannot drift from what happened, because it is what happened.
- Attribution is as trustworthy as authentication, not as a client's claim.
- Per-region history, "changes since last visit" and attribution are queries, not new mechanisms.
- Independent of any sync library's history features.

Bad:
- Storage grows with every keystroke burst. Rows are small, compress well and move to cold segments after 180 days.
- Old commits are tied to the schema and engine version they were made with. Checkpoints on both sides of migrations limit the exposure; the policy for keeping old packages runnable is open.
- Comparison quality for moved content and table restructuring is unproven.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Periodic snapshots only | No attribution, coarse comparison, no per-region history |
| History features of a CRDT library | Unstable or proprietary at the time of writing; client-asserted identity |
| Rewriting history on restore | Destroys the audit trail and breaks other clients |
| Branches with merge from the start | Large design space; fork covers the first needs |

## After the first review (2026-09-18)

- Changes of permission and workflow state are control commits in the same log, so their order relative to content is provable and they are covered by the hash chain. In the first draft they sat in a mutable audit table.
- Approvals are bound to a sequence number and a content hash.
- Imports, whole-document restores and migrations are snapshot commits that reference a checkpoint, because they cannot be expressed as a bounded list of steps.
- The chain hashes the hash of each payload, so a payload can be thinned or erased without breaking it. Chain heads are published to hosts and anchored, so that tampering is detectable by someone other than the operator.
- The log stores per-tenant surrogate user identifiers, so erasing a person is deleting one mapping row.
- Each commit also records its base, whether it was rebased, the access revision it was checked against and the token identifier.
- One visibility gate covers every place a sequence number can be supplied, including channel resume.
- Checkpoints are time-based, verified against a replay, written only from durable state, and thinned with age.

## Revisit when

Storage cost of full-fidelity history becomes material for a tenant (enable thinning), or branches with merge become a requirement.
