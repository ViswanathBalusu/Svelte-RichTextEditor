# Commit-log insert rate on one PostgreSQL primary (BE-071)

Date of the runs: 2026-11-18. Command: `services/document-service/scripts/load/be-071.ts`. It is the measurement behind criterion 1 of BE-071 ("the rate at which PostgreSQL stops being enough"). The recommendation of ADR 0152 ("BE-071: moving the commit log off PostgreSQL") is unchanged: stay on PostgreSQL until the insert rate approaches what one primary takes.

## How and where this was measured

- One development machine: Intel Core i9-10900KF (20 logical CPUs), Windows 11, Node.js 22.18. It is not the reference machine of ADR 0037, and it is not a cloud region.
- PostgreSQL 17.11 in the Podman container of the integration-test environment (FND-010), reached through the Podman machine's loopback relay, with its data on tmpfs. `synchronous_commit` on, `fsync` on, `full_page_writes` on, `shared_buffers` 256MB, `wal_level` replica, `max_connections` 300. Because the data directory is in memory, the cost of a durable write to a real disk is not in these figures. A production primary with network storage will plateau lower or higher; this run cannot say which.
- The writers call `PgLogStore.append` directly: no sockets, no room, no gateway. Each writer owns one document and appends back to back, one append per transaction (06 §2.3). The pool had one connection per writer plus four. Eight seconds per step; the commits are small step commits of the conformance kit (`stepCommit`).
- One run per setting. Nothing was repeated, so the spread between runs is not known. A figure below is what that run did.

```
node services/document-service/scripts/load/be-071.ts --writers 1,2,4,8,16,32,64 --seconds 8 --batch 1
node services/document-service/scripts/load/be-071.ts --writers 1,4,16,32 --seconds 8 --batch 10
```

## Results

One commit per transaction:

| Writers | Commits per second | Append median | Append 99th |
|---|---|---|---|
| 1 | 134 | 6.1 ms | 20.9 ms |
| 2 | 193 | 6.7 ms | 40.4 ms |
| 4 | 427 | 6.1 ms | 42.0 ms |
| 8 | 712 | 8.2 ms | 38.1 ms |
| 16 | 984 | 14.2 ms | 37.8 ms |
| 32 | 1,042 | 29.1 ms | 55.6 ms |
| 64 | 1,023 | 60.5 ms | 94.9 ms |

Ten commits per transaction (a group commit of ten):

| Writers | Commits per second | Transactions per second | Append median | Append 99th |
|---|---|---|---|---|
| 1 | 568 | 57 | 15.5 ms | 44.4 ms |
| 4 | 3,059 | 306 | 11.6 ms | 29.8 ms |
| 16 | 4,408 | 441 | 33.6 ms | 73.0 ms |
| 32 | 4,290 | 429 | 70.0 ms | 163.0 ms |

No append failed in any step.

## What it says

- On this setup the rate stops growing at about 1,000 transactions per second with one commit each, from 16 writers on. From 32 to 64 writers the rate stayed the same and the median latency doubled. That is the point where more load only adds waiting.
- With ten commits per transaction the plateau is about 4,300 to 4,400 commits per second, at about 430 to 440 transactions per second. The plateau in commits per second is about four times higher, so grouping is the first lever, and it is the one the persist pipeline already uses (BE-024). The cost is latency: the 99th percentile of one append went from 55.6 ms to 163 ms between the two settings at 32 writers.
- The figure for production hardware is not known. It depends on the disk, the network round trip and the database settings, none of which this run has. The cost sheet's A7 assumption (500 PostgreSQL commits per second) is below the plateau measured here with one commit per transaction; it is an assumption of the sheet and was not measured.
- Sharding by tenant (BE-070) adds one plateau per shard. That was not measured: the two shards of the BE-070 tests are two databases of one server.

## What was not done

- No candidate log store was run (criterion 2 of BE-071). A store that can fence needs an adapter that passes the conditional-append checks of `test/contract/checks.ts`, and none is built.
- No repeat runs, no run on the reference machine, no run with the data on a disk.
