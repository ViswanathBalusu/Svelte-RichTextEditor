# ADR 0011: Field values live in the document tree; a `fill` capability limits a person to their own fields

**Status:** proposed, 2026-09-18, after the first review.

## Context

The product must let documents be filled and signed by assigned people under customizable rules, as e-signature products do (R13). Those products share one model: a field is a typed slot with an owner role and a data label; a template is a document with role placeholders; sending binds roles to people and freezes the body; after that only field values change.

The first draft of this spec had regions only. Regions are block containers directly under the body, so they cannot sit in a sentence or a table cell, and filling one would need `edit`, which lets a signer rewrite the surrounding text.

Two questions had to be decided: where field values are stored, and how the right to fill is enforced.

## Decision

- `form_field` is an inline atom in the CDM, reserved in version 1, with a key, a kind, an assignee that names a role placeholder, static flags, validation and a `value`.
- Values live in the document tree as the `value` attribute. A fill is an ordinary commit containing attribute steps.
- A new capability `fill`, a role `filler`, and a scope `field:<id>`. The authority's outcome check accepts, from a fill-only user, only changes to the values of fields assigned to their roles, while their participant is active, for fields that the rules show and enable, with correctly typed values (rule P7).
- Signature, initials, date-signed and formula values are written only by the server (rule P8).
- Fills are exclusive per field: a concurrent change to the same field rejects the later commit instead of merging (rule P9).

## Consequences

Good:
- One tree, one log: values get the same ordering, attribution, hash chain, comparison, time travel and export as all other content. "Who filled this, and when" is a query on the scopes recorded with each commit.
- The check is cheap: attribute steps have no position map, and the room keeps a field index.
- No second source of truth, and no second permission system.

Bad:
- Every participant can read every value. Hidden values would need the read restrictions that version 1 excludes. Since 2026-11-06 they are required; ADR 0019 proposes redacting values in per-reader projections, which keeps values in the tree.
- A whole-document restore reverts values, so it is refused while a workflow is active.
- A bulk send is one fork per recipient.
- Erasing one value means tombstoning commit payloads.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Values in a side table | A second source of truth with its own concurrency control, permission enforcement, history and export path |
| Fields as small regions with `edit` | Cannot be inline; `edit` allows changing more than a value; no typing, validation or rules |
| Assigning fields to users directly | Templates and reuse need role placeholders; people are bound per workflow |
| Merging concurrent fills | A half-merged amount or date is worse than a clear conflict |

## Revisit when

Values that some participants must not see become a requirement.
