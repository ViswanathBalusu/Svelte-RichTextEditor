# ADR 0381: A long formatted answer in a locked document (FRW-086)

**Status:** proposed, 2026-11-17. Written by lane w4. The owner has not settled it: Part B of `docs/owner-blockers-2026-11-17.md` lists it as a proposed default for the owner to review, and `docs/owner-decisions-2026-11-15.md` does not list it. No spec text was changed. The wording to apply once the owner confirms is below.

## Context

12 §3.4 says that a long, formatted answer is a region granted to a role (12 §4.3), not a field. 12 §6.2 says that `send` sets the document state to `locked`, and that while the workflow is `sent` or `in_progress` the authority accepts only commits allowed by P7 and P8. 07 §4, limit 1, leaves a locked document with `view`, `comment` and, where an active workflow allows it, `fill`. P7 and P8 change field values only. So a participant who holds a grant on a region cannot write in it once the document is sent. The two statements contradict each other (second review, SR-M26).

## Options

- **(a)** A bound participant may edit a granted region while the workflow is `sent` or `in_progress`. Limit 1 keeps `edit` in the regions granted to the participant's role.
- **(b)** Long answers are written before `send`. The region is then part of the frozen document, and the participant fills fields only.
- **(c)** The region is not part of the freeze: the body is frozen at `sentSeq` except the regions granted to roles, whose content is compared separately.

## Proposed default: (a)

It is the option recommended by SR-M26 and the default listed in `docs/owner-blockers-2026-11-17.md` ("the participant may edit their granted region"). It keeps the stated feature (12 §3.4) and needs no second kind of freeze.

### Effect on rule P7

None. P7 still decides field values only. Editing a region is decided by the ordinary outcome check (07 §5, rule P1 and the region's scope): the commit must lie inside a region on which the connection holds `edit`.

### Effect on 07 §4, limit 1

Proposed wording, replacing the first limit of 07 §4: "If the document's state is `locked` or `archived`: `view` only, plus `comment` when `locked`, plus `fill` where an active workflow allows it, plus `edit` in a region on which the connection holds a grant whose principal is `role:<id>`, where the participant bound to that role is active in a workflow that is `sent` or `in_progress`. No other grant keeps `edit` on a locked document, and a grant to a role never conveys `structure` or `manage`."

A participant who is paused (state `correcting`), who has completed, or whose workflow is `declined`, `voided` or `expired`, holds no `edit`: the exception follows `access.fill.active`.

### Effect on the freeze at `sentSeq`

The service records `sentSeq` and `sentHash` as 12 §6.2 says. They name the document as sent, the regions granted to roles included. After `send`, the content of a region granted to a role may change; nothing else in the body may. On `resume` the service compares the document with `sentSeq` outside the regions granted to roles (those are expected to differ), and a participant of a completed state is reset only if something outside them changed or a field of a completed participant changed.

### Attribution

An edit by a role-granted participant is an ordinary commit by that participant's `sub`, with origin `edit` and the scope of the region. It is attributed, compared and shown in the history like any edit, with the participant's name from the workflow. It is not a fill: the origin is `edit`, so it is not subject to `field_invalid` or `conflict` of P9.

### Under a signature

A signature records `seq` and the chain hash at the time of signing (12 §7). A region edited after that is a later commit, and the signature still names the earlier `seq`, so the sealed record shows what was signed. The risk is a signer who signs a document whose role region is still to be written. This record proposes no new refusal. It proposes that the pre-send checklist (FRW-027) warns, without failing, when a signer's `order` is not above the `order` of a participant bound to a role that holds a region grant. The owner decides whether that is a warning, a failure or nothing.

### Correction to 12 §6.2

Proposed wording for the row "While `sent` or `in_progress`": "The authority accepts only commits allowed by P7 and P8, and edits inside a region granted to a role whose participant is active (07, section 4, limit 1). Comments stay available, because a comment never changes the document (07, section 6)".

## Not decided

- Whether a participant who has completed keeps `edit` in their region (this record: no).
- Whether the checklist warning above is wanted.
- What a region grant to a role means after `decline`, `void` or `expired` (this record: nothing; the lock stays).

## Consequences

- FRW-086 stays unticked in all three criteria: each asks for the owner's decision or for the spec text that follows from it.
- FRW-012 can then be finished: the connection of a bound participant needs `participantRoles`, which the token binding (FRW-038) supplies, and limit 1 needs the exception above.
