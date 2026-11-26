# ADR 0424: The window during which CDM versions n and n-1 are supported (CDM-050)

Status: proposed. Lane w6, 2026-11-26. The first point rests on owner decision 75; the second and third are this ADR's reading and need the owner's word.

## Context

03 §11.3 says the service supports versions n and n-1 side by side "for a published window", and gives no number. Owner decision 75 (`docs/owner-decisions-2026-11-15.md`) says the supported format versions are n and n-1. CDM-050 criterion 6 asks the release notes to state the window. Decision 76 says version 2 exists only as a test-only version to exercise migrations; nothing ships, so no release has yet had two CDM versions.

## Proposed

1. **What is supported.** Versions n and n-1, where n is the newest CDM version a release ships (decision 75). A release holds one reader for each (`readerSet()` in `@docedit/model/validate`). A reader of a version that is no longer in the window may stay in history replay for as long as history is kept (decision 58, ADR 0384); that is a separate rule and is not the support window.
2. **The window is counted in versions, not in time.** Version n-1 is supported until version n+1 is released. The release that ships n+1 states in its notes that n-1 leaves the window with it. This follows from "n and n-1" and needs no calendar figure; 03 §11.3 gives none and this ADR does not invent one. If the owner wants a minimum time as well (for example "n-1 stays for at least a year after n"), the figure is theirs to set.
3. **What the notes say today.** `scripts/release/notes.ts` states the rule in point 2 and that no second CDM version has shipped yet, so the window has not begun. The table above it already gives the range the release supports.

## Not decided here

- A minimum duration in time for the window (point 2).
- Whether an operator may extend the window for a tenant that still embeds old components. 03 §11.3 already makes enabling n+1 an operator's act, gated on every node and component supporting it.
