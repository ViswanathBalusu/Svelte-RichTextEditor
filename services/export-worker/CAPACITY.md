# Capacity sheet: export workers

How to size the nodes that run export workers (09 §8; EXP-007). It is a planning rule, not a
measurement: nothing on this page was measured, and the worked examples are arithmetic. The
arithmetic is `src/capacity.ts`, and `src/capacity.test.ts` checks this page against it.

## The planning unit

Plan **one core and up to 1.5 GiB of memory for each running job**.

These are the limits of the sandbox that every job runs in (`LIMITS` in `src/sandbox.ts`, 09 §9.3
item 4): `--cpus=1`, and `--memory=1536m` with no swap. A job cannot use more, so a node planned
this way cannot be overcommitted by its jobs. A job may use less; the plan does not count on it.

A running job is a preview or a requested export in the state `converting` or `compiling`. Both
kinds run in the same sandbox under the same limits, so they count the same. A job that waits in
either queue (`queued`) uses no worker capacity.

## The rule

For a node with `C` cores and `M` GiB of memory, of which `c` cores and `m` GiB are kept for the
worker process, Podman and the system:

- jobs that may run at once on the node = the smaller of `C − c` and `(M − m) ÷ 1.5`, rounded down;
- nodes needed for `J` jobs running at once = `J` ÷ (jobs per node), rounded up.

Set the number of jobs the workers of a node take at once no higher than the first figure. The
total over all nodes is the most jobs that run at once; the per-tenant concurrency limit
(EXP-007 criterion 3) divides that total between tenants and does not add to it.

The reserve `c` and `m` is the operator's input. The worker process's own use of processor and
memory has not been measured; until it is, choose the reserve and watch the node.

## Worked examples

Arithmetic only, for node sizes chosen as examples.

| Node cores | Node memory (GiB) | Reserved cores | Reserved memory (GiB) | Jobs at once | Nodes for 10 running jobs |
|---|---|---|---|---|---|
| 2 | 4 | 0 | 0 | 2 | 5 |
| 4 | 8 | 0 | 0 | 4 | 3 |
| 4 | 8 | 1 | 1 | 3 | 4 |
| 8 | 16 | 1 | 1 | 7 | 2 |
| 8 | 8 | 0 | 0.5 | 5 | 2 |

The second row is the assumption of the unit-cost sheet
(`docs/research/2026-11-06-unit-cost-sheet.md`, row A17: four jobs for each worker node).

## What this sheet does not plan

- How many jobs run at once at a given load. That follows from the arrival rate and the duration
  of jobs; `scripts/measure.ts` and `scripts/latency.ts` measure durations on a given machine.
- Disk. Each job has a working directory of at most 256 MiB and an output of at most 200 MiB
  (`LIMITS`), removed with the sandbox.
- The document service, PostgreSQL and the object store.
