# SYN-038: Calibrating the sync defaults

Lane w4, 2026-11-17. Story: SYN-038 in `docs/stories/SYN-sync-engine.md`. Spec: 04 §12, §16; 06 §16.

This spike changes no behaviour. It measures the defaults that 04 calls starting points or guesses and recommends a value for each. Every recommendation is a proposal; the owner decides.

## How the figures were taken

- Script: `packages/authority/scripts/syn-038-calibrate.ts`, run as `node --expose-gc packages/authority/scripts/syn-038-calibrate.ts all` from the repository root.
- Machine: the reference machine of ADR 0037 (Intel Core i9-10900KF, 20 logical cores, 128 GiB, Windows 11 10.0.26300, Node.js 22.18.0), seed 1.
- The tables below are one run. The machine was shared with four other agents running tests, so timings move from run to run. In three earlier runs of the same script the full document hash of `pages-100` took 96, 61 and 49 ms at the median, against 35.5 ms in the run shown. Read every time as an order of magnitude with that spread, not as a precise figure.
- Times of the authority's functions are wall-clock times of the real code (`documentHash`, `rebaseOver`, `parseSteps`, `applySteps`, `checkInvariants`) on the shared corpus (FND-006), in one process, one thread, with garbage collection included.
- Sections "Batching window" and "One commit in flight" are simulations of a synthetic typing trace. The trace is a model: its parameters are assumptions stated above the table, not a recording. No recorded editing traces exist in the repository.
- Network, storage and PostgreSQL time are not included anywhere.


## Hash of the document per commit (SYN-038 criterion 6; 04 §16)

Full: `documentHash` of `@docedit/model` (canonical form, then SHA-256 by WebCrypto) of the whole document after each commit. Rolling: the hash of every top-level block of the body is kept; after a commit the one changed block is rehashed (canonical form of the block, SHA-256) and the block hashes are combined by one SHA-256 over their concatenation. The 10-page document is the first half of `pages-20` by canonical size (the corpus has no 10-page file). 30 runs each after 5 warm-ups; milliseconds.

| Document | Canonical bytes | Blocks | Full median | Full p99 | Rolling median | Rolling p99 |
|---|---|---|---|---|---|---|
| pages-1 | 21986 | 12 | 1.75 | 4.04 | 0.12 | 0.20 |
| 10 pages (half of pages-20) | 106003 | 41 | 7.30 | 9.21 | 0.14 | 1.06 |
| pages-20 | 175739 | 123 | 11.80 | 19.12 | 0.15 | 1.10 |
| pages-100 | 577684 | 515 | 35.54 | 50.73 | 0.27 | 1.20 |

## Rebase distance (SYN-038 criterion 2; 04 §5, §12)

A commit of 1 step (and of 50 steps) is made on a base of `pages-20`; `D` one-character inserts by others follow. Time: `rebaseOver` of the commit over the maps of the `D` steps (the room's step 3), 15 runs, milliseconds. Memory: the heap kept by `D` step maps alone (the room keeps one per accepted commit step), read after `gc()` as the difference of `heapUsed`; the median of 5 readings.

| D (steps since base) | Rebase 1 step median | p99 | Rebase 50 steps median | p99 | Heap of the maps (KiB) | Bytes per step map |
|---|---|---|---|---|---|---|
| 100 | 0.05 | 0.09 | 0.48 | 3.19 | 21 | 211 |
| 500 | 0.16 | 0.19 | 0.92 | 2.02 | 64 | 130 |
| 1000 | 0.12 | 0.35 | 2.67 | 3.65 | 113 | 116 |
| 5000 | 0.41 | 2.19 | 7.00 | 7.43 | 602 | 123 |
| 10000 | 0.71 | 3.79 | 15.17 | 22.47 | 1170 | 120 |
| 20000 | 0.67 | 2.54 | 26.84 | 29.38 | 2306 | 118 |

Time until a client that is `L` seconds behind exceeds `maxRebaseSteps` = 5,000 (a model, not a measurement: every other editor produces `r` steps per second, one step per keystroke):

| Other editors | r = 2 steps/s | r = 5 steps/s |
|---|---|---|
| 1 | 2500 s | 1000 s |
| 5 | 500 s | 200 s |
| 20 | 125 s | 50 s |
| 50 | 50 s | 20 s |

## Cost estimate against measured time (SYN-038 criterion 3; SYN-037, 04 §12)

Each commit has `S` one-character inserts and a base `D` steps behind the head of a document. The measured time is what the room does for it in steps 2 to 7: `parseSteps`, `rebaseOver`, `applySteps` of the mapped steps and `checkInvariants`. The estimate is `defaultCost` of `src/room/admission.ts` in units (fan-out 1). 9 runs each, median; milliseconds. The last column is milliseconds per unit.

| Document | S | D | Bytes | Estimate (units) | Measured median ms | ms per unit |
|---|---|---|---|---|---|---|
| pages-1 | 1 | 0 | 93 | 2 | 5.98 | 2.9891 |
| pages-1 | 1 | 1000 | 93 | 1002 | 5.44 | 0.0054 |
| pages-1 | 10 | 0 | 921 | 11 | 5.24 | 0.4762 |
| pages-1 | 10 | 1000 | 923 | 10011 | 5.43 | 0.0005 |
| pages-1 | 100 | 0 | 9191 | 109 | 6.06 | 0.0556 |
| pages-1 | 100 | 1000 | 9191 | 100109 | 7.64 | 0.0001 |
| pages-1 | 500 | 0 | 46139 | 546 | 13.01 | 0.0238 |
| pages-20 | 1 | 0 | 97 | 2 | 33.78 | 16.8918 |
| pages-20 | 1 | 1000 | 97 | 1002 | 33.99 | 0.0339 |
| pages-20 | 10 | 0 | 961 | 11 | 32.05 | 2.9139 |
| pages-20 | 10 | 1000 | 959 | 10011 | 34.17 | 0.0034 |
| pages-20 | 100 | 0 | 9569 | 110 | 33.76 | 0.3069 |
| pages-20 | 100 | 1000 | 9571 | 100110 | 37.34 | 0.0004 |
| pages-20 | 500 | 0 | 47849 | 547 | 52.58 | 0.0961 |
| pages-100 | 1 | 0 | 97 | 2 | 156.40 | 78.2001 |
| pages-100 | 1 | 1000 | 97 | 1002 | 184.14 | 0.1838 |
| pages-100 | 10 | 0 | 971 | 11 | 223.87 | 20.3520 |
| pages-100 | 10 | 1000 | 973 | 10011 | 190.09 | 0.0190 |
| pages-100 | 100 | 0 | 9677 | 110 | 172.70 | 1.5700 |
| pages-100 | 100 | 1000 | 9677 | 100110 | 202.32 | 0.0020 |
| pages-100 | 500 | 0 | 48413 | 548 | 281.43 | 0.5135 |

ms per unit over the 21 accepted rows: min 0.0001, median 0.0961, max 78.2001; the largest is 1025052 times the smallest.

## Streaming a catch-up against reloading (SYN-038 criterion 4; 04 §9)

Stream: the server serialises `k` `sync.commit` bodies (`JSON.stringify`), the client parses them and applies the steps (`applySteps`) to its document. Reload: the server serialises the document content, the client parses it and builds the node tree (`nodeFromJSON`). A commit is one one-character insert (typical) or 50 of them. Network and storage time are not included. 7 runs each, median; milliseconds.

| Reload of | Content bytes | Reload ms |
|---|---|---|
| pages-1 | 21986 | 1.81 |
| pages-20 | 175739 | 10.37 |
| pages-100 | 577684 | 30.09 |

| Commit | k | Stream bytes | Stream ms (server + client) | Over a limit (5,000 commits, 5 MiB) |
|---|---|---|---|---|
| 1 step | 100 | 24476 | 2.65 | neither |
| 1 step | 1000 | 245605 | 12.42 | neither |
| 1 step | 5000 | 1232757 | 95.00 | the commit count |
| 50 steps | 100 | 493752 | 60.47 | neither |
| 50 steps | 1000 | 4939939 | 780.02 | neither |
| 50 steps | 5000 | 24880831 | 2018.94 | both |

## Batching window (SYN-038 criterion 1; 04 §12)

Simulation on a synthetic trace of 2161 keystrokes over 10 minutes (seed 1): bursts of 15 to 60 keys, key gaps lognormal with median 180 ms and sigma 0.45, pauses of 1 to 4 s between bursts. These parameters are assumptions of the model, not a recording; the trace's own median gap is 184 ms. One keystroke is one `replace` step of 91 bytes (measured); a submit adds the envelope. The link is 100 ms round trip; one commit in flight. "To ack" is the time from a keystroke to its acknowledgement, which is the wait in the window plus the round trip. "Span" is the longest run of keystrokes that attribution cannot tell apart, which is the characters in one commit.

| Window ms | Commits per minute | Log bytes per minute | Mean ms to ack | p99 ms to ack | Mean keys per commit | Max keys per commit (span) |
|---|---|---|---|---|---|---|
| 0 | 216 | 41528 | 102 | 143 | 1.0 | 1 |
| 25 | 216 | 41528 | 127 | 168 | 1.0 | 1 |
| 50 | 215 | 41418 | 152 | 188 | 1.0 | 2 |
| 100 | 197 | 39586 | 193 | 200 | 1.1 | 2 |
| 200 | 135 | 33421 | 248 | 300 | 1.6 | 3 |
| 400 | 85 | 28356 | 356 | 500 | 2.6 | 5 |
| 1000 | 41 | 23962 | 673 | 1100 | 5.3 | 10 |

## One commit in flight against pipelining (SYN-038 criterion 5; 04 §16)

The same trace, window 100 ms. "One in flight": a commit is sent after the acknowledgement of the one before. "Pipelined": a commit is sent when its window closes whatever is in flight (the server would rebase each over the ones before it, which is not modelled here). Throughput is commits per minute; latency is from a keystroke to its acknowledgement.

| Round trip ms | Mode | Commits per minute | Mean ms to ack | p99 ms to ack | Mean keys per commit | Max keys per commit |
|---|---|---|---|---|---|---|
| 100 | one in flight | 197 | 193 | 200 | 1.1 | 2 |
| 100 | pipelined | 197 | 193 | 200 | 1.1 | 2 |
| 300 | one in flight | 140 | 451 | 598 | 1.5 | 4 |
| 300 | pipelined | 197 | 393 | 400 | 1.1 | 2 |
| 1000 | one in flight | 50 | 1496 | 1992 | 4.3 | 8 |
| 1000 | pipelined | 197 | 1093 | 1100 | 1.1 | 2 |

## What the figures show

### 1. Batching window (criterion 1)

From 25 ms to 100 ms the window changes little: 216 to 197 commits per minute. From 100 ms to 200 ms commits per minute fall by about a third (197 to 135) and the log by about a sixth (39.6 to 33.4 KB per minute). The attribution resolution stays small: at most 3 keystrokes share a commit at 200 ms, and 5 at 400 ms. The mean time to acknowledgement is the window plus the round trip (248 ms at 200 ms). The typist does not wait for it, because local echo shows the text at once.

What the window buys is CPU. Every commit costs the room 6 ms (1 page), about 34 ms (20 pages) or about 156 ms (100 pages) for one typed character (table "Cost estimate against measured time"). A typist at a 100 ms window sends 3.3 commits a second, which is about 110 ms of room CPU per second on 20 pages and about 510 ms on 100 pages. At 200 ms the second figure is about 350 ms, at 400 ms about 220 ms.

### 2. maxRebaseSteps (criterion 2)

Rebasing is cheap compared with the rest of a commit. A commit of one step that is 5,000 steps behind costs 0.4 ms, and 50 steps cost 7 ms; at 20,000 steps behind, 50 steps cost 27 ms. The position maps cost about 120 bytes per accepted step: 0.6 MiB at 5,000 steps and 2.3 MiB at 20,000 steps, for each room that keeps them. The distance term of the cost estimate is therefore small in practice (see 4).

The rate of `stale_base` was not measured. It depends on how far behind real clients fall, and no data on that exists. The model table gives the lag at which a client passes 5,000 steps for a given number of other editors and typing rate; it is arithmetic, not a measurement.

### 3. Rolling hash (criterion 6)

Hashing the whole canonical document after every commit costs 1.8 ms (1 page), 7.3 ms (10 pages), 11.8 ms (20 pages) and 35.5 ms (100 pages), about 0.06 to 0.08 ms per 1,000 bytes of canonical content. A hash that keeps one hash per top-level block and rehashes only the changed block costs 0.12 to 0.27 ms over the same sizes, and grows slowly with the number of blocks. This is the cost of the hash alone. It was not built into the room, and a commit that adds, removes or moves a block needs the combination to be recomputed in a stable order, which was not tested.

### 4. The cost estimate (criterion 3)

The estimate of SYN-037 (`defaultCost`) does not predict the measured time. The measured time of a commit is dominated by the size of the document, which the estimate does not take as an input:

- One typed character, no rebase: 6.0 ms on `pages-1` (22,000 bytes of canonical content), 33.8 ms on `pages-20` (176,000 bytes), 156 ms on `pages-100` (578,000 bytes). That is about 0.2 to 0.3 ms per 1,000 bytes. The cause is the whole-document work of step 6, `checkInvariants`, and of the second `applySteps`. The "well under a millisecond" target of SYN-040 is far away for a document of any length.
- Each further step costs little: about 0.04 ms (`pages-20`) to 0.25 ms (`pages-100`) per step, from the 500-step rows.
- A rebase distance of 1,000 steps adds about 0.2 ms on `pages-20`. The estimate charges 1,000 units for it.

Milliseconds per estimated unit run from 0.0001 to 78 across the 21 rows, a factor of about a million. The estimate is not usable to compare commits on documents of different sizes, and it overcharges long rebases and undercharges the fixed cost.

### 5. Catch-up limits (criterion 4)

Reloading `pages-20` takes 10 ms and `pages-100` 30 ms. Streaming 1,000 one-step commits takes 12 ms (about the reload of 20 pages) and 5,000 take 95 ms (three times the reload of 100 pages). Commits of 50 steps are about 4.9 KB each: 100 of them already cost 60 ms and 490 KB, more than a reload of any corpus document. By bytes, the content of `pages-1` (22 KB) equals about 90 typical commits, `pages-20` about 720 and `pages-100` about 2,360.

So the limit of 5 MiB is sound, but a count of 5,000 is generous for one-step commits and far too generous for large ones. Streaming is cheaper than reloading only below roughly 90 commits on a one-page document and below about 700 to 2,400 on a 20 to 100 page document.

### 6. One commit in flight (criterion 5)

At 100 ms round trip there is no difference. At 300 ms, one in flight sends 140 commits a minute against 197 and the mean acknowledgement is 451 ms against 393 ms. At 1,000 ms it sends 50 against 197 and the mean is 1,496 ms against 1,093 ms. Batching keeps every keystroke: the cost is bigger commits (up to 8 keystrokes at 1,000 ms) and a later acknowledgement, not lost input. Pipelining would gain 60 to 400 ms of acknowledgement time and would need the server to rebase each commit over the ones in flight; that cost was not measured.

## Recommendations (criterion 7)

Each value is a proposal. None is applied.

| Default | Now | Recommendation | Basis |
|---|---|---|---|
| Batching window | about 100 ms | 200 ms | Section 1: a third fewer commits, little loss of attribution resolution, each commit costing 34 to 156 ms on 20 to 100 pages. Revisit when the invariant check is incremental. |
| `maxRebaseSteps` | 5,000 | keep 5,000 | Section 2: rebase and map memory are small at that distance (0.4 to 7 ms, 0.6 MiB). The rate of `stale_base` is unmeasured. |
| Cost estimate | steps x distance + size | replace by an estimate in milliseconds that takes the document's canonical size as an input: about 0.2 to 0.3 ms per 1,000 bytes, plus about 0.0002 to 0.0004 ms per step per 1,000 bytes, plus about 0.00003 ms per step per step of distance | Section 4. `CostInput` needs a document size. These are the measured ranges, not fitted constants. |
| Per-connection budget | none calibrated | 250 ms of room CPU per second, burst 300 ms | Twice a typist's demand on 20 pages at a 100 ms window (110 ms a second), and above the cost of a 500-step commit on 100 pages (281 ms). Below a typist's demand on 100 pages. |
| Per-tenant budget | none calibrated | 500 ms of room CPU per second | Half of the one thread that serves all rooms of a process. |
| Catch-up limits | 5,000 commits or 5 MiB | keep 5 MiB; stream only while the bytes to send are below the bytes of the content, with 5,000 commits as a ceiling | Section 5. |
| Pipelining | one in flight | keep one in flight | Section 6. |
| Hash per commit | full hash after each commit | a hash per top-level block, combined, if divergence detection per commit is wanted | Section 3. |

The budgets are not safe to switch on for documents of 100 pages: a typist alone would use a third to a half of the thread (section 1). The cause is step 6 of the room checking the whole document on every commit. An incremental check of the invariants would remove most of the fixed cost; it is a change to `@docedit/authority`, outside this spike. After it, this script should be run again and the budgets chosen again.

## What remains unmeasured

- Recorded editing traces. The batching and pipelining results rest on the synthetic trace.
- The rate of `stale_base` for real clients, which needs the distribution of client lag.
- Real networks. The round trip is a fixed number in the simulation.
- Storage and PostgreSQL time, and the acknowledgement latency end to end (SYN-015 criterion 5; SYN-040 criterion 3).
- The server's cost of rebasing pipelined commits, and the combined hash inside a room.
- Many rooms on one thread, and the effect of the budgets on other documents (SYN-037 criterion 5).
- The benchmark of SYN-040 is not finished. The comparison in section 4 uses this script's own measurement of the same functions, which has the same limits: wall-clock time, one machine, shared load.
