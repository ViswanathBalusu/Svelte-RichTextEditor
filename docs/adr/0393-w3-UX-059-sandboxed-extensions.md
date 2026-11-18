# ADR 0393: build sandboxed third-party extensions (UX-059)

**Status:** accepted for the decision (owner decision 120, 2026-11-15, `docs/owner-decisions-2026-11-15.md`); the first read and write levels are those of ADR 0234, section B3, which owner decision 173 accepted. **Date:** 2026-11-18. **Lane:** w3.

## Decision

Tier 2 of 13 section 7.2 is built: third-party extensions run in a sandboxed iframe, talk to the editor only by message passing, and declare read and write levels. This reverses the spec default (11 section 7 and the story's `cond` note: tier 2 not built). The owner gave the decision as "Build them", with no named partner or author, no tier 1 usage figure and no security review estimate behind it.

## First read and write levels (for UX-060)

The manifest carries `access` (ADR 0234, B3), and the sandbox wrapper forwards only the operations the declaration allows (ADR 0234, B5):

| Declared | Values | What the wrapper forwards |
|---|---|---|
| `read` | `view` | Reads of the document, comments and fields within what the current user may read (07), through ranges mapped across edits (ADR 0234, B2). |
| `write` | `none` | No write operation. |
| `write` | `suggest` | Writes that arrive as suggestions of the current user. |
| `write` | `edit` | Writes that pass through the same guards as typing, as the current user. |

A call beyond the declaration is refused and logged (UX-060 criterion 2). A sandboxed extension never has more than the current user has, whatever it declares (UX-060 criterion 4). Reading "view or higher" in ADR 0234 as `view` only is this record's reading: no higher read level is defined yet.

## Spec changes made with this decision

- 13 section 7.2: the tier 2 row no longer says "later"; it is phase 4.
- 13 section 13: the open question is settled and points here.
- 10 (the supply-chain paragraph): sandboxed extensions are no longer "if they are ever built"; they are a planned exception with their own review (UX-060 criterion 6).

## Not settled by this record

- The evidence UX-059 criterion 1 asks for (named partners or authors, tier 1 usage, the cost of the security review) is not in the repository and is not recorded here. The decision stands on the owner's word.
- The security review of the sandbox and the supply-chain exception are UX-060 criterion 6 and are not done.
- The deprecation window (ADR 0234, B4) is still open, as is any read level above `view`.
