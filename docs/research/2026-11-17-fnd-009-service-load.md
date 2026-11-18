# Service latency, load and fault runs (FND-009)

Date of the runs: 2026-11-17. Harness: `services/document-service/scripts/load/` (`lib.ts`, `scenarios.ts`, `fnd-009.ts`), with its checks in `services/document-service/test/load/fnd-009.harness.test.ts`.

## How and where these were measured

- One development machine: Intel Core i9-10900KF (20 logical CPUs), 128 GiB, Windows 11, Node.js 22.18. It is not the reference machine of ADR 0037, and it is not a cloud region.
- The service ran as its own process (`src/main.ts`, BE-001) and the load generator as another, on the same machine, so the network was the loopback interface. "Within one region" in the story is therefore met in the weakest sense: there is no network distance at all.
- Two storage settings: memory (no database, no object store) and PostgreSQL 16 with the S3-compatible store of the integration-test environment (FND-010), both containers on the same machine with their data on tmpfs. A figure under "PostgreSQL" includes the Podman machine's loopback relay.
- The workload settings below are settings of the runs. They are not figures of the specification, and they are not a model of real users.
- Targets are those of 00 §9 and 06 §6. A single run says what happened in that run. The two memory ramps below show how far one run can differ from another.

Command lines (from the repository root, with `pwsh -NoProfile -File infra/test-env.ps1 up` for the PostgreSQL runs):

```
node services/document-service/scripts/load/fnd-009.ts --storage memory
node services/document-service/scripts/load/fnd-009.ts --storage postgres
node services/document-service/scripts/load/fnd-009.ts --storage <s> --only ack --writers 100 --commits 60 --ack-interval-ms 500
```

## Commit acknowledgement latency (target: median 50 ms, 99th percentile 300 ms)

A writer sends a commit and waits for its acknowledgement. Each writer has a document of its own. The first 20 commits of each writer are not counted. Times are from sending the commit to receiving `sync.ack`.

| Storage | Writers | Pause between commits | Counted commits | Median | 95th | 99th | Commits per second | Target met |
|---|---|---|---|---|---|---|---|---|
| memory | 20 | none (back to back) | 4,000 | 39.9 ms | 70.2 ms | 166.8 ms | 438 | yes |
| memory | 100 | 500 ms | 6,000 | 6.4 ms | 23.1 ms | 101.4 ms | 194 | yes |
| PostgreSQL | 20 | none (back to back) | 4,000 | 71.5 ms | 100.7 ms | 148.9 ms | 266 | no: median above 50 ms |
| PostgreSQL | 100 | 500 ms | 6,000 | 58.6 ms | 162.1 ms | 209.7 ms | 173 | no: median above 50 ms |

With PostgreSQL the 99th percentile is inside the target in both runs and the median is not. The acknowledgement waits for the write (06 §2.3), so the median is the cost of one round trip to the database plus the group commit window. Why it is above 50 ms was not investigated here; it is a finding for the stories that own the persist pipeline (BE-024, SYN-040) and for a rerun on the reference machine.

## Cold open of a room (target: 95th percentile 500 ms, document under 1 MB of CDM)

One document of 680,595 bytes of CDM JSON (4,000 paragraphs of 60 characters, under the 1 MB of the target). 30 documents, each opened once, one at a time, so that the node does nothing else. Times are from `ch.open` to `ch.opened`, which carries the content; connecting and `hello` are not counted.

| Storage | Median | 95th | 99th | Target met |
|---|---|---|---|---|
| memory | 193.7 ms | 251.2 ms | 254.2 ms | yes |
| PostgreSQL | 200.1 ms | 243.4 ms | 281.4 ms | yes |

## Ramp towards stage 1 (06 §6: about 2,000 connections, 500 open documents)

Each step adds connections and documents to the ones already open. The first connections of a step open the documents that are new to it, one writer each; the rest read. Every writer commits every 2,000 ms for 5 s. A step is "saturated" when a connection or open fails, a commit is not acknowledged within 10 s, or the 99th percentile of the acknowledgement is above 300 ms. The generator's own timer lag is reported so that a slow generator is not mistaken for a slow node: it stayed between 13 and 66 ms at the 99th percentile in every step of every run.

Memory storage, run 1 (first full run; the node saturated at the last step):

| Connections | Documents | Commits per second | Ack median | Ack 99th | Open 95th | Saturated |
|---|---|---|---|---|---|---|
| 100 | 25 | 12.6 | 2.6 ms | 19.1 ms | 107.9 ms | no |
| 250 | 63 | 31.4 | 2.4 ms | 3.7 ms | 107.8 ms | no |
| 500 | 125 | 62.2 | 2.2 ms | 5.8 ms | 98.0 ms | no |
| 1,000 | 250 | 124.6 | 2.9 ms | 34.6 ms | 124.4 ms | no |
| 1,500 | 375 | 187.2 | 6.9 ms | 144.4 ms | 150.7 ms | no |
| 2,000 | 500 | 249.8 | 229.8 ms | 743.5 ms | 99.7 ms | yes: 99th above the target |

Memory storage, run 2 (same settings, a few minutes later; no step saturated):

| Connections | Documents | Commits per second | Ack median | Ack 99th | Open 95th | Saturated |
|---|---|---|---|---|---|---|
| 100 | 25 | 12.4 | 2.8 ms | 8.8 ms | 86.2 ms | no |
| 250 | 63 | 31.6 | 2.9 ms | 5.6 ms | 106.9 ms | no |
| 500 | 125 | 62.4 | 2.9 ms | 6.6 ms | 87.1 ms | no |
| 1,000 | 250 | 124.6 | 4.4 ms | 14.7 ms | 121.7 ms | no |
| 1,500 | 375 | 186.2 | 3.7 ms | 13.9 ms | 103.6 ms | no |
| 2,000 | 500 | 249.4 | 9.3 ms | 63.4 ms | 90.6 ms | no |

PostgreSQL:

| Connections | Documents | Commits per second | Ack median | Ack 99th | Open 95th | Saturated |
|---|---|---|---|---|---|---|
| 100 | 25 | 12.6 | 9.0 ms | 58.2 ms | 456.1 ms | no |
| 250 | 63 | 31.4 | 8.5 ms | 58.5 ms | 634.7 ms | no |
| 500 | 125 | 62.4 | 8.6 ms | 29.8 ms | 882.0 ms | no |
| 1,000 | 250 | 125.0 | 8.0 ms | 70.4 ms | 699.1 ms | no |
| 1,500 | 375 | 187.4 | 8.1 ms | 25.4 ms | 723.0 ms | no |
| 2,000 | 500 | 249.6 | 11.2 ms | 207.5 ms | 692.4 ms | no |

What the ramps say, and what they do not:

- One node held 2,000 connections on 500 documents with no failed connection and no unacknowledged commit, on memory and on PostgreSQL, at 250 commits per second. That is the stage 1 figure of connections and documents; the commit rate is the harness's own setting.
- The first memory run saturated at the last step by the harness's own rule (99th percentile 743.5 ms) and the second did not (63.4 ms). The step to 2,000 is where latency starts to rise in all three runs (median 229.8, 9.3 and 11.2 ms). A single run cannot place the saturation point more closely than "at or just above 2,000 connections with 500 writers on this machine". A tighter answer needs more runs and a ramp that goes past stage 1.
- Opening a channel during the ramp (PostgreSQL: 456 to 882 ms at the 95th percentile) is slower than the idle cold open above (243 ms). Both are measured; the target applies to the idle case only.
- CPU and memory of the service process were not recorded.

## Faults (11 §4: dropped connections, a killed process, a database outage)

PostgreSQL run.

| Fault | Workload | Result |
|---|---|---|
| Dropped connections | 50 writers, 5 acknowledged commits each, then one commit in flight on every socket while all 50 sockets are terminated at once. Each writer reconnects, resumes its channel and sends the unanswered commit again with the same identifier. | 50 of 50 resumed and 50 of 50 resent commits were acknowledged. 0 acknowledged commits missing and 0 applied twice (read back over REST). |
| Killed process | 10 documents, 20 acknowledged commits each, then SIGKILL of the service process and a start on the same database and store. | 0 of 200 acknowledged commits missing after the restart. The new process listened 3.9 s after it was started. It acknowledged a new commit 13.3 s after it was started: the new process waits for the dead process's ownership of the documents to lapse (06 §2.1). |
| Database outage | The service's own test hook of BE-079 (`POST /_test/database`) makes every write fail as if the database were away, for 1.5 s. | The commit sent during the outage was not acknowledged and is not in the document. After the outage a new connection committed again. The commits before and after are each in the document once. |

The database outage is the service's fault hook, not a stopped database container: the service refuses writes as it would for an unreachable database, but the connection pool and the container are not touched. A run that stops the PostgreSQL container is not part of this harness yet.

## Not measured

- A 20-page export (criterion 3 of FND-009). The export path needs the export worker and its sandbox (BE-005 stack); the harness has no scenario for it.
- Anything on the reference machine of ADR 0037, on a network, or on more than one node.
