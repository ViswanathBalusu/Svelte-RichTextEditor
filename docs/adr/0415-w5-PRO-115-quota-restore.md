# ADR 0415: How the kit puts a tenant's quotas back (PRO-115)

Status: proposed (lane w5, 2026-11-18). The owner has not decided this.

## Context

The `registry` profile of the kit provokes `quota_exceeded` and `rate_limited` by lowering the
tenant's own quotas with `PUT /quotas` (06 section 12; 05 section 6.2), making the call that must be
refused, and putting the quotas back. Setting a quota to 0 for a moment affects every connection and
commit of the kit's tenant.

`GET /quotas` returns `null` for a dimension that is not set. `PUT /quotas` is declared to take
`null` in the OpenAPI schema (`QuotaSettings`), but the reference service answers `400
validation_failed` ("a whole number, 0 or more") for it. The prose of 05 section 6.2 says that PUT
"names the dimensions to set", so clearing a dimension is not specified either way.

## Decisions (proposed)

1. A scenario that lowers a quota needs the test-mode switch (`needs.testMode`), so it never runs
   against a tenant that serves real users. Without the switch it is skipped with that reason.
2. The kit restores each dimension it changed to the value it read first. A dimension that was not
   set (`null`) is restored as `Number.MAX_SAFE_INTEGER`, which is no quota in practice, because a
   dimension cannot be cleared through the API as the service has it.
3. Open question for the owner: should `PUT /quotas` accept `null` to clear a dimension? If it does,
   the kit restores `null` and decision 2 goes. The reference service and the spec change together.
4. The flood scenario (`registry.rate_limited.socket`) sends 3,000 `ch.open` messages for a document
   the token does not cover. The figure is provisional: the spec names no limit. A server that
   answers all of them without `rate_limited` makes the scenario skip, not fail.
