# ADR 0033: Permission rules the specification leaves open

**Status:** proposed, 2026-11-06. Written while building PRM-001, PRM-004, PRM-007, PRM-008, PRM-010 to PRM-012, PRM-034, PRM-056, PRM-063 to PRM-067 and FRW-007 to FRW-010, FRW-088 in `packages/authority`. Not reviewed by the project owner. Where a point is the owner's to decide, this record takes the specification's default and lists the question at the end.

**Update, 2026-11-18 (lane w9):** owner decision 220 of 2026-11-15 ([owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)) accepts the proposed defaults of pending item 28, so item 3 (splits and merges, PRM-065) is accepted as written. The tests that follow it are `packages/authority/test/outcome.structure.test.ts` and the `perm-region.split-merge` and `perm-region.split-restricted` scenarios of the conformance kit (`packages/tck/src/profiles/perm-structure.ts`).

## Context

07 and 12 state the permission rules, ADR 0009 made a region a container node, and ADR 0019 (proposed) adds read restrictions. Building the outcome check met points that the text leaves open, words for a design that changed, or states only in part. Each is recorded here with the reading the code follows, so that none is decided silently.

## Decisions (proposed)

### 1. Rule modules and failing closed (PRM-010)

The outcome check has a core and registered modules (`src/permissions/registry.ts`).

- The core justifies a changed scope only by `edit` (P1). It holds every rule that forbids: P2, the `manage` operations, 07 §5.3, P8, P9, and the rule of item 7 below. P6 runs before any comparison. P3 and P5 run with the invariants (04 §5 step 6).
- Two rules permit without `edit`, and they are modules: P4 (`SUGGESTION_RULE`) decides scopes where the user has `suggest` but not `edit`; P7 (`FILL_RULE`) decides field values the user may not change under P1. `STANDARD_RULES` registers both, and is used when a caller passes no registry.
- A scope routed to a module is justified only by that module's positive verdict for that scope. A module that is missing, throws, or answers anything but `ok: true` leaves the scope refused.

The security argument: acceptance is a conjunction over the differing scopes, and a module can only supply a justification for a scope the core routed to it, by capabilities the core computed. Removing a module can therefore only refuse more (a property test checks that the accepted sets are nested: none, each module alone, both). No module is consulted for a scope that P1 decides, and no module's verdict reaches a rule that forbids.

### 2. P3 for container regions (PRM-011)

P3 speaks of a region's "two boundaries", wording from the paired-marker design. With a container node the boundaries are its opening and closing tokens. The rule is checked on the steps, with the invariants, and refuses with `invalid_op` (07 names no code; P5 uses the same step): a `replace` step removes the tokens in `[from, to)`, a `replaceAround` step those in `[from, gapFrom)` and `[gapTo, to)`, and a step that removes exactly one token of a region is refused. Deleting or unwrapping a region removes both and is a whole-node operation. Inserting tokens never removes an existing region's, so a split passes P3 and is judged by P2 as a new region. A join of two adjacent regions removes one token of each and is refused; a merge is written as whole-node operations (item 3).

ProseMirror never leaves half a region in the tree, and the outcome check already sees content crossing a boundary as a change to both scopes, so P3 adds no protection the outcome check lacks. It keeps splits, merges and moves as operations whose identity the outcome check can follow. It is the only permission rule that looks at steps.

### 3. Splits and merges (PRM-065)

- **Split.** The part that keeps the region's identifier keeps its grants, state and lease, which are keyed by identifier. The other part is a new region: a fresh identifier (I2, I3), no grants, state `draft`, and the policy the commit gives it. Creating it needs `structure`, `edit` in the body and, for any policy but `inherit`, `manage`. So splitting a restricted or confidential region needs `manage` unless the new part is `inherit`; that moves blocks out of the protection, which a user with `edit` in the region can also do by moving them.
- **Merge.** One region is deleted as a whole node, so its identifier, grants, state and lease are retired (I3, PRM-003), and its blocks are moved into the other, which keeps its identifier, policy, grants and state. It needs `structure` and `edit` in both regions and the body. An approved region gives no one `edit`, so it can take part in neither.

### 4. `structure` stays document-level (PRM-063, the specification's default)

No part of `structure` is grantable per region. The role table, P2 and 07 §5.3 stay as they are. A region-only editor can apply existing styles in the region but cannot create or change definitions, page setups, headers or footers (PRM-030). The integration guide must say so when it is written.

### 5. No size quota per region (PRM-064, the specification's default)

Version 1 has no per-region quota. The risk stays: a user who may edit only one region can grow the document up to the 16 MiB limit of I7, and add fields up to the limits of I15. If a quota is wanted, `quota_exceeded` (05 §5.8) exists, and the outcome check can compare a region's canonical size before and after, at a cost proportional to the changed region.

### 6. The operations of `structure` and `manage` (PRM-001)

`OPERATIONS` in `src/permissions/model.ts` lists each operation once, with the capability it needs and who enforces it, and rejections cite it ("`region.policy` needs `manage`"). Three readings: creating a region with a policy other than `inherit` is `region.create` plus `region.policy`; switching `settings.trackChanges` off is `manage` (07 §5.2) and switching it on is `defs.change` (07 is silent; PRM-015); inserting a field with `sensitive` set is `field.sensitive`.

### 7. Sensitive values (ADR 0019 change 5; FRW-088)

- Readers of a value marked `sensitive`: users with `manage`, participants holding the field's assignee role, and principals with a grant on the region that contains the field. ADR 0019 says "principals named by a grant"; grants exist only on regions, so that is the reading. A field outside regions is read by the first two only.
- Setting or clearing `sensitive`, including by inserting a field with it set, needs `manage`. Otherwise an editor could delete a field and insert a sensitive copy to hide a value from colleagues.
- A user who cannot read a value can delete the field, but cannot change it in any way or move it to another container. ADR 0019 names the value and the default; the assignee, the container and the other attributes also decide who reads the value (changing the assignee to one's own role would reveal it), so the rule covers them all. Deleting reveals nothing; whether it should be allowed is ADR 0019's open question, and S12 allows it.

### 8. Confidential regions (PRM-004, PRM-066)

`confidential` gives an owner all four region capabilities, a holder of a matching grant (any role) that grant's capabilities, and everyone else nothing, not even `view`. A region is hidden from a connection exactly when it lacks `view` there. Setting or clearing the policy, or creating a confidential region, is `region.policy`. A policy value the authority does not know is read as `confidential`, the strictest. Whether a hidden region's title is shown is a document-wide option of the hidden-set function, hidden by default as in S12; a per-region setting needs a home in the CDM.

### 9. Fields

- A field whose static `readOnly` flag is set is not enabled for P7 (12 §3.2 calls `readOnly` the static form of what rules can disable).
- P7 reads the assignee of the field as it is after the commit. A fill-only user cannot change the assignee anyway (P1 on the field's container).
- P8 covers every way a client could set a server-set value: changing it, inserting a field of such a kind with a value (a pasted copy of a signed field), and changing a filled field's kind to such a kind. Only server-authored commits with origin `sign` or `rules` may. A restore, import or prefill that would set such a value is refused, which is the literal reading of P8 and of 12 §6.2 ("the body is never changed silently under a signature").
- P9 applies to every commit that changes a field value, an editor's included. 12 says "a fill commit"; the code keeps spike S3's choice, which never merges two values whoever wrote them (FRW-010).

### 10. Scopes and indexes

- `doc` holds the attributes of the `defs` node as well as those of `body`; before this, a change to them belonged to no scope. A story's own attributes belong to the story. The partition property test (PRM-008) found both.
- A refusal under 07 §5.3 names the definition and every region that protects it (PRM-012).

### 11. Expiry and the matrix

- The room exposes `nextExpiry` and `expire()`; the host calls `expire()` at that time (PRM-007). Commits never depend on it, since access is computed afresh for each. The projection gateway must derive visibility classes again at an expiry, not only when the grants revision moves (SYN-053).
- The authorisation matrix of 07 §12 is data (`src/permissions/matrix.ts`), published with the role table in `spec/permissions/permissions-1.json`. A route without a row is classified `public`, `fields` (12 §10) or `open`; `open` routes are listed in PRM-056's Notes.

## Consequences

Good: every permitting rule fails closed, every forbidding rule is in one place, the operations are cited by name, and the readings above are tested. Bad: P3 refuses some step shapes ProseMirror can produce (joins of adjacent regions), so the editor must write merges as whole-node operations; restores that would bring back a signed field are refused until the owner decides otherwise.

## Questions for the owner

1. Should part of `structure` be grantable per region (PRM-063)? The default is no.
2. Should a region have a size quota (PRM-064)? The default is no, with the risk above.
3. Do item 3's split and merge rules suit (PRM-065)?
4. Are the readers of a sensitive value those of item 7, and may a user delete a field whose value they cannot read (ADR 0019)?
5. Are titles of hidden regions shown, per region or per document (ADR 0019)?
6. May a whole-document restore bring back signature, date-signed and formula values (item 9)?

## Revisit when

The owner answers the questions above, ADR 0019 is accepted, or P4 is specified for block-level suggestions (PRM-062).
