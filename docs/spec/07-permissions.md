# 07 Permissions

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Normative.

This document defines who may do what to which part of a document, and how the authority enforces it. The reasons for the design are in [ADR 0009](../adr/0009-regions-as-block-containers.md) and [ADR 0001](../adr/0001-server-authoritative-sync.md). Permission to fill fields is defined in [12](12-fields-rules-workflow.md), section 4, and uses the same machinery.

Version 1 controls who may change a part of a document. Since the owner's decision of 2026-11-06 (SPK-005) it must also be able to hide some regions and field values from some people who can open the document. The design is proposed in [ADR 0019](../adr/0019-read-restrictions-by-projection.md) and tested by spike S12. Until it is accepted, the rest of this document describes the rules for changing.

## 1. Concepts

| Concept | Definition |
|---|---|
| Capability | `view`, `comment`, `suggest`, `edit`, `fill`, `structure`, `manage` |
| Role | A named set of capabilities |
| Scope | Where content lives: `doc` (the top level of the tree: which stories exist, attributes of `body`), `body` (the body root), `region:<id>`, `defs`, `story:<id>`, and `field:<id>` for the value of a form field |
| Principal | `user:<sub>`, `group:<id>`, `everyone`, or `role:<id>`, which resolves to the participants bound to a role placeholder in the active workflow (12) |
| Region grant | (document, region, principal, role, optional expiry) |
| Region policy | An attribute of the region node: `inherit` or `restricted` |
| Region state | `draft`, `in_review` or `approved`, stored by the document service |
| Lease | An optional, temporary exclusive right to edit a region |

## 2. Roles

| Role | view | comment | suggest | edit | fill | structure | manage |
|---|---|---|---|---|---|---|---|
| `viewer` | yes | | | | | | |
| `commenter` | yes | yes | | | | | |
| `suggester` | yes | yes | yes | | | | |
| `filler` | yes | | | | yes | | |
| `editor` | yes | yes | yes | yes | yes | yes (document level only) | |
| `owner` | yes | yes | yes | yes | yes | yes | yes |

- `structure` covers creating, deleting, splitting, merging and moving regions, changing a region's title, inserting section breaks, and changing anything in `doc`, `defs` or a header or footer story, subject to section 5.3.
- `manage` covers region grants, region states, a region's `policy`, breaking leases, workflows, restoring, and deleting the document.
- Region grants use the roles `viewer`, `commenter`, `suggester` and `editor`. A region grant never conveys `structure` or `manage`.

## 3. Where permission data lives

| Data | Home | Why |
|---|---|---|
| Document-level role | The `docs` claim of the user's token | The host application owns sharing of whole documents |
| Group membership | The `grp` claim | The document service needs no directory |
| Region grants, region states, leases, workflow participants | The document service's database, with every change also recorded as a control commit in the document's log | They change while people are connected and must not depend on a new token; the log makes their order relative to content changes provable |
| Region identity, title, policy | The region node in the document | They are part of the document's structure and history |

Permission data is never stored in the document content other than the region's `policy`. Anything in the document can be changed by whoever may edit that part of the document; grants must not be.

When a region is deleted, its grants, state and leases are retired in the same transaction, and its identifier can never be used again in that document (invariant I3). A re-created region therefore cannot inherit stale grants or an old approval.

## 4. Effective capabilities

For a connection with document role `R`, user `sub` and groups `grp`, the capabilities in a scope are:

| Scope | Capabilities |
|---|---|
| `body` | The capabilities of `R` |
| `doc`, `defs`, `story:<id>` | `view`; plus `edit` when `R` includes `structure`, subject to section 5.3 |
| `region:<id>` with policy `inherit` | The union of the capabilities of `R` and of the best matching region grant, limited to `view`, `comment`, `suggest`, `edit` |
| `region:<id>` with policy `restricted` | The capabilities of the best matching region grant. With no matching grant: those of `R` limited to `view` and `comment`. An `owner` always has all four |
| `field:<id>` | 12, section 4 |

A grant matches when its principal is `user:<sub>`, `group:<g>` for some `g` in `grp`, `everyone`, or a `role:` the user's participant holds, and it has not expired. The best match is the one with the most capabilities. The principal `everyone` is not allowed on a `restricted` region: a grant of that form is refused with `validation_failed`, the permissions pane does not offer it, and a stored one conveys nothing. Granted on an `inherit` region it matches every connection. (Owner decision 12 of 2026-11-15, `docs/owner-decisions-2026-11-15.md`; PRM-061; ADR 0146.)

For an agent connection (05 section 3.2.1), the capabilities in every scope are the intersection of the capabilities the user `sub` would hold in that scope, by the rows above, and `{suggest}`. An agent connection never holds `edit`, `fill`, `structure` or `manage`, and holds `view` or `comment` only where the user does. It never gains a region grant the user lacks. The room computes this from the verified token, not from anything the client sends. A direct edit by an agent is refused by the server, not turned into a suggestion.

Then apply these limits, in order:

1. If the document's state is `locked` or `archived`: `view` only, plus `comment` when `locked`, plus `fill` where an active workflow allows it, plus `edit` in a region on which the connection holds a grant whose principal is `role:<id>` while the participant bound to that role is active in a workflow that is `sent` or `in_progress` and the document is `locked` (owner decision 132 of 2026-11-15; FRW-086, option a). No other grant keeps `edit` on a locked document, a grant to a role never conveys `structure` or `manage`, and the limits below (an approved region, a lease held by someone else) still apply. A paused participant (`correcting`), one who has completed, and a workflow that is `declined`, `voided` or `expired` hold no `edit`.
2. If the region's state is `approved`: at most `view` and `comment`, for everyone including owners. An owner must change the state before editing.
3. If another user holds a lease on the region: at most `view` and `comment`.

The room computes this map for each connection when the channel opens and again whenever anything that feeds it changes: grants, states, leases, the region list, the document's state, the workflow, a refreshed token. It schedules a recomputation at the earliest expiry of any grant or lease, so that expiries take effect without a triggering event. It sends the result as the `access` object (05, section 5.5).

## 5. Enforcement by the authority

Enforcement happens in step 7 of the authority algorithm (04, section 5), on the steps after rebasing, against the document as it is at that moment, with the permissions in force at that moment.

### 5.1 The outcome check

The authority does not try to work out from the shape of a step which part of the document it touches. Attribute steps and mark steps have empty position maps, and crafted `replaceAround` steps can do surprising things, so any rule based on ranges can be fooled. Instead it compares the document before and after the commit:

1. Partition both documents into scopes: `doc`, `defs` (per definition node), each `story`, `body` excluding regions, each region (its attributes and its content), and each form field's `value`.
2. Find the scopes that differ. ProseMirror shares unchanged subtrees between versions, so comparing by object identity finds them quickly, and only differing scopes are examined further.
3. The commit is accepted only if every differing scope is in the submitter's writable set under the rules below. Anything else is rejected with `permission_denied` and the list of offending scopes, whatever the steps looked like.

This check is the security boundary. It also gives spike S3 an oracle: no sequence of commits from a user may change a scope outside their writable set.

### 5.2 Rules

| ID | Rule |
|---|---|
| P1 | A scope may differ only if the user has `edit` there, unless P4 or P7 (12) applies |
| P2 | Adding, removing or moving a `region` or `section_break` node, or changing a region's `title`, requires `structure`, and `edit` in every region affected and in `body`. Changing a region's `policy` requires `manage` |
| P3 | A step may not remove or insert exactly one of a region's two boundaries. Structural changes are whole-node operations |
| P4 | Where the user has `suggest` but not `edit`, the scope's baseline MUST be unchanged, other users' suggestions and their marks MUST be unchanged, and every suggestion mark added MUST name the submitting user and use a suggestion `id` that belongs to them. The baseline is the content with every suggestion rejected: `ins` content removed, `del` marks ignored, `fmt` changes taken back to their recorded `before`; it includes attributes and bookmarks |
| P5 | A non-null `id` never changes (invariant I2) |
| P6 | Commits from a connection whose capabilities are only `view` or `comment` are rejected as `permission_denied` without further analysis. When the document's state is what limits them (`locked`, `archived` or a workflow; section 4, limit 1), step 1 of the authority algorithm rejects them with `read_only` first (04, section 5) |
| P7 to P9 | Filling and signing fields: 12, section 4.2 |

With `settings.trackChanges` set to `everyone`, P4 applies to every user, including editors, until someone with `manage` switches it off.

### 5.3 Definitions that affect protected regions

A style, numbering definition or page setup changes how every paragraph that uses it looks, including paragraphs in regions the person may not edit. Striking through, shrinking or recolouring the text of someone else's approved clause through its style would defeat the point of protecting it.

A change to a definition therefore requires `structure` and, for every region whose content references that definition directly or through `basedOn`, either `edit` in that region or `manage`. It is refused while any such region is `approved`. The room keeps an index from definitions to the regions that use them. In practice, once a document has restricted regions, shared styles such as `Normal` can be changed only by owners.

### 5.4 Cost

The room keeps indexes of region ranges, of definitions in use per region, and of fields, and updates them by mapping through each step and rescanning only what changed. The outcome check visits only scopes whose subtree identity changed. The P4 comparison looks only at changed blocks.

## 6. Comments

A comment thread targets a text range or a block. The range is not stored in the document. The document service keeps it, maps it through every commit, saves it with checkpoints, and tells clients where it is; clients keep their copy current by mapping it through the steps they apply.

- Creating a thread is a control-plane call. The room maps the requested range from its `baseSeq` to the head and checks that the caller has `comment` in every scope the mapped range covers, at that moment.
- A commenter never submits a commit, and commenting never changes the document. Comments therefore work on locked documents and during workflows.
- An editor cannot move or re-point someone else's comment. Deleting the commented text collapses the range; the thread is then shown as detached.
- A document has at most 5,000 threads.

## 7. Behaviour in the editor

These are requirements on the component's user experience. They are not security controls.

- Regions the user cannot edit are shaded and carry a lock indicator that says who can edit them. A command moves the caret to the next region the user can edit.
- The region guard refuses local transactions in scopes without `edit`, `suggest` or `fill`, so the user normally never sees a rejection.
- A region is isolating. Backspace at the start of its first paragraph and Delete at the end of its last do nothing. Enter at the end stays inside. Selections that start inside a region are clamped to it. There is always a body paragraph after a region (03, section 4.2).
- A deletion across several scopes removes only the parts the user may edit and says so.
- "Replace all" skips scopes the user cannot edit and reports how many matches it skipped. Where suggestion mode is on, each replacement is a suggestion: the match is marked deleted and the new text is inserted after it, marked inserted (owner decision 46).
- A user who may edit only regions can apply existing styles there but cannot change definitions, page setup, headers or footers.
- Numbering continues across region boundaries because it is computed (03, section 7) and is not stored in the content.
- In a scope where the user has `suggest` only, the editor is in suggestion mode and cannot leave it.
- The grants dialog, available with `manage`, finds users and groups through the host's `searchPrincipals` callback.

## 8. History visibility

Old versions can contain text that was deleted before a person was given access. One setting per tenant or document decides what each person may see (08, section 9). It is enforced by a single gate, `minVisibleSeq(user)`, applied to every place a sequence number can be supplied: content at a `seq`, history, comparison, attribution, activity, forks, exports at a `seq`, the commits resource, and `resume.seq` on a channel. A resume below the gate gets `catchUp: "reload"` instead of old commits. Read markers only move forward.

`minVisibleSeq(user)` is a sequence number: the lowest `seq` whose content the user may read. A single state (content at a `seq`, a version, one side of a comparison) is visible at or above it, at the head, and at a named version; the head is never blocked. A run of commits after a `seq` (`resume.seq`, `after`, `fromSeq`) may be sent only when that `seq` is at or above it, because the commits reveal every state up to the head; named versions do not open runs. A named version discloses its own content, its attribution map and a comparison with another visible state, which is computed from the two states and never from the commits between them. A person under `editors` who is not an editor reloads after a short disconnect unless they resume at the head. The gate is evaluated when a request arrives, so a change of setting applies at once to history already written and nothing is rewritten (owner decision 140; ADR 0034).

## 9. Live changes, revocation and races

- A change to grants, region states or leases is written to the database with a new grants revision. The log write of every commit is conditional on the grants revision it was checked against (04, G7), so even if the notification to the room is lost, no commit can be stored under permissions that have been replaced. The owning room is also notified, recomputes the affected connections, records a control commit, and sends `perm.changed`.
- A commit made under old permissions and processed under new ones is rejected with `permission_denied`.
- On such a rejection the client discards the rejected steps, keeps later local work where it still applies, puts the discarded content into the recovered-edits panel, and explains which region changed and who changed it if known.
- Document-level roles change when the token is refreshed (at most 15 minutes) or immediately when the host backend revokes the user's sessions. Revocation is remembered (05, section 3.3), so reconnecting with the old token fails.
- Group membership changes follow the same timing as document-level roles.

## 10. Leases

A lease gives one user exclusive editing of a region for a short time, for teams that want check-out behaviour. It is optional (feature `leases`). A lease has an identifier, a holder and an expiry (default five minutes); the holder extends it with a heartbeat, up to a maximum total of eight hours. It ends when released, when it expires, or when a user with `manage` breaks it. While a lease is held, other users' capabilities in the region are limited as in section 4. Leases are not locks in the document and are not needed for correctness. A lease changes nobody's grants, so a former holder's pending commit is checked as any commit is, under their grants once the lease has ended: it is accepted if the grants allow it and otherwise rejected with `permission_denied`, its content going to recovered edits (owner decision 135).

## 11. Region states

`draft` and `in_review` do not change capabilities; they are labels the host application can use for workflow. `approved` freezes the region as in section 4.

An approval is bound to what was approved: the state record holds the `seq` and the hash of the region's canonical content at the time, and the approval is a control commit in the log. Nothing, including server-authored commits, may change an approved region; an import, a restore or a repair that would do so is refused until the state is changed. State changes require `manage`, are audited, and raise the webhook `dep.region.state_changed`.

## 12. Authorisation matrix

| Operation | Requires |
|---|---|
| Open a channel, read content at the head, presence | `view` |
| Content, history, comparison, attribution, commits at an earlier `seq` | `view` and the gate of section 8 |
| Submit a commit | Section 5 |
| Create a thread, reply | `comment` in the scopes of the target |
| Resolve, reopen or assign a thread | `comment` in its scope; delete needs the author or `manage` |
| Upload an asset | `edit`, `suggest` or `fill` somewhere in the document |
| Read an asset | `view` on a document the asset is attached to; the uploader may also read their own ready upload for that document before a commit references it |
| Named version | `edit` somewhere in the document |
| Restore a region | `edit` in that region; not approved; not leased to someone else |
| Restore a document, grants, region state or policy, break a lease, workflow actions, delete | `manage` |
| Acquire a lease | `edit` in that region |
| Export | `view`, unless restricted with `no-export`; raw compile logs need `edit` |
| Import, fork, create, list, search, audit, webhooks, tokens, revoke, retention, history visibility, holds | Service credential |

Every row has negative tests in the conformance kit.

## 13. Interaction with history

- Restoring a whole document is a snapshot commit and requires `manage`. Restoring one region requires `edit` in that region. The room re-checks these conditions, and that no affected region is approved, when it applies the commit.
- A restore never brings back grants. Grants are current state, not document content.
- A region restore that needs a definition that no longer exists recreates it only if the user has `structure`; otherwise the restored paragraphs fall back to the default style, and the user is told.

## 14. Audit

Every grant change, state change, lease break, session revocation, restore, workflow transition, and every rejection with `permission_denied` or `invalid_op` is written to the audit trail with the actor, the document, the scopes and the server time. A content change made with a service credential (a prefill, a content replacement) is written as well, with the person it is attributed to (the user named in `DEP-Actor`, or `system`), the credential that made it and the commit's origin (owner decision 174). A service call that names a user in `DEP-Actor` is bounded by that user's rights and not by the credential's (05 section 3.2): the permission checks of this section and the history gate of section 8 apply to the named user, and the audit entry records both. Changes of permission state are also control commits in the hash-chained log. Rejections raise the throttled webhook `dep.commit.rejected`.

## 15. DOCX mapping

| Direction | Mapping |
|---|---|
| Export | A region becomes a block-level content control tagged with the region identifier and title. If any region is not editable by everyone, the file gets document protection in read-only mode and editable ranges (`w:permStart` and `w:permEnd`). Word matches editable ranges by e-mail address or domain account, and this system knows users only as opaque identifiers, so per-user ranges are written only when the host supplies export identities through an opt-in callback; otherwise only the `everyone` group is used. An approved region becomes a content control with locked content. The original grants are kept in a custom XML part |
| Import | Editable ranges aligned to whole blocks become regions. Ranges inside a paragraph, and column ranges in tables, are imported as locked and reported to the importing user. Imported files never create grants by themselves. Authors of imported tracked changes become labels, never user identities |

Word's protection is advisory: the file format specification says it is not a security feature. The enforcement described here exists only while a document lives in the document service.

## 16. Threat cases

| Attempt | Outcome |
|---|---|
| Send steps that edit a region without a grant | The outcome check finds the region changed: `permission_denied` |
| Use an `attr`, mark or node-mark step, or a crafted `replaceAround`, that a range-based check would not see | The outcome check does not look at step shapes |
| Send steps based on an old version to slip past a check | Checks run on the rebased steps against the current document |
| Delete or move a whole restricted region with document-level `editor` | P2 requires `edit` in the region |
| Wrap other people's content in a new region, or flip a region to `restricted`, to lock others out | P2: `structure` for the first, `manage` for the second |
| Restyle or hide someone else's protected text through its style, or renumber it | Section 5.3 |
| Cover another region in the PDF with an oversized or overlapping equation | The math gate bounds dimensions and removes overlap commands (09) |
| Put a suggested deletion on a whole restricted region | The region's scope differs; P4 needs `suggest` there |
| Reuse node identifiers, or re-create a deleted region's identifier to inherit its grants | Invariants I2 and I3 |
| As a suggester, change text directly, accept one's own suggestion, or take over someone else's suggestion `id` | P4 |
| Replay another user's commit identifier | 04, section 5, step 2 |
| Claim another identity in presence or in suggestion marks | Identity comes from the connection; marks are checked against it |
| Keep editing after a grant was removed, even if the room missed the notification | Section 9 |
| Reconnect after revocation with a token that has not expired | The revocation watermark |
| Read deleted text through old versions, catch-up or activity | Section 8 |
| Flood the authority with expensive commits | Admission control in 04, section 12 |

## 17. Open issues

- Read restrictions per region and per field value are required since 2026-11-06 (SPK-005). They need filtered content, filtered sync, filtered history and filtered export; ADR 0019 proposes per-reader projections of the one log.
- The P4 rules for suggested block-level changes are written and property-tested (PRM-062; ADR 0146, proposed). Version 1 supports paragraphs, whole table rows and whole tables, as 03 §5 says. Table cells and columns, figures, equations, `toc`, extension blocks and regions are not supported, and a suggestion on them is refused with `invalid_op`. The `perm-suggest` profile covers `ins`, `del` and `fmt` marks on text; block-level suggestions are tested in `packages/authority` and are not in the profile yet. The owner has not yet confirmed that whole tables belong in version 1.
- A user who may edit only regions cannot add a landscape page or a new style. Whether some of `structure` should be grantable per region is open.
- A per-region size quota would stop a region-only editor from filling a document to its size limit.
- A policy engine (for example OpenFGA or SpiceDB) can replace the grants tables behind `GrantStore` when groups nest or grants need conditions. Nothing in the protocol changes.
