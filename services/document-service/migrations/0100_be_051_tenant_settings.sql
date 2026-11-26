-- phase: expand
-- rollback: drop table tenant_settings; no release before this one reads it. A tenant that had
--   enabled page-break reconciliation then has it off again, which is the default.

-- Settings a tenant switches on or off (BE-051; 06 section 10; 09 section 7). The first is
-- page-break reconciliation: compiles that report line starts for the page view's L1 level cost more
-- than a preview, so they are opt-in per tenant and off by default. A tenant with no row has every
-- setting at its default. The administration route that changes a setting belongs to UX-076; until it
-- exists the row is written by the operator.

create table tenant_settings (
  tenant_id uuid primary key,
  page_break_reconciliation boolean not null default false,
  updated_by text not null check (char_length(updated_by) between 1 and 255),
  updated_at timestamptz not null default now()
);

select docedit_protect('tenant_settings');

grant select, insert, update on tenant_settings to docedit_app;
