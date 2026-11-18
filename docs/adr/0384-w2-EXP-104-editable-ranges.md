# 0384. Editable ranges of a Word file become regions (EXP-104)

Status: proposed, except where it applies an owner decision. The owner has not decided the rest.

## Context

A protected Word file marks the parts anyone may edit with `w:permStart` and `w:permEnd` (07 section 15; 09 section 12). EXP-104 asks that ranges which cover whole blocks become regions, that the others are imported "as locked" and reported, and that no grants are created. The importer kept every such marker as a preserved atom and made no region. 07 section 15 does not say what "locked" means for content that cannot be a region, and the file's own document protection was not decided.

The owner decided on 2026-11-17 (`docs/owner-decisions-2026-11-15.md`, decision 53): protected parts become locked regions that the owner can unlock; the password is not carried over.

## Decisions

Applied from decision 53:

1. **Locked means a region with policy `restricted` and no grants.** The owner can unlock it by changing the policy or by granting roles. The importer never reads or keeps a protection password; `w:documentProtection` stays in the settings part as preserved content and is not turned into any model attribute.

Proposed here, where the spec and the decision leave a choice (each is in `packages/export-docx/src/regions.ts` and its tests):

2. **A range is an open region** (policy `inherit`) when both of its markers are children of the body and it holds whole blocks. Its region has a new random identifier; the Word `w:id` is not used.
3. **A range that starts or ends inside a paragraph or a table, or is a column range, becomes a locked region** that holds every block from the one with its start to the one with its end. The importer reports it with the identifier of the range, the body blocks it covers (as "body block N to M") and the editors the range named (`w:ed`, `w:edGrp`), as a warning and as an item of the report (kind `editable range`).
4. **Overlapping and nested ranges are merged into one region** that spans the union (I3: a region never nests), with a warning that names the ranges. The region is locked if any member is.
5. **A range that crosses a section break, has no end, no start, or an identifier used twice is not made a region.** Its markers stay as preserved content and a warning names it. A section break must stay a direct child of the body, so a region cannot hold the paragraph that carries it.
6. **A body paragraph follows every region** (03 section 4.2). When the next block is not a paragraph, the importer adds an empty one, recorded as synthetic, so it is not written back unless it is edited.
7. **The source map gives each region a container of its own** (`region:<id>`) with the blocks it holds. The markers stay in the gaps of the body, around the region, so an unchanged file is written back byte for byte and a regenerated block keeps them in place. The patching writer writes a region that has a source; it still refuses one that has none (a region made in the editor), as before.
8. **More than 500 regions** fail as a whole through the importer's own `validate()` (I7 `too_many_regions`), as in EXP-109.

## Open for the owner

- Whether "locked" should mean `restricted` as above, or something the permissions model will define later (PRM). The change is one attribute in `regions.ts`.
- Whether the content outside every editable range of a file with enforced document protection should itself become locked regions (the reading of decision 53 for the whole file). This lane did not do it: it wraps everything in regions, and a section break cannot sit inside one. It is not in the story's criteria.
- What the editor does with a region that has no grants and policy `restricted`: the import only produces it.

## Consequences

- The editable ranges of a protected file are no longer lost to the permission model; they arrive as regions without grants and the owner assigns roles.
- A document made of such regions needs the patching writer to handle the `region` node; it does for imported ones.
- The import route stores the envelope only, so a protected file whose preserved content is kept as assets fails I4 at the route until those assets are stored (EXP-098, EXP-099; noted in EXP-103).
