# 0422. Who reads a sensitive value when the role comes from a workflow

**Status:** proposed, 2026-11-20. Written while finishing FRW-002 criterion 5 (lane w4). It follows ADR 0019 (read restrictions by projection), ADR 0033 item 7 and owner decision 156 of 2026-11-15 (docs/owner-decisions-2026-11-15.md: the readers of a hidden value are the assignee role, `manage` and grant holders). The owner has decided who the readers are. The points below are how the service finds out that a connection holds the assignee role; each takes the smallest reading that works and the owner may change any of them.

## What was wrong

A participant holds a role in one of two ways: the host puts the roles in the token (form mode without a workflow, FRW-083), or the token names a participant (`wfp`) and the room binds it to the participant the workflow records, with that participant's roles (FRW-038). The room computed access from the bound connection. What a connection may read was computed from the connection before the binding, which holds no role for a `wfp` token. So a participant of a sent workflow could not read the sensitive value of their own role, on the channel or over REST, and a fill of that field was refused with "sets a value you cannot read". Form mode was not affected. Found by `tests/security/test/frw-002-sensitive-readers.test.ts`.

## Decisions (proposed)

1. **One binding for access and for reading.** `connectionInWorkflow(conn, workflow)` in `packages/authority/src/workflow/binding.ts` is the room's binding as a pure function. The room computes access from it as before. The projection gateway now asks what is hidden of the same bound connection (`Room.connectionInWorkflow`), and so do the content reads of the document service.
2. **A draft binds no one.** The room is not given a workflow that is still in `draft` (as before), so a `wfp` token reads with no role until the workflow is sent. A token whose `sub` is not the participant's recorded `sub`, or that names no participant, reads with no role, whatever roles it claims for itself.
3. **A participant who is waiting reads already.** The roles of a bound participant do not depend on whether it is their turn; only filling does. So a participant of a later order reads the sensitive values of their role as soon as the workflow is sent. The alternative, reading only while active or after completing, would hide the value from a person who is about to be asked for it. Not decided by the owner.
4. **A change of the workflow derives the classes again.** The gateway treats `workflowChanged` as a change of access: a reader whose class changed gets `ch.closed` with `access_changed` and reloads, as for a grant change (ADR 0019 item 6). This covers a participant who gains a role when the workflow is sent, and a person who is replaced as a participant and must stop receiving values.
5. **REST reads follow the binding; the guards do not.** `readerConnectionOn` (`services/document-service/src/control-plane/gate.ts`) binds the caller for deciding what is hidden: content, field values, commits, comparison, history, activity, threads, asset resolution, the region list and exports. The route guards and the history gate keep the unbound connection, which holds no workflow role, so nothing more is granted there. A `role:` grant on a region therefore still conveys nothing to a `wfp` token in a REST guard (it does in the room); that was so before and is left for the owner of those routes.

## Not decided here

- Owner decision 157 (deleting a field whose value the reader cannot read needs `manage`) is not applied: the outcome check still allows the deletion (`packages/authority/src/permissions/outcome.ts`). It belongs to the permission rules, not to this story.
- Whether a sensitive value appears in the sealed PDF and in the evidence bundle for each participant (ADR 0019, open question).
