# 0382 UX-101: how a client learns the export targets

**Status:** accepted, option 1 (2026-11-18). Proposed on 2026-11-17 by lane w3. The owner accepted the proposed defaults in bulk (decisions 116 to 220 of docs/owner-decisions-2026-11-15.md; this point is not in the file's list of points that are still open), so the recommended option stands. Built on 2026-11-18 (lane w3, round 2): the discovery document (05 §2) has an optional member `exportTargets`, present when `exports` is announced; the document service fills it from `DOCEDIT_EXPORT_TARGETS`; `backend-dep` reads it and the exports port answers `targets()`; the element's export service offers those targets (the PDF and the LaTeX bundle first, then the others in the order announced) and the fixed list when the deployment does not say. The member is in the discovery document and not in `welcome`, because discovery is what the client reads first and needs no session.

## Context

UX-101 criterion 1 says the export dialog offers "the targets the deployment announces". The service holds the list in its configuration (`exportTargets` in `services/document-service/src/config.ts`, default `['pdf']`, set with `DOCEDIT_EXPORT_TARGETS`) and refuses any other target with `validation_failed` (`export-routes.ts`). Nothing in the protocol carries that list: `Capabilities` (05 §8.3) has features, limits and CDM ranges, and the `exports` feature says only that export jobs exist. A client cannot learn the targets before it asks.

## What this lane built

The element now builds the dialog's export service (`packages/element/src/export-service.ts`) when the session's backend has the exports port and announced `exports`. Its target list is the fixed constant `EXPORT_TARGETS`, `pdf` then `tex` ("the PDF and the LaTeX bundle first", UX-101). A target the service does not support is refused by the service, and the dialog says the export did not start. With the service default (`['pdf']`) the LaTeX bundle is offered but refused.

This is a stop-gap, not a decision. The criterion is left unticked.

## Options

1. Add `exportTargets: string[]` to `Capabilities` (05 §8.3), filled from the service configuration. The element reads it at connect. This is a change to `spec/dep` and to the generated types, and needs a minor version of the protocol.
2. Add `GET /exports/targets`. One more route for one list.
3. Keep the constant and make the service default `['pdf', 'tex']`. Then the dialog and the service agree without a wire change, but a deployment that turns `tex` off still sees it offered.

Recommendation: option 1. The client already reads capabilities once per connection, and the list is small.

## Consequences

If the owner accepts option 1: 05 §8.3 and the protocol definition change (PRO lane), the service fills the field, `exportService` takes its targets from the backend's capabilities, and UX-101 criterion 1 can be ticked with a test that two deployments with different lists show different dialogs.
