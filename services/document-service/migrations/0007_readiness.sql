-- Readiness (BE-001 criterion 5): the service reports not ready unless the newest migration applied
-- is the one its code expects, so the service role must be able to read the migrations' own
-- bookkeeping table. It holds no tenant data (BE-011 notes) and the service may only read it.

grant select on docedit_schema_migrations to docedit_app;
