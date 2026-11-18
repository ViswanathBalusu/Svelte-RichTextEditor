-- phase: expand
-- rollback: drop table document_templates; the previous release has no templates and never reads
--   it. Documents made from a template keep their content: a fork shares nothing with its source.
--
-- The templates of a tenant (12 §9; FRW-062; docs/adr/0406-w4-FRW-062-templates.md). A template is
-- a document marked as one: this row names the document and gives it a name. Creating a document
-- from a template forks the template document at a pinned seq (06 §4; the fork is recorded on the
-- new document), so nothing in this table is read once the new document exists. A document is the
-- template of at most one row.

create table document_templates (
  tenant_id uuid not null,
  id uuid not null,
  doc_id uuid not null,
  name text not null check (length(name) between 1 and 255),
  created_by text not null check (length(created_by) between 1 and 255),
  created_at_ms bigint not null check (created_at_ms > 0),
  primary key (tenant_id, id),
  unique (tenant_id, doc_id)
);

select docedit_protect('document_templates');

grant select, insert on document_templates to docedit_app;
-- The purge of a deleted document removes its rows (migration 0073).
grant select, delete on document_templates to docedit_purge;
