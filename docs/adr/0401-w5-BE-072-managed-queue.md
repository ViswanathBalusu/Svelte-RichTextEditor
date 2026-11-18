# ADR 0401: A managed queue behind the `Queue` port (BE-072)

Status: proposed (2026-11-18, lane w5). Not decided by the owner. It records why BE-072 was not built and what a build would be, so that the owner can choose the service.

## Context

06 §6 puts a managed queue at stage 3 (and optionally at stage 2), and 06 §14 lists `Queue` among the adapters a deployment may swap. The story asks for an adapter that passes the contract suite of BE-002, keeps the behaviour of BE-050, and loses or repeats no job when the queue is switched.

What exists: the `JobQueue` port (`control-plane/jobs/queue.ts`), a PostgreSQL implementation (`jobs/pg.ts`), a memory implementation, the tenant routing of BE-070 (`jobs/sharding.ts`) and the runner (`jobs/runner.ts`).

## What the port asks for, and what a managed queue gives

The port is wider than a message queue. Most managed queues (Amazon SQS, Azure Service Bus, Google Pub/Sub) give delivery with a lease and redelivery; none gives the rest.

| The port needs | A managed queue | Consequence |
|---|---|---|
| `claim` with a lock, `heartbeat`, redelivery after the lock passes, `maxAttempts` | A visibility timeout (SQS), a lock duration (Service Bus), an acknowledgement deadline (Pub/Sub), and a dead-letter queue | Native. |
| Highest priority first (ADR 0054) | SQS and Pub/Sub have none; Service Bus has sessions and topics but no strict priority | One queue per priority, polled in order. |
| A per-tenant limit on running jobs of a kind (BE-050) | None | A counter outside the queue. |
| `get`, `findCompleted` (cache key), `latestFor`, `cancel`, `depth` by kind and priority | None; a message cannot be read by an identifier once it is taken | The job record has to live in a store. |
| `delayMs`, `runAfter` | Delay up to a limit (SQS: 15 minutes) | A longer delay needs a store. |
| Enqueue only if absent (BE-052) | FIFO deduplication for a window of minutes | A store, again. |

## Proposed design

Keep the job record, the limits, the cache lookup and the history in PostgreSQL, as now. Use the managed queue for dispatch only: a row is written, and a message that names it is put on the queue for its kind and priority; workers receive the message, claim the row with the existing `FOR UPDATE SKIP LOCKED` statement, and delete the message when the row is settled. A message that is lost is repaired by a sweep that re-sends the messages of rows that are queued and have none (the row is the truth).

This removes the polling and the contention on the table, which is what the story is after. It does not remove the writes of the rows. If the owner wants the state out of PostgreSQL too, the table above shows what that costs: a second store for the record, with its own consistency rules.

## Why it was not built

- The service is not chosen, and the choice is the owner's: the stages in 06 §6 do not say which cloud a hosted deployment runs on, and a self-hosted deployment may have none. The adapter's shape (the table above) is the same for the three, but its tests need a running service or a faithful emulator, and the test environment has neither.
- No criterion of the story can be tested against the in-memory or PostgreSQL queue: criterion 1 is about the adapter, criterion 2 is about its behaviour, and criterion 3 is about switching from one queue to the other.

## Open questions for the owner

1. Which managed queue, for the hosted mode, and is there one for the self-hosted mode (06 §14 says adapters are swappable, not that one is provided)?
2. Dispatch only (above), or the whole job state in the queue's own service?
3. Is a switch of queue a planned operation (criterion 3) or a one-time migration? A planned switch needs the two queues to run side by side for a time, which the dispatch-only design allows and the other does not.
