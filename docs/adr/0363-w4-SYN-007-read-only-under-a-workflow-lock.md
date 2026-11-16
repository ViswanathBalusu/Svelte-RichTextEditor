# 0363. Lane w4, SYN-007: `read_only` for a change the workflow lock forbids

**Status:** proposed (2026-11-15). Written by the developer of lane w4 for SYN-007. Not reviewed by the owner. It applies the text of 04 §5 step 1 where two earlier lanes left the reading open (SYN-007 Notes, FRW-029 Notes).

## Context

04 §5 step 1 says: "If the document's state forbids the change (`locked`, `archived`, or a workflow that does not permit it), reject with `read_only`. This is checked first, so a connection whose capabilities the document's state has reduced (07, section 4) gets `read_only`, not `permission_denied`." 07 §5.2 P6 and FRW-029 criterion 1 say the same; FRW-029 adds "and with `permission_denied` for an out-of-scope change by a participant".

The room's step 1 can only look at the connection, not at the change. It refused with `read_only` when the document was not active and the connection had no fill allowance. The owner and editor roles carry `fill`, so while a workflow is `sent` or `in_progress` their commits passed step 1 and the outcome check refused a text change with `permission_denied`. The client then treats a locked document as a permission fault: it keeps recovered edits and refreshes permissions (04 §8), but does not switch to read-only.

## Decision (proposed)

Keep step 1 as it is. When the outcome check refuses a client commit with `permission_denied` and the document's state is not `active`, the room asks one more question: could the same connection have made the same change with the document `active` and no workflow running, everything else (grants, region states, leases, rules, suggestion owners, concurrent fills) unchanged? If so, the state is what forbids the change, and the rejection is `read_only` with action `drop`, the same scopes, and the reason "the document is locked". If not, it stays `permission_denied`.

So, while a workflow is `sent` or `in_progress`:

| Commit | Answer |
|---|---|
| An owner or editor changes text, structure or a field's attributes | `read_only` |
| An editor sets a field's value directly, where they could in draft | `read_only` |
| An active participant fills their own field | accepted (P7) |
| A participant changes text, or a field that is not theirs | `permission_denied` |
| An editor changes a region they have no grant on | `permission_denied` |

Server-authored commits are not reclassified. The second check runs only for a refused commit on a document that is not active, so the accepted path costs nothing more.

## Alternatives

- Make step 1 refuse every connection that is not an active participant. It needs the participant list in the room's step 1 and still gives `permission_denied` to an owner who is also a participant and edits the body.
- Remove `fill` from the owner and editor roles under a lock. It changes the role table of 07 §2 and what `access.fill` reports to the client.

## Consequences

- SYN-007 criterion 2 is met for the workflow case. FRW-029 criterion 1 now has the codes it names for the cases tested in `packages/authority/test/syn-007-workflow-lock.test.ts` and `frw-029.workflow-lock.test.ts`; it is not ticked by this lane.
- Not decided here: the code for a paused participant during `correcting` (12 §4.3 names `read_only`; `lockFor` returns null for `correcting`), and whether SR-M30 (recovered edits for every `drop`) should apply to `read_only`.
- A client that receives `read_only` switches to read-only (04 §8) and does not keep the rejected steps as recovered edits; that is the behaviour 04 §8 gives today.
