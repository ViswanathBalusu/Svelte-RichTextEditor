# ADR 0425: The opt-in setting for page-break reconciliation compiles (BE-051)

Status: proposed (lane w5, 2026-11-25). The spec says page-break reconciliation is "opt-in per tenant"
(06 §10) and that level L1 of the page view needs the compile to report layout (09 §7). It names no
request option, no setting and no refusal code. No owner decision covers it (the owner's table has
decisions 26 and 29 on the page view, not on the setting). The points below are proposed.

## Decisions (proposed)

1. **The request option.** `options.layout` on `POST /documents/{id}/exports`, values `blocks`
   (default) and `lines`. `lines` is a compile that reports line starts (`layout.json` with
   `granularity: "line"`, 09 §7.1) for the page view's L1 level. It is the only compile this setting
   governs; a preview or export without the option, or with `blocks`, is not affected.
2. **The setting.** `pageBreakReconciliation`, a boolean per tenant, off by default. A tenant with no
   stored value, and a server composed without a settings store, have it off. The values live in
   `tenant_settings` (migration 0100) and are read through `TenantSettingService`.
3. **The refusal.** A `lines` request from a tenant that has not enabled it is refused with `forbidden`
   (HTTP 403) before any job is queued and before the data-loss prevention hook is asked. It is
   `forbidden` and not `validation_failed` because the request is well formed and the tenant is not
   permitted to make it. The message says that the compiles are not enabled for the tenant.
4. **Changing the setting.** `TenantSettingService.set` writes the value and an audit entry
   (`tenant_setting.changed`, with the previous and the new values); an unchanged value writes nothing.
   The REST route that calls it is part of the administration API (UX-076), which is not published, so
   no route was added. Until it exists an operator sets the value through the service or the table.
5. **The worker.** The compile worker's side of `lines` (reporting line starts for a job that asks) is
   EXP-057 and is built there; BE-051 enforces only the permission.

## Not decided here

- Whether a tenant administrator, as well as the service credential, may change the setting.
- Whether the compile minutes of `lines` compiles are weighted or metered separately (06 §12).
