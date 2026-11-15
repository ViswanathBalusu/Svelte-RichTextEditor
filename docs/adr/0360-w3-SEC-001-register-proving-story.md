# 0360. Lane w3, SEC-001: the proving story of a threat whose SEC story was merged away

**Status:** proposed (2026-11-15). Written by the developer of lane w3 for SEC-001. Not reviewed by the owner. Nothing here is an owner decision.

## Context

SEC-001 criterion 1 asks that each threat of 10 §3.1 to §3.8 has an identifier, the control, the epic and story that build it, "and the SEC story whose tests prove it".

One row cannot name a SEC story. The threat "Strict host policies" (10 §3.1) was to be proved by SEC-008. The cross-check of 2026-11-06 merged SEC-008 into FE-125, and the SEC epic says so in three places: the note under SEC-007 ("SEC-008 (...) was merged into FE-125"), the Coverage row for §3.1, and the line "Strict host policies | FE-125" of the table of proving stories. No SEC story for this threat exists any more.

Lane V-SEC-001-016 (2026-11-13) left criterion 1 unticked for this reason and asked the owner or the main session to choose between FE-125 and a SEC story.

## Proposed reading

The register follows the backlog as it stands:

- The row `T-3.1-host-policies` names FE-125 as its proving story, as the epic's own coverage tables do.
- The row records `mergedFrom: "SEC-008"` and a `provenByNote` that says why.
- `tests/security/test/register.test.ts` accepts a proving story outside the SEC epic only when the row names the merged SEC story, that story is no longer a heading of the epic, and the epic text records the merge into the story named. Any other row must name a story that is a heading of `docs/stories/SEC-security.md`.

With this reading criterion 1 is ticked: every threat has a proving story, and the one exception is the exception the backlog itself made.

## The other choice

Restore a SEC story for strict host policies (a verification-only story that depends on FE-125) and point the row at it. This undoes part of the 2026-11-06 cross-check and is the owner's or the main session's call. If it is taken, change `provenBy` in the row, remove `mergedFrom` and `provenByNote`, and the test needs no change.

## Other things recorded, not decided

- The prose of 10 §3.4 is one long sentence of rules. The register quotes five of its clauses (typed emitters, the math gate, the single-use sandbox, hostile outputs, two compiles before sealing) and the test checks that each quote is in the section. It does not check that every clause of that sentence has its own row; the clauses not quoted (no shell escape, file access, no network, hard limits, no credentials, and the rest) are parts of the sandbox control proved by SEC-035. The tables of §3.1, §3.2, §3.3, §3.5 and §3.6, the items of §3.7 and the sentences of §3.8 are checked row by row.
- The `status` of many rows is still `control-not-built` although their SEC stories now have tests in the tree (for example SEC-039). Criterion 2 allows that marking and the check passes. Bringing each row's status and test list up to date is not part of the open criteria of SEC-001; it is left for the stories that own those tests or for a follow-up.
- Second review items SR-C1 to SR-C4, SR-M1 to SR-M5 and SR-M18 (threats for read restrictions, ADR 0019, and preserved Word content, ADR 0017) are not rows of 10 §3 yet, so the register has no rows for them. They enter the register when 10 gains them.
