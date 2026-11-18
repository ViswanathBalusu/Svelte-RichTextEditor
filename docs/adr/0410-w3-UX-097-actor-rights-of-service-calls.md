# 0410 UX-097: the rights of the user a service call names

**Status:** proposed (2026-11-18, lane w3). Needs the owner's word and the security review that owner decision 174 still requires.

## Context

Owner decision 174 says a service credential that names a user in `DEP-Actor` is bounded by that user's rights. 05 section 3.2 says so and adds that where the service does not hold a right of the user, it fails closed. UX-097 criterion 4 asks for the refusal.

What the service holds about a user: the region grants stored for the user (by surrogate), and the state of the document and of each region. What it does not hold: the user's document role and groups, which are claims of the host's user tokens (05 section 3.3). ADR 0379 (PRM-042; accepted with the other proposed defaults by decisions 196 to 220) applied the fail-closed reading to the history gate only, through `actingConnection` in `services/document-service/src/control-plane/gate.ts`.

The two content-changing calls a service credential makes:

- `PATCH /documents/{id}/field-values` (prefill) needs `manage` in the matrix (D145; the route's `guard`). A region grant never conveys `manage` (07 section 2), so a user who is a viewer with grants can never hold it.
- `PUT /documents/{id}/content` is row 13 of 07 section 12, a service credential only. The matrix names no right of a user for it.

## Why it is not decided here

Applying ADR 0379 to both calls would refuse every prefill and every replacement that names a user, because `manage` is never known. The first criterion of UX-097 (a call naming a user is attributed to that user) could then never hold on a real host. Not applying it leaves a service credential able to act for a user who may not do that. Which of these the owner wants is a security choice, so no code was changed.

## Options

1. **Fail closed, as ADR 0379.** A named actor is a viewer plus stored grants. Prefill and replacement naming a user are refused with `forbidden`. A host that wants the change either names no user (attribution `system`) or acts through the user's own token. Criterion 1 then holds only for calls the matrix lets a grant holder make.
2. **Bound by what the service can verify.** The service refuses only where no role could allow the call: an archived or locked document, an approved region, a region leased to someone else. The role stays the host's word. This never widens a right, and it keeps the integration working, but 05 section 3.2 would have to say the role is the host's responsibility.
3. **The host states the role.** A new header or body member carries the user's document role for the call. The host is trusted, but a second source of the role beside the token is a new wire field (a change to `spec/dep`).

## Proposed default

None is taken. The spec's text today is option 1; its consequence for criterion 1 is the reason for asking.

## Consequences

UX-097 criterion 4 stays unticked until the owner chooses. The conformance kit's scenario for the bound (a named user who lacks the right is refused) waits for the same choice (UX-096 criterion 5).
