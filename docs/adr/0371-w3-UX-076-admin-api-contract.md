# ADR 0371: The administration API contract as it stands (UX-076)

Status: proposed (lane w3, 2026-11-17). Nothing here is decided by the owner. It records what the published contract defines, where it departs from the story, and what would close the gap.

## Context

UX-076 asks for the administration resources of 13 §10 (tenants, signing keys and allowed origins, quotas, fonts, retention, webhooks, usage figures) as machine-readable definitions in `spec/`. The OpenAPI document `spec/dep/dep-1.openapi.json` is generated from `packages/protocol/src/definition/resources.ts`. Several stories have already added their routes there (UX-077 to UX-081). `packages/protocol/test/ux-076-admin-contract.test.ts` reads the document and checks the points below.

## What the contract defines

| Resource | Routes |
|---|---|
| Webhooks | `GET`, `POST /webhooks`; `GET`, `PATCH`, `DELETE /webhooks/{id}` |
| Audit | `GET /audit` |
| Retention | `GET`, `PUT /retention`; `GET`, `PUT /documents/{id}/retention` |
| Holds | `POST /documents/{id}/holds`; `GET /holds` |
| Origins and keys | `GET /origins`, `GET /keys` (read only) |
| Quotas | `GET`, `PUT /quotas` |
| Fonts | `GET /fonts` |

Every one of them answers errors as `application/problem+json`. Every one except `GET /fonts` names the service credential alone, so a user token never grants access. `GET /fonts` accepts either, because the editor reads the registry. The paged lists (webhooks, audit, holds) return `{ items, nextCursor }` and take `cursor` and `limit`, with `limit` at most 200. `ETag`, `If-Match` and `Idempotency-Key` on every route are PRO-002's test.

## Gaps found

1. **No definition for tenants or for usage figures.** The test pins this, so a later definition shows up as a failing expectation to update. Usage figures are also UX-078 criterion 2.
2. **The keys and origins are not paged lists.** `GET /keys` returns `{ keys }` and `GET /origins` returns `{ origins }`. The story says administration lists use `{ items, nextCursor }`. Both collections are small and held with the tenant registration, so this may be a reasonable exception. The change to `{ items, nextCursor }` would break the routes UX-077 built. The owner should say which. Until then the test pins the present shape.
3. **No operator.** The story says the contract states who may call, "operator, tenant administrator". The contract has one administration credential: the tenant's service credential. There is no credential for a person or tool that manages tenants across the service, and the credentials model is an open question (story Notes). Without it `/tenants` cannot be given a security scheme.
4. **"Signing keys" is ambiguous.** The contract has the token verification keys of a tenant (05 §3.2). The sealing keys of PDF signatures (10 §6) are a separate, open question and have no route.

## Proposal, not made

- Define an `operatorCredential` security scheme, distinct from `serviceCredential`, and put the tenant routes under it (`GET`, `POST /tenants`, `GET`, `PATCH /tenants/{id}` with a suspended state). Only an operator may call them. This needs the owner's credentials model first.
- Define `GET /usage` with `from` and `to`, answering one figure per quota dimension of `QuotaSettings`, with no document content and no personal data (UX-078 criterion 2).
- Say, for keys and origins, either "bounded collections, exempt from paging" in 05 §6, or move them to `{ items, nextCursor }`.

## Versioning

The compatibility check of PRO-006 (`packages/protocol/src/generate/compat.ts`) reads the OpenAPI document and so covers these routes once there is a baseline to compare with. The baseline is an open owner question (PRO-006), so criterion 5 is not claimed here.

## Consequences

No criterion of UX-076 is ticked by this record. Its test is a regression guard on the part that exists.

## Update (lane w3, 2026-11-26): owner decisions applied

Owner decisions 68 (credentials), 69 (usage window), 112 (signing keys), 74 (compatibility baseline) and the bulk acceptance of proposed defaults (196 to 220) settle the gaps above. The contract now says:

- **Two credentials.** The tenant administrator credential is the tenant's service credential (`serviceCredential`): bound to one tenant, it manages that tenant's resources. The operator credential (`operatorCredential`, a new bearer scheme) is for every tenant and manages tenants only. A user token never grants access to either. A service credential on an operator route, and an operator credential on a tenant route, are `forbidden`. Row 14 of the matrix of 07 section 12 (`operator`) carries the four tenant routes; row 13 gained `GET /usage` and `GET /sealing-keys`.
- **Tenants.** `GET`, `POST /tenants` and `GET`, `PATCH /tenants/{tenantId}` (operator credential): a tenant has an identifier, a name, a state (`active` or `suspended`) and a creation time. The shapes are proposals; the spec gave none.
- **Usage.** `GET /usage?month=YYYY-MM` (tenant administrator): one non-negative integer for each quota dimension of `QuotaSettings`, over the calendar month in UTC (decision 69), no document content and no personal data. The figures are the largest value reached in the month for the rate and concurrency dimensions, and the amount used for storage and minutes.
- **Signing keys.** Token keys stay at `/keys` (and `/keys/{kid}`). PDF sealing keys are a section of their own, `GET /sealing-keys`, which lists public facts only (identifier, algorithm, certificate thumbprint, subject, expiry). There is no write route: production custody of sealing keys is open (decisions 221 to 223 allow development choices only).
- **Keys and origins are exempt from paging.** They are small, held with the tenant registration, and answer as `{ keys }` and `{ origins }`. 05 section 6.1 now says so. This is the first option of the proposal; the owner may still ask for `{ items, nextCursor }`.
- **Versioning.** Only additive changes within a major version (05 section 1) is PRO-006's check. Decision 74 makes the first public release its baseline; until one exists the comparison has nothing to compare with, so criterion 5 stays open.

Not done: the service implements none of the new routes (the pipeline refuses a user token with `forbidden` before it looks for a handler, and answers `not_found` for an operator or administrator credential until a handler exists); a negative test for a caller of another tenant needs a second credential, which the conformance kit's three inputs (05 section 11) do not include.

## Update 2 (lane w3, 2026-11-26): the kit's negative tests

Proposed, not an owner decision: the kit gets one optional input, `otherCredential` (environment variable `DEP_TCK_OTHER_CREDENTIAL`), a service credential of a second tenant. 05 section 11 names three inputs and says the kit needs nothing else; the optional inputs already in the kit (origin, receiver, authority service) widen what it can check and leave the three unchanged, and a scenario that needs a missing one is skipped with the reason. `authz.anonymous` needs no new input: it calls every route of rows 13 and 14 with no credential and with a credential nobody issued. `authz.other-tenant` needs the second credential. Tenant-wide routes with no identifier (a quota write, a retention write) answer a second tenant with that tenant's own data; the scenario checks that none of the kit tenant's data appears in them and calls the routes that name a kit resource (document, hold, webhook, key, origin) and expects a refusal or not found.
