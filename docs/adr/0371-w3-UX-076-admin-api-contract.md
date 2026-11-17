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
