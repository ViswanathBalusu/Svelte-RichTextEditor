# 0427 The consent step on the screen (FRW-044)

Status: proposed (lane w4, 2026-11-26). It extends ADR 0395 (the consent route and the text store). None of the points is the owner's decision; each takes the smallest reading of 12 §8.1 step 1.

## Context

ADR 0395 built the service half: the participant's acceptance is recorded with the service's own hash and time, and a sign request without it is refused. The screen was open: the text did not reach the client (no read route), and no dialog showed it, offered the accept control or offered a decline.

## Decision (proposed)

1. **A read route.** `GET /documents/{id}/workflow/participants/{pid}/consent` (operation `getParticipantConsent`; the method is assumed, G95) answers `{ textId, version, text, acceptedAt }` for the participant the token is bound to, with `Cache-Control: no-store`. It has the same preconditions as the acceptance (a `filler` or a `signer`, a `sent` or `in_progress` workflow, the access code given when required, a text held) and the same refusals. `acceptedAt` is null when there is no acceptance on record for this very text; an earlier acceptance of a text that has since changed does not count (ADR 0395 item 6). Reading writes nothing. The service credential and other participants are `forbidden`.
2. **A port member.** `WorkflowPort.consent(docId, participantId)` calls it (`backend-dep`); the acceptance stays `participant(..., 'consent')` with an empty body, so the client still supplies no text, hash or time.
3. **The step is part of the signing dialog.** `SigningService.consent` (optional) is a `ConsentService` with `load`, `accept` and `decline(reason)`. While it is present, the dialog opens on the consent stage and offers neither the adoption nor the signing until the acceptance is on record (`stageOf`, `signingOffered`). A participant with nothing to accept (`conflict`: no text named, a kind that accepts none, or no workflow port) goes on to the adoption; the service still refuses a signing that needs an acceptance, so this lets nothing through. A text that cannot be read blocks signing and offers a retry.
4. **Nothing is pre-selected.** The step has two buttons, accept and decline, and no checkbox. The text is in a focusable region (a scrollable region must be focusable) that is named and described, and focus goes to it when it appears.
5. **Decline.** The decline control opens a reason field; a blank reason is refused in the dialog and by `decline` before the call. The call is the participant's own `decline` endpoint (FRW-033). After it the dialog says nothing was signed and offers no signing.
6. **Words.** The strings are in the late `dialogs` group (`consent.*`), so the first load does not carry them (FND-008).

## Not decided

- Where consent texts are authored, stored and localised (ADR 0395 item 1): the screen shows whatever the store returns.
- Whether the step should also appear for a participant who only fills (no signature field). Here it appears when the participant opens the signing step.
- A real screen reader (NVDA, JAWS, VoiceOver) has not been run on the step; the checks are the accessibility tree (role, name, description) in three engines, axe, and the keyboard.
