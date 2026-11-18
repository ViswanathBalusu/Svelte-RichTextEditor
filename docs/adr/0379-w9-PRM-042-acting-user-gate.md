# 0379 PRM-042: the history gate of the user a service credential acts for

**Status:** proposed (2026-11-17, lane w9). Needs the owner's word before the fork can rely on it in production.

## Context

`POST /documents/{id}/fork` takes a service credential only (05 §6.2; 08 §8). The host may name the user it acts for in `DEP-Actor`. PRM-042 criterion 4 says that when `atSeq` is below that user's gate the request is refused (07 §8).

The gate of a user depends on their document role and groups (the setting `editors` gives full history to a role with `edit`, or a grant of `edit` in a region). A user's document role and groups are claims of the host's user tokens (05 §3.3). A service credential carries neither, and the service does not store them. Only the region grants are stored. 07 §8 and ADR 0034 do not say which gate applies to a service credential that names a user.

## Decision (proposed)

- A service credential without `DEP-Actor` reads full history, as before. Nothing changes for it.
- With `DEP-Actor`, the gate is computed for the named user as a viewer without groups: `refuseSeqBelowGate` in `services/document-service/src/control-plane/gate.ts` builds the connection with `actingConnection`. The user's stored region grants count (a grant of `edit` in a region gives full history under `editors`). The `since_access` setting fails closed at the head, because no access claim is known.
- The head and any named version stay readable, as for every other route (ADR 0034).

The rule fails closed. A host that wants a fork of an old state for a user who holds `edit` by role either sends no `DEP-Actor` (the host has already decided) or the user gets a grant.

## Other options

1. Accept the role in a header or in the body. The host is trusted, but a second source of the role beside the token is a new wire field (a change to `spec/dep`).
2. Store the last document role seen in a token for each user and document. Stale roles would open history that a demotion should have closed.

## Consequences

- A fork for a named user can be refused where the host's own view says the user is an editor. The refusal is `forbidden` with the name `atSeq`.
- The same helper (`refuseSeqBelowGate`) serves the content route and the threads route, and admits named versions (PRM-042 criterion 6).
