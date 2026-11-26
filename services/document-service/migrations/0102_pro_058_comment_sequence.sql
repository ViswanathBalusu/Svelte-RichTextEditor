-- phase: expand
-- rollback: roll the service back first, then drop the column comments.seq, the column
--   read_markers.comment_seq and the table comment_counters. A release before this one never reads
--   them; the comment positions and the comment markers made since are lost with them.

-- A comment has a sequence number of its own, per document (PRO-058; owner decision 73; ADR 0428).
-- The counter table holds the last number given, so a number is never given twice, also after a
-- thread and its comments are deleted. A comment made before this migration has no number: the
-- activity reads it as 0, which is never above a marker. (Migrations after 0007 are not in a
-- release yet, so no released database holds such a comment; BE-016.)
alter table comments add column seq bigint check (seq is null or seq > 0);

create table comment_counters (
  doc_id uuid primary key references documents (id),
  tenant_id uuid not null,
  last bigint not null check (last >= 0)
);

select docedit_protect('comment_counters');
grant select, insert, update on comment_counters to docedit_app;

-- How far a user has read the comments of a document. Like `seq`, it only moves forward: the
-- service writes it with `greatest`.
alter table read_markers add column comment_seq bigint not null default 0 check (comment_seq >= 0);
