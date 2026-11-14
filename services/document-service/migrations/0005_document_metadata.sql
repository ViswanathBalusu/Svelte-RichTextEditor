-- Document metadata as the control plane changes it (BE-035; 05 §6.1, §6.2). The metadata
-- revision is the document resource's ETag: every PATCH and DELETE raises it, and an update with a
-- stale If-Match changes nothing. Expand only: existing rows start at revision 1.

alter table documents add column meta_rev bigint not null default 1 check (meta_rev >= 1);
