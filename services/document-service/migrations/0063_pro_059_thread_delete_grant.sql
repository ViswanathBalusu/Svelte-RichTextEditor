-- phase: expand
-- rollback: revoke delete on threads, comments from docedit_app; a thread then cannot be deleted
--   by the service (DELETE /threads/{tid} answers 500), and nothing else changes.

-- PRO-060 criterion 3 (lane U-PRO-052-068): the author of a thread, or a user with `manage`, deletes
-- it, and its comments go with it. The service role may delete threads and their comments for that
-- purpose only; the tenant policy of both tables (docedit_protect) still limits every delete to the
-- tenant. Comments are soft-deleted by their own route, so only this delete removes rows.
grant delete on threads, comments to docedit_app;
