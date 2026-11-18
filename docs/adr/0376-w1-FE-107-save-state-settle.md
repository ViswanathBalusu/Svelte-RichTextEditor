# ADR 0376: What the live regions say, and when (FE-107)

Status: proposed. Lane w1, 2026-11-17. For the accessibility specialist to confirm or change.

## Context

02 §10 says live regions announce saving, rejection of an edit, and arrivals and departures. It does not say which save-state changes, at what politeness, or which region owns each sentence. Two regions speak in the shadow root: the element's own (`live-region.ts`: save state and collaborators) and the shell's (`App.svelte`: refused edits, edits set aside, mode, and others). FE-107 criterion 7 says typing announces nothing.

Measured on 2026-11-17 in Chromium against the embed page's in-memory backend, before this change: typing 13 characters at 120 ms apart made 26 sentences in the element's region ("Saving changes." and "All changes saved." once per commit). That is a sentence for each keystroke, which criterion 7 rules out.

## Decisions (proposed)

1. A save state is announced only when it has held for a settle period and differs from the state last announced (`Announcer`, option `settleMs`). Each change of state starts the wait again. A run of commits that ends where it began says nothing. A save that takes long, a lost connection or a read-only reader is said once, and the state it ends in is said once.
2. The settle period is `DEFAULT_SETTLE_MS`, 1000 ms. This is a provisional default. It is not measured and not in the spec. The accessibility specialist should set it, and may want it configurable.
3. Refused edits and edits set aside for recovery are announced by the shell's region, from the shell's catalogue (`notice.refused.*`, `notice.rejected.*`), and not by the element's announcer, so the reader hears each once. The announcer still accepts these two notice kinds (`rejected`, `recovered`) for a host or test that feeds them; the element does not.
4. "Where it happened" (FE-107 criterion 2) is read as the kind of place, for example "this part of the document", and never a region name or identifier. A notice that named the region would tell a reader what a restricted region is called (ADR 0019). The words of the refusal give the reason.
5. Every announcement is `aria-live="polite"` (unchanged; see `live-region.ts`). Whether a refused edit should interrupt (assertive) remains open question 26.
6. The sentences of the element's region are in the shell's catalogue (`announce.sync.*`, `announce.presence.*`, `announce.edit.rejected`, `announce.recovered.count` in `packages/ui/src/i18n/en-GB.ts`), so the `locale` attribute and the host's `strings` apply to them. The English table in `announcer.ts` is a fallback for the time before the shell mounts.

## Consequences

Typing is silent unless a save is slow or fails. A screen-reader user who types and pauses does not hear "All changes saved." after each pause; they hear it only if a different state was announced before. If the specialist wants a confirmation after every pause, the change is the default of `settleMs` and the rule that equal states are not repeated, both in `announcer.ts`.
