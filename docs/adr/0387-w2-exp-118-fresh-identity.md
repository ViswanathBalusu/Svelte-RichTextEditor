# ADR 0387: Fresh identity-bound values for a paragraph the source map does not know

Status: proposed (lane w2, 2026-11-18). Story: EXP-118, criterion 4.

## Context

ADR 0017 says that copies get fresh identity-bound values, as copies in Word do. The writer takes
those values from the source map by node identifier, so a copy (which has a new identifier) had
none.

## Decision

- A paragraph written from the model with no source-map entry gets `w14:paraId` (31 bits, eight
  upper-case hex digits, not zero, not used anywhere under `word/` in the package) and
  `w14:textId="77777777"`, the value Word writes for a new paragraph.
- Only in a part whose root declares the w14 namespace. Other parts are left as before.
- The value is the first 31 bits of SHA-256 of `w14:paraId:<node id>:<attempt>`, so one export of one
  document is repeatable. `attempt` rises on a clash.
- Not minted: `w:rsid*` values (revision sessions). A paragraph without them is valid, and Word adds
  its own on the next edit.
- Table rows and cells are not given values here; Word accepts rows without them.

## Open

The owner may prefer rows to carry `w14:paraId` too, or `w:rsid*` values from a session of the
export. Neither is needed for a valid file.
