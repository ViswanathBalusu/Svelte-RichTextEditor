# ADR 0398: The test-hook interface the fault-injection profile uses

**Status:** proposed (2026-11-18, lane w5, PRO-126). It fills in what the owner accepted as decision 192
(ADR 0219: the hooks and the `test-hooks` feature exist only in test mode). Nothing here has been put to
the owner.

## Context

05 §11 says an optional fault-injection profile covers what cannot be seen from outside (durability
before acknowledgement, fencing, the hash chain, the audit trail) "for servers that expose the test
hooks". ADR 0219 point 1 proposed the feature name `test-hooks` and left the hook interface open. The
owner accepted that ADR on 2026-11-15 (decision 192): the hooks and the feature exist only in test
mode. The reference service already has hooks (BE-079, ADR 0054) under `/_test/`, behind its test-mode
switch, which the configuration refuses in production.

## Proposal

1. **The feature.** `test-hooks` is a feature name of DEP (`packages/protocol/src/definition/features.ts`,
   05 §2). A server announces it in discovery and `welcome` only while its test-mode switch is on. The
   reference service does this (`withTestHooks` in `services/document-service/src/server.ts`).
2. **The routes are the server's own.** The hooks are not part of DEP. The kit uses the routes of the
   reference service, on the origin of the REST base, with the service credential:

   | Hook | Route |
   |---|---|
   | fail the next write | `POST /_test/documents/{id}/fail-next-write` with `{ "at": "before-insert" \| "after-insert" }`, `204` |
   | kill the room | `POST /_test/documents/{id}/kill-room`, `200` |
   | drop a grant announcement | `POST /_test/documents/{id}/drop-announcement`, `204` |
   | rewind the log | `POST /_test/documents/{id}/rewind` with `{ "to": seq }`, `200` with `{ head, incarnation }`; `404` when the store cannot be rewound |
   | read the state | `GET /_test/documents/{id}/state`, `200` with `{ seq, epoch, owner, incarnation, chainHead }` |

   Another implementation that wants the profile offers the same routes. The profile is skipped for
   one that does not announce the feature.
3. **The rewind hook is new.** It cuts the log at `to`, gives it a new incarnation and stops the room,
   as a restored database and the operator procedure of BE-078 would. The in-memory store supports it;
   the PostgreSQL store does not (a restored database is the operator's procedure there), and the hook
   answers `404`, so the kit skips the scenario.
4. **How the kit reads the story criteria.** "A killed process" is a killed room (`kill-room` stops it
   without release or checkpoint, as a crash would; the process itself lives on). "A hook that fences a
   room" is `kill-room`. "A hook that delays the grants notification" is `drop-announcement`: the
   announcement is lost, which is the stronger fault, and the persist transaction must refuse the batch
   (06 §8). "Forces a write conflict" has no hook of its own: a fenced write is what a write conflict
   is (the epoch check), and `kill-room` produces the fence.

## Not decided

- Whether the hook routes should be specified in 05 §11 for every server, or stay the reference
  service's. Today the spec says only that they exist.
- A hook for the epoch (making the room's next write conflict while it is still serving) was not built.
  It would test the fence from the storage side; `kill-room` tests it from the room's side.
- The PostgreSQL side of every hook was not run (BE-079 notes the same).

## Consequences

The kit's `fault-injection` profile has four scenarios and runs against the reference service in test
mode (`packages/tck/test/pro-126-fault-injection.reference.test.ts`). A server without the hooks still
skips the profile, and the README still says what is then unproven.
