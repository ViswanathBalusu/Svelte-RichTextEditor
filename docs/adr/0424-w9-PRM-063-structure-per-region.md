# 0424 PRM-063: part of `structure` grantable per region

**Status:** the decision is the owner's (decision 128 of 2026-11-15, `docs/owner-decisions-2026-11-15.md`: "Grantable per region"; decision 220 repeats that ADR 0033 item 4 is reversed). The design below is proposed. It needs the owner's word on the two points under Questions before any story is built. Written 2026-11-25, lane w9.

## Context

Until now `structure` was document level only (07 §2; ADR 0033 item 4; ADR 0146). `ROLE_CAPABILITIES` in `packages/authority/src/permissions/model.ts` gives `structure` to `editor` and `owner`, and `validateRegionGrant` refuses a region grant that names any role beyond `viewer`, `commenter`, `suggester` and `editor`. A person who may edit only one region can apply existing styles there and nothing else (PRM-030).

Decision 128 reverses that: part of `structure` can be granted per region. It does not say which part, how a grant says it, or how the outcome check reads it. This record proposes the answers.

## Decision (proposed)

### 1. Which operations

`OPERATIONS` (PRM-001) lists the operations that need `structure`. Only the ones whose effect stays inside one region, or only adds, are candidates:

| Operation | Per region? | Why |
|---|---|---|
| `region.retitle` | yes | Changes the title of one region. The pane already offers it and refuses without `structure` (`permissions.rename.noStructure`). |
| `defs.add` | yes | Adds a new style definition, which nothing else uses until someone applies it. It never changes or removes an existing definition. This is the "new style" of 07 §17. |
| `section_break.change`, `doc.change` | no | A page setup, a landscape page or a document property reaches content outside the region. |
| `defs.change` (existing definitions), `story.change` | no | Changes how protected text outside the region looks or behaves (PRM-012). |
| `region.create`, `region.delete`, `region.split`, `region.merge`, `region.move` | no | They change the shape of the document and other people's regions (P2, PRM-011, PRM-065). |

A landscape page for one region is not offered in version 1. A page setup change moves the pages of the text around it, so it stays with `structure` at document level. A later decision can add it with a section that lies wholly inside regions the user may edit.

`manage` never becomes grantable per region.

### 2. How a grant says it

A region grant gets an optional member `structure`, a list of operation identifiers from the table above:

```
{ region, principal, role: 'editor', structure: ['region.retitle', 'defs.add'] }
```

- It is valid only with the role `editor`: without `edit` in the region the operations are useless, and a lower role never carries it.
- The list is closed. `validateRegionGrant` refuses any identifier that is not marked grantable in `OPERATIONS` (each entry gets a `perRegion` flag), so `manage`, `fill` and the operations marked "no" above stay unreachable from a grant.
- `ROLE_CAPABILITIES` is unchanged: the document-level `structure` of `editor` and `owner` stays as it is.
- The grant list and its `If-Match` revision (PRM-018, PRM-035) carry the member without change to the protocol rules; the schema in `packages/protocol/src/definition/resources.ts` adds the optional member and `pnpm generate` rewrites `spec/`.
- The access object a client holds (`scopes`) names the capability in the scope it applies to: `region:<id>` holds `structure` when the user may retitle that region. `defs.add` has no region, so the access object carries it as the scope `defs` holding `structure.add`, derived from any grant that lists it. The core shows or hides the controls from these (PRM-027).

### 3. How the outcome check evaluates it

Rule P2 (07 §5.2; PRM-011) reads: a change that needs `structure` is allowed if the user holds `structure` at document level, or if every operation in the change is grantable per region and the user holds a grant that lists it:

- a `region.retitle` change is allowed when the grant covers the region whose `title` changes, and the user has `edit` there;
- a `defs.add` change is allowed when the user holds any unexpired grant that lists `defs.add`, and the step only inserts a new `style_def` whose identifier no earlier commit used. A step that touches an existing definition is refused as before (PRM-012).

A change that mixes an allowed operation with one that is not is refused whole. The check reads grants as they stood at the commit's base (the grants revision, 04 G7), so a revoked grant stops working at the revision where the revocation commits. The cost is one lookup of the user's grants per structural step; steps that need no `structure` pay nothing (PRM-016).

### 4. Effects on the stories

- PRM-001 (role table, operations): the `perRegion` flag, the closed list and the new refusal text in `validateRegionGrant`. The comment on `ROLE_CAPABILITIES` that says region grants never convey `structure` is reworded.
- PRM-011 (P2): the rule above replaces "requires `structure`" for the two operations only.
- PRM-012 (definition protection): a region-only editor may add a style but may not change one; the check for "an existing definition changed" is unchanged.
- PRM-030 (region-only editors): the pane lets a user with the grant rename the region and add a style; the integration guide says what a region-only editor can and cannot do.
- PRM-035 and PRM-036 (grants pane): the grant row gets two checkboxes, shown only with `manage`.
- 07 §2, §5.2, §17 and ADR 0033 item 4 are reworded when the stories are accepted. ADR 0033 item 4 carries a pointer to this record now.

## Stories to write

1. Grant model: `structure` on a region grant, `perRegion` in `OPERATIONS`, validation, schema and generated artifacts (PRM-001, PRM-018).
2. Outcome check: P2 and PRM-012 read the grant for `region.retitle` and `defs.add`, with a test over every role and principal pair (PRM-011, PRM-012, PRM-016).
3. Access and pane: the access object carries the capability, and the permissions pane and the style controls follow it (PRM-027, PRM-030, PRM-035).

## Consequences

- A region-only editor with the grant can add a style and rename their region. Nothing else about the document's structure changes for them.
- Every grant list entry may now carry a member the older clients do not know. The member is optional and the list is closed, so an older client ignores it and still shows the role.
- The matrix (07 §12) row 10 stays as it is for grants; the new grant member is part of the same `manage` operation.

## Questions for the owner

1. Is the list of two operations (`region.retitle`, `defs.add`) the part of `structure` you want grantable, or should a page setup or a landscape page per region be in version 1 (it reaches the text around the region)?
2. Should a user with `defs.add` be able to remove the style they added, if no one has applied it yet? The proposal says no: removal stays with `structure` at document level.

## Revisit when

A region-only editor asks for something this list does not give them, or the integration guide is written.
