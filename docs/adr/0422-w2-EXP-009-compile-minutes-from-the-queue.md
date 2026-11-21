# ADR 0422: Compile minutes are the queue's record of worker time

**Status:** proposed, 2026-11-21 (lane w2; EXP-009 criteria 1 to 3). The owner has not reviewed it. Owner decision 69 fixes the usage window (the calendar month in UTC) and decision 63 says that both compiles of a sealing export count. No decision says where the minutes are counted.

## Context

09 §9.1 and 06 §12 give each tenant a monthly budget of compile minutes. EXP-009 built it in two steps (ADR 0317): a ledger in the memory of the document service, fed by the hook of the service's own job runner, and a refusal in the export route.

That ledger had two faults.

- **It counted nothing where exports really run.** The hook runs in the process that runs the job. The export worker is a process of its own (ADR 0045). The document service's own entry point (`src/main.ts`) registers no export handler, and with a database it announces exports through workers outside it (`DOCEDIT_EXTERNAL_WORKERS`, on by default there). So with a real worker no minute was ever counted and no budget was ever reached. The tests passed because they ran the compile inside the service.
- **It was one process's memory.** A restart forgot the month, and two nodes of the service each had a count of their own.

## Decision

1. **The queue measures worker time.** Every job has `workerMs`: for each attempt that ended, the time from its claim to its end, in the queue's own clock. An attempt ends when the job completes, fails, is queued again, or is cancelled while it runs. The queue adds the time in the statement that ends the attempt, so it is counted whichever process ran the job, and it is kept with the job's row.
2. **An attempt whose worker stopped is not counted.** Nobody knows how long it worked, and the tenant did not cause it.
3. **A job counts in the month it ended in**, with all its attempts. A job that has not ended does not count yet.
4. **The budget reads the queue.** `CompileBudget` asks `JobQueue.workerTime(tenant, ['export', 'preview'], from, to)` for the UTC month of the request, and compares it with `exportMinutes` of the tenant's quotas. It asks only for a tenant that has a budget. Nothing is counted in the service's memory any more.
5. **Unchanged from ADR 0317:** previews count; the refusal covers previews and is checked before a cached answer; a budget that is not set is no limit.
6. In PostgreSQL this is migration `0097_exp_009_job_worker_time`: the columns `claimed_at` and `worker_ms`, an index for the sum, and a trigger that records the time of every claim, whichever claim function made it.

## Consequences

- **Worker time is more than the sandbox's time.** It runs from the claim to the end of the attempt, so it holds the reading of the content, the conversion, the compile and the storing of the outputs. Both compiles of a sealing export are inside one attempt (decision 63). A preview that showed an earlier preview's files (ADR 0421) costs its conversion only.
- **A running job is free until it ends.** A tenant just under its budget can start several long exports, and all of them finish. The story's criterion asks for a refusal of the next request, not for a stop of running jobs (BE-092 criterion 4 says the same).
- **One read of the queue for each export request** of a tenant with a budget. The index holds everything the sum needs.
- **Rollout.** A service or worker of the previous release ends an attempt without adding its time. The minutes are complete once every process that runs export jobs is of this release.
- **The usage figures can read the same sum.** `CompileBudget.usedMinutes` gives the minutes of a month. No route for usage figures exists yet (UX-078 criterion 2; ADR 0371 proposes `GET /usage`), so EXP-009 criterion 4 stays open.
- **The runner's hook still feeds the meters of BE-085** (`previewCompiles`, `finalCompiles`, `compileSeconds`), the `export.*` notifications, the webhooks and the `export` versions. With a worker of its own none of these run. That is outside this record and is reported with the story.

## Alternatives considered

- **Let the worker report its time.** The worker's result already holds stage times for a compile. A failed job, a cancelled job and the targets without a compile carry none, and the service would have to trust what a worker says about its own cost.
- **A ledger table of its own**, one row for each tenant and month. It needs a write in the same statement that ends the attempt to stay correct, which is the trigger or the statement of this record plus a second table. The jobs are already the record.
- **Count in the trigger for the end of an attempt too.** A claim that fails a job whose worker stopped would then be counted from the dead worker's claim to the moment another worker looked, which can be hours.

## Open, for the owner

1. Whether worker time (claim to end) or the sandbox's time alone is the "compile minute" a tenant is charged.
2. Whether an attempt whose worker stopped should count up to the end of its last lease.
3. Whether a running job should be stopped when the budget runs out. It is not.

## Tests

- Queue, in memory and on PostgreSQL: `services/document-service/test/control-plane/exp-009-worker-time.test.ts`.
- Budget: `services/document-service/src/control-plane/exp-009-compile-budget.test.ts`.
- Over HTTP, with a runner of its own as the worker and the budget written through `PUT /v1/quotas`, in memory and on PostgreSQL: `services/document-service/test/control-plane/exp-009-compile-budget.test.ts`.
