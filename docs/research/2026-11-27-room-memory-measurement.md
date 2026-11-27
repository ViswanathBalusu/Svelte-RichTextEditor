# Memory of an open room (BE-084)

Handover for SPK-025 (unit-cost sheet, `docs/research/2026-11-06-unit-cost-sheet.md`). Spec: 06 §10, §16.

## How it was measured

- Test: `services/document-service/test/data-plane/v-be-071-084-be-084-room-memory.test.ts`, run with `pnpm exec vitest run --project node <file> --silent=false`. Reading (b) below runs only with `DOCEDIT_MEASURE=1` (about three minutes).
- Where: the Node.js 22 test worker on the development machine (Windows 11), 2026-11-27. Not the reference laptop of decision 225. The figures are V8 heap (`heapUsed` after two forced collections), so they depend on the Node.js version and the document, not on processor speed. The times per commit do depend on the machine.
- The room is opened and closed by the data plane's room host over in-memory stores. Documents are paragraphs of 300 characters; a page is taken as 3,000 characters. Sizes: 10 paragraphs, 200 (about 20 pages), 1,000 (about 100 pages), and 41,291 (15.48 MiB as JSON, near the 16 MiB limit).
- Two readings. (a) The room alone, no channel, empty log. (b) A client connected over a real WebSocket, one channel open, then a series of `insertText` commits through it (300 commits; 4 for the largest size). The client's own received messages are blanked before each reading so they are not counted as the room's.
- Not included: the PostgreSQL and object-store clients, the process baseline, and the memory of the compile jobs.

## Results

Heap in MiB. "Channel" is the room with one open channel. "After commits" is the heap above the start, after the commits.

| Document | JSON | Room alone | Channel | After commits | Per commit | Returned on close |
|---|---|---|---|---|---|---|
| 10 paragraphs | 0.00 | 0.44 | 0.58 | 3.59 | 10.3 KiB | 0.04 of 0.44 (the rest is one-time module state of the plane, not the room) |
| about 20 pages | 0.08 | 0.57 | 1.02 | 2.88 | 6.4 KiB | 0.54 of 0.57 (room alone); 2.1 after commits |
| about 100 pages | 0.38 | 2.61 | 4.93 | 6.04 | 3.8 KiB | 2.56 of 2.61; 7.25 after commits |
| near 16 MiB | 15.48 | 106.28 | 200.47 | 201.71 | 316 KiB | 106.06 of 106.28; 174.75 after commits |

Reading: with a channel, a room holds about 13 times its JSON size (1.02 / 0.08, 4.93 / 0.38, 200.47 / 15.48); without a channel about 7 times. A closed room returns nearly all it held (above 98 per cent for rooms over 1 MiB). The host's own estimate (`HostedRoom.estimatedBytes`, the JSON size) is therefore low by a factor of about 13 with a channel open.

Commit cost also grows with the document: 5 ms (10 paragraphs), 23 ms (20 pages), 103 ms (100 pages) and about 33 s (near 16 MiB) per commit, on this machine, one client, one commit at a time. The largest case stalls the event loop for the whole of each commit (heartbeats were missed in an earlier run). This is not a memory figure, but it bounds what a room of that size can serve, and BE-024 (acknowledgement latency) should take it as input.

## Recommendation for stage 1

These follow from the table. They are proposals for the owner of BE-021 and SPK-025, not settings.

1. Charge a room against the memory budget at 13 times its stored JSON size while a channel is open, with a floor of 1 MiB. Today the budget uses 1 times (BE-021 decision still open: the factor is not changed by this story).
2. Budget for open rooms on a stage 1 node: 1 GiB of heap, kept apart from the process baseline, the connections and the jobs. At 13 times, that holds about 1,000 rooms of 20 pages, about 200 rooms of 100 pages, or 5 rooms near 16 MiB.
3. Rooms per node for stage 1: 500 open rooms as the planning figure (half the 20-page count, as room sizes vary), with the idle close and the memory budget deciding which rooms go first. Documents of more than about 5 MiB of JSON should be counted as 13 times and admitted one at a time.
4. Re-run the latency columns on the reference laptop (decision 225) before quoting them as a target; the memory columns need no re-run unless the Node.js major version changes.

## Limits of the measurement

- One document shape (plain paragraphs), one editor, one kind of step. Tables, fields, comments and suggestions were not measured.
- The room alone and with a channel are two readings of a single run per size; a repeat of the first reading differed by 0.1 MiB at most.
- The log tail grows with the commits and is checkpointed at intervals not exercised here; the per-commit column is a difference of two heap readings over 300 commits (4 for the largest size) and is noisy; it is not a figure to quote. The log length of a real day was not exercised.
