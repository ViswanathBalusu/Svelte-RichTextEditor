-- phase: expand
-- rollback: roll the service back first, then drop index grant_history_transition and column
--   grant_history.transition_key. A release before this one never reads them: it writes no key, and
--   a transition it repeats after a stop may raise a second grants revision, as it did before.

-- A workflow transition that keeps the lock of the state it leaves still raises a grants revision,
-- so that it has a control commit of its own (12 section 6.2; FRW-030; ADR 0382 point 6). A process
-- that stops after the revision and before the workflow row moves repeats the transition. The key
-- names the transition (the workflow revision and state it leaves, the state it enters), so the
-- repeat finds the revision the first attempt raised and raises no second one: the control commit
-- is written once. A revision with no key (every other change of grants) is unaffected.
alter table grant_history add column transition_key text;

create unique index grant_history_transition
  on grant_history (doc_id, transition_key)
  where transition_key is not null;
