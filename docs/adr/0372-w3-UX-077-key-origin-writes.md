# ADR 0372: Writes for tenant keys and origins, and their audit (UX-077, UX-081)

Status: proposed (lane w3, 2026-11-17). The owner has not decided any of this. The spec names no route or body for registering a key or an origin (05 §3.2, §4; 13 §10 only says the administration API covers them), so the shapes below are a proposal.

## Context

UX-077 criteria 1 to 4 were ticked on the registry and on read-only listings. Criterion 5 (a change is audited) had no change to audit, because no route wrote a key or an origin. UX-081 criterion 5 needs the administration actions to be on the audit trail.

## Proposal

| Route | Body | Answer |
|---|---|---|
| `POST /keys` | `{ kid, use, alg, jwk, issuer? }` | 201 with the key as `GET /keys` lists it |
| `DELETE /keys/{kid}` | none | 204; 404 for an unknown key |
| `POST /origins` | `{ origin }` | 201 with `{ origin }`, normalised (`HTTPS://A.test:443` becomes `https://a.test`) |
| `DELETE /origins/{origin}` | none | 204; 404 for an origin that is not registered |

All four take the service credential only. `POST` takes `Idempotency-Key`. `DELETE` takes `If-Match` only as `*`, because a key or an origin has no entity tag.

- Only ES256, EdDSA and RS256 are accepted. A JWK with a private or symmetric member (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`, `k`) is refused with `validation_failed`, so private material never reaches the registry or an audit record.
- A key already registered under another identifier (same thumbprint), or an identifier registered for the other use, is `conflict` (409).
- The origin is percent-encoded in the `DELETE` path. The alternative, a query parameter, was not chosen because the other administration deletes name the resource in the path.
- Registering what is already there answers 201 and changes nothing. It is not audited a second time.

## Audit

Kinds `key.registered`, `key.removed`, `origin.added` and `origin.removed`, recorded after the change is stored, with the actor of the caller (the user named by `Dep-Actor`, else `system`). Data: `kid`, `use`, `alg`, `thumbprint` for a key; `origin` for an origin. This follows the retention, hold, quota and webhook records (UX-079, UX-080, UX-078). The record is not in the same transaction as the change, as for those.

UX-081 criterion 1 adds two points to the trail: `document.restored` (route `POST /documents/{id}/restore`; data `scopes: ['doc']`, `toSeq`, `seq`, `preRestoreSeq`) and the `workflowActive` member of `grants.changed`, which makes a workflow transition visible. The other kinds 07 §14 lists were already recorded (grant changes, region state changes and lease breaks as `grants.changed`; `session.revoke`; `commit.rejected`).

## Not decided

- Whether the credential that made the change should be recorded beside the actor. A service credential without `Dep-Actor` shows as `system`.
- Whether keys and origins should become paged lists (ADR 0371, gap 2).
- Tenants, fonts and usage figures have no write route or no definition, so UX-081 criterion 5 stays open for them.
