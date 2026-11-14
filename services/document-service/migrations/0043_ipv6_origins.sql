-- phase: expand
-- rollback: none needed; the previous release writes only origins the old check allowed, which
--   the new check allows too.
--
-- Allowed origins with an IPv6 host in brackets, such as `http://[::1]:56490` (RFC 6454 and the
-- WHATWG URL standard serialise them so): the check of migration 0004 refused them, which stopped
-- a service whose tenants file listed one (ADR 0054). Relaxing a check is an expand step: every
-- origin stored before satisfies the new one.

alter table tenant_origins drop constraint tenant_origins_origin_check;
alter table tenant_origins add constraint tenant_origins_origin_check
  check (origin ~ '^https?://(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$');
