# 0426 Administration route for the evidence capture setting (FRW-042)

Status: proposed (lane w4, 2026-11-26). None of the points below is the owner's decision; each takes the spec's default or the pattern of the neighbouring administration routes.

## Context

12 §7 says a tenant can switch off the capture of the IP address and the user agent. The setting, its audit entry and its effect on evidence were built earlier (`captureEvidence`, `PgCaptureSettingsStore`). No route changed the setting, so criteria 1, 2 and 4 of FRW-042 were open.

## Decision (proposed)

1. **Resource.** `GET /workflow/capture-settings` and `PUT /workflow/capture-settings` (operations `getWorkflowCaptureSettings`, `setWorkflowCaptureSettings`). The path is assumed (G95), as the other workflow paths are.
2. **Body.** `{ "captureNetworkIdentity": boolean }` and nothing else; another member, or a value that is not a boolean, is `validation_failed`. The default is `true` (on): the reading recorded in FRW-042 Notes.
3. **Credential.** Service credential only, as `/history-visibility` and `/holds` are (13 §10). A user token or a participant token is `forbidden`, no credential is `unauthorized`. The host's tenant administration holds the service credential, so no second credential is made.
4. **Concurrency.** `ETag` is the version of the setting (`"0"` while the tenant has never changed it); `PUT` needs `If-Match` and answers `precondition_failed` for a stale version. A change to the value already in force changes no version and writes no audit entry.
5. **Audit.** The store writes the `capture.setting.changed` entry (actor surrogate, time, old and new value, version) in the transaction of the change on PostgreSQL; the memory store writes it to the audit trail straight after the change. The time is the service clock.
6. **Effect.** The evidence ledger reads the setting when it records an event, so a change applies to the events after it. Nothing rewrites stored evidence.

## Consequences

- The route is in the protocol definition (`frw.ts`), the permissions matrix (row 13), the TCK authorisation profile and 12 §10.
- A tenant administration screen (UX-076) can call the route; it is not built.
- Not decided: whether the setting is also offered per workflow or per template. This record covers the tenant only, as 12 §7 does.
