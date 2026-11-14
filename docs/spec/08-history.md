# 08 History

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Informative, except section 2, which defines what MUST be recorded.

The history requirement (R4) is met by the commit log itself. Nothing is added on the side that could drift from what really happened. The decision is recorded in [ADR 0010](../adr/0010-history-from-commit-log.md).

## 1. What users get

- A list of versions, grouped by day and editing session, with filters for named versions, for one region, for one field and for one person.
- Named versions.
- A read-only view of the document at any version.
- A comparison of any two versions.
- "Who wrote this" for any passage, and "who filled this" for any field.
- "What changed since I was last here".
- Restore of a whole document or of one region, and a copy of any version as a new document.

## 2. What is recorded

For every accepted commit, of every kind (steps, control, snapshot), the document service MUST store the following, from the first release onwards, whether or not any history feature is visible yet:

| Field | Source |
|---|---|
| Document, `seq`, kind | Authority |
| Commit identifier | Client, or derived for server-authored commits |
| User (as the tenant's surrogate identifier), session, agent if an assistant acted | The authenticated connection |
| Server time | Server clock |
| Origin | The client's hint, recorded as a claim, or a reserved server origin |
| Scopes touched | Computed by the authority's outcome check (07, section 5.1), including `field:<id>` scopes |
| `base`, whether the commit was rebased, the access revision it was checked against, the token's `jti` | Authority. They let a restarted room rebuild an acknowledgement and let an audit show why a change was allowed |
| CDM version and engine | Room |
| Payload: the rebased steps as applied, the control data, or the checkpoint reference of a snapshot commit | Room |
| Size | Room |
| Previous hash and hash | `hash = SHA-256(prev_hash ‖ canonical JSON of the metadata above ‖ SHA-256(payload))` |

Because the hash covers the hash of the payload and not the payload itself, a payload can later be thinned or erased without breaking the chain.

Control commits put changes of permission and workflow state into the same chain as content: grants revisions, region states and approvals, lease breaks, workflow transitions, participant completion. "This field was filled before that region was approved" is therefore provable from one ordered log.

The document service also stores, per session, the user agent family and the client version. It stores no personal data about users beyond a surrogate identifier and, if supplied, a display name that can be purged. Evidence for signing workflows is the one deliberate exception and is kept elsewhere (12, section 7).

## 3. Checkpoints

A checkpoint is the document at one `seq`, in canonical form, stored in object storage with its side data: the attribution map (section 7) and the comment ranges (07, section 6). The room writes one after 2,000 commits or ten minutes of activity, whichever comes first, but at most every two minutes, around every snapshot commit, and when it closes with changes. Checkpoints come only from durable state and are verified against a replay. Any version is rebuilt from the nearest checkpoint at or before it plus a replay of at most 2,000 commits, in a worker thread. Rebuilt versions are cached.

## 4. Versions

A version is a pointer to a `seq` with a kind:

| Kind | Created |
|---|---|
| `named` | By a user, with a name and a note |
| `export` | When an export job completes, so the exported state can always be found again |
| `pre-restore`, `restore` | Around a restore |
| `import` | When content is imported |
| `sent`, `completed` | By a workflow (12) |

Automatic versions are not stored. The history list groups commits when it is read: a new group starts after an idle gap of five minutes, when the set of authors changes, at a change of origin such as an import or a restore, and at any stored version. Because grouping is computed at read time, its rules can change without touching data.

## 5. Viewing an old version

The component opens a second, read-only editor state that is never connected to the live channel, loads the content at that `seq`, and renders it with the fonts and assets of that time, with the comment ranges as they were at the nearest checkpoint. Assets are immutable and content-addressed for this reason.

## 6. Comparing versions

The service computes comparisons, so clients stay thin and results are filtered by the caller's access.

- When the two versions are at most 2,000 commits apart and no snapshot commit lies between them, the diff is built from the recorded steps with `prosemirror-changeset`, which yields inserted and deleted spans that already carry the user and time of the commit that produced them.
- Otherwise the two documents are aligned by block identifier and a word-level diff runs inside blocks that changed. Authorship then comes from the attribution map.
- Tables are aligned by row and cell identifiers. Field values are compared by field identifier and reported as changes of kind `field`.
- Results are cached by the pair of sequence numbers.

The result is a list of changes keyed by block identifier:

```json
{
  "fromSeq": 380, "toSeq": 416,
  "changes": [
    { "blockId": "pA1b2C3d4E5f6G7h", "kind": "modified", "spans": [
      { "op": "insert", "at": 12, "text": "direct ", "user": "u_481", "seq": 401 },
      { "op": "delete", "at": 40, "text": "and indirect ", "user": "u_112", "seq": 410 } ] },
    { "blockId": "pQ9r8S7t6U5v4W3x", "kind": "added", "user": "u_481", "seq": 402 },
    { "blockId": "pZ1y2X3w4V5u6T7s", "kind": "removed", "user": "u_112", "seq": 411 },
    { "blockId": "pM5n6B7v8C9x0Z1a", "kind": "formatted", "attrs": ["style"], "user": "u_481", "seq": 415 },
    { "fieldId": "fQ2x8Lm0aZx1VbN7", "kind": "field", "user": "u_733", "seq": 412 }
  ]
}
```

The editor renders a comparison in the newer version's layout: insertions highlighted, deletions shown on demand so pagination does not shift, change bars in the margin, previous and next navigation, and a summary grouped by region. "Compare, then export as DOCX with tracked changes" reuses the same data.

## 7. Attribution

The room maintains an attribution map next to the document: an ordered list of runs, each covering a range of positions and naming the user and `seq` that inserted that content. Each step updates it: existing runs are mapped through the step's position map, and inserted content gets a new run. Formatting changes do not alter attribution in version 1. The map is saved with every checkpoint, so "who wrote this" is a lookup at any version.

Attribute changes are not in the attribution map. "Who filled this field" comes from the `field:<id>` scopes recorded with each commit, which is an index lookup.

Pasted text is attributed to the person who pasted it. When a restore brings back old blocks, the restored runs keep their original authors and are additionally marked as restored by the restoring user. Content written by an assistant is attributed to the person it acted for, with the agent named.

## 8. Restore and fork

- **Restore** always moves forward. The service records a `pre-restore` version first and a `restore` version after.
- **Restoring a whole document** is a snapshot commit: clients reload. It requires `manage` and is refused while a workflow is active.
- **Restoring one region** computes steps from the current region to the target content: blocks are aligned by identifier, unchanged blocks are left alone, changed blocks are replaced, missing blocks are inserted and extra blocks are removed. Comment ranges and attribution in unchanged blocks survive. If the steps would be too large for a commit, the restore falls back to a snapshot commit.
- The room re-checks the permission rules of 07, section 13, when it applies a restore, not only when the request arrives.
- A restored block gets a new identifier if its old identifier is in use elsewhere in the current document.
- A `dryRun` returns the comparison a restore would produce.
- **Fork** creates a new document from the content at a `seq`. The new document records where it came from and starts its own log. It is a service-credential operation (05).

## 9. Who can see history

Old versions can contain text that was deleted before a person was given access. The tenant chooses one setting per document or per tenant:

| Setting | Effect |
|---|---|
| `editors` (default) | People with `edit` somewhere in the document see full history. Everyone else sees named versions only |
| `all` | Everyone with `view` sees full history |
| `since_access` | A person sees history from the time in their token's `access_since` claim. It needs the host to supply that claim, because document-level access lives in the host |

The setting is enforced by one gate on every place a sequence number can be supplied, including channel resume (07, section 8).

## 10. Changes since last visit

The component stores a read marker (`seq`) per user and document when the user has viewed the head. On the next visit it asks for the activity since the marker, excluding the user's own commits, and shows it as a comparison with a summary per region, together with mentions and tasks addressed to the user.

## 11. Retention

- The default is to keep everything. Commit payloads older than 30 days move from PostgreSQL to compressed segment files in object storage; their metadata rows stay for listing, filtering and the hash chain. History across the boundary reads both.
- Checkpoints are thinned with age: all of them for 30 days, then daily, then weekly. Checkpoints that a stored version points at, or that border a snapshot commit, are kept.
- A tenant can choose thinning of payloads too: after a period, keep only checkpoints. Named, export and workflow versions are never thinned. Thinning leaves the chain verifiable, because the chain holds payload hashes.
- Legal hold suspends thinning and purge for a document.

## 12. Tamper evidence

The hash chain makes silent edits to stored history detectable, including by the operator, if the chain head is anchored outside the operator's control. The service therefore publishes the chain head in the `dep.document.changed` webhook and in every export manifest, so a host can anchor it itself, and periodically writes signed, time-stamped heads to write-once storage. Verification is a command-line tool and an audit export.

## 13. Privacy

- The log holds per-tenant surrogate identifiers, not the host's `sub` values. The mapping is one row per user in the document service. Erasing a person deletes that row: their contributions remain, attributed to an identifier that no longer leads anywhere. Hosts are asked not to use e-mail addresses as `sub` in any case.
- Erasing content means deleting the document: commits, segments, checkpoints, assets not used elsewhere, exports and search entries, with backups ageing out on their schedule. A single commit's payload can be replaced by a tombstone without breaking the chain.
- Optional per-document encryption keys allow deletion by destroying the key.

Whether these measures satisfy a particular regulation is a legal question for the operator.

## 14. Relation to suggestions

Suggestions are pending changes inside the document that someone must accept or reject. History is a passive record of what already happened. They share the rendering of insertions and deletions, the identity model and the DOCX writer (`w:ins` and `w:del` with author and date). Accepting and rejecting are ordinary commits with their own origins, so they appear in history too. The date shown for a suggestion is the server time of the commit that introduced it.

## 15. Open issues

- Diff quality for moved content, for table structure changes and for style changes is unproven.
- Replaying commits made under an older schema needs the matching older packages. Snapshot commits with checkpoints on each side limit how often that matters; the policy for how long old packages stay runnable is open.
- The size of the attribution map on very large documents, and whether it should be stored per block.
- Branches with merge (working drafts that are later merged back) are not designed. Fork is one-way.
