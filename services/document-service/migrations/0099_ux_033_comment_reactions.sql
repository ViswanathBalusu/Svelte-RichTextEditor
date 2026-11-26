-- phase: expand
-- rollback: roll the service back first, then drop the column comments.reactions. A release before
--   this one never reads it; reactions made since are lost with it.

-- Reactions to a comment (UX-033; ADR 0424): a map from the name of a reaction to the people who
-- hold it, in the order they reacted. A reaction is not part of the document and makes no commit,
-- so it lives with the comment and not in the log. The default is the empty map.
alter table comments add column reactions jsonb not null default '{}'::jsonb;