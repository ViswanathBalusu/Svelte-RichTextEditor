# EXP-060: Export latency of a 20-page document

Lane w2, 2026-11-17. Story: EXP-060 in `docs/stories/EXP-export.md`. Spec: 09 §8; 00 §9; 11 §2 (S4).

This note reports one measurement of the export time of the corpus document `s4-20p` through the real job path. It changes no behaviour. The target is 10 seconds at the 95th percentile for a 20-page document on an empty queue. The result is that the final export misses it and the preview profile meets it, on the machine below.

## How the figures were taken

- Script: `services/export-worker/scripts/latency.ts`, run from the repository root as `node services/export-worker/scripts/latency.ts --docs s4-20p --runs 8 --profiles final,preview --out <dir>`. It starts the document service and the export worker in one process, creates the document, requests an export through `POST /v1/documents/{id}/exports`, and waits for the job. "Job" is the time from the job's creation to its end by the control plane's clock. The stages are the worker's own.
- Machine: the reference machine of ADR 0037 (Intel Core i9-10900KF, 20 logical CPUs, 128 GiB, Windows 11 10.0.26300, Node.js 22.18.0), Podman 6.0.2 on the WSL machine `podman-machine-default`, image `localhost/docedit-export-worker:s4`, class 0.2.11, job queue empty (one job at a time).
- The document: `services/export-worker/fixtures/s4-corpus/s4-20p.cdm.json`. It is the corpus's 20-page document and comes out at 23 pages in the final export and 22 in the preview, in this class.
- Runs: 8 of each profile, final first, then preview, back to back. The sandbox ran with `DOCEDIT_CONTAINER_CGROUPS=disabled`, because the cgroup limits cannot be applied on this Podman machine (`crun: open memory.max for writing: No such file or directory`). The job therefore did not have the limit of one core and 1.5 GiB that the target names (`cpus` and `memoryMiB` in `services/export-worker/src/sandbox.ts`), only the rlimits. LuaTeX runs on one thread, so a limit of one core is not expected to make a run much slower, and a limit can only slow a run, not speed it up; neither the size of the effect nor the memory use of a job was measured here.
- The machine was shared with the other agents of this run, so timings move from run to run. The spread below is the visible part of that.
- With 8 runs the 95th percentile (nearest rank) is the slowest run. It is not a stable estimate of the percentile; 20 or more runs would be needed for that, and none were made.

## Result

Seconds. Job time is the whole job; the stage rows are medians of the 8 runs.

| Profile | Pages | Job min | Job median | Job p95 (= max of 8) | Target | Over the target at p95 |
|---|---:|---:|---:|---:|---:|---:|
| final (three passes) | 23 | 21.37 | 23.07 | 25.86 | 10 | 15.86 s, 2.6 times the target |
| preview (one pass) | 22 | 5.34 | 5.93 | 7.20 | 10 | none (2.80 s under) |

| Stage (median) | final | preview |
|---|---:|---:|
| Queue wait | 0.00 | 0.00 |
| Content, conversion, checks | 0.05 | 0.04 |
| Sandbox time outside the passes | 1.17 | 1.21 |
| Passes | 6.87 + 6.78 + 7.01 | 4.63 |
| Parse, store | 0.02 | 0.02 |

The three passes of the final export add up to 20.66 seconds by the stage medians, which is most of the median job time of 23.07 seconds (the job time is the median of the job times, not the sum of the stage medians). One pass is about 7 seconds in the final profile and 4.6 seconds in the preview profile.

## What this does and does not show

- It shows that, on this machine and with this document, a final export needs about 2.3 times the target at the median and 2.6 times at the slowest of 8 runs, and that the preview profile fits inside it.
- The cost is the passes, not queueing, conversion or storing. A pass takes more than two thirds of the target by itself, so no change outside the engine's own time (the pre-built font cache, the cache by bundle hash) can bring a three-pass final export under 10 seconds. The levers left are fewer passes, a faster pass, and an engine that is already started (EXP-063, which is built only when measurements like this one show the target cannot be met otherwise; its fourth criterion records the gain over the target).
- It does not show the limit of one core and 1.5 GiB (see above), a measurement on a dedicated runner (ADR 0037 §6 keeps the tolerances provisional until then), or the time of 10,000 plain paragraphs that 09 §8 quotes: no document of that size was run, so the published figures of 09 §8 are not replaced.
- Whether the 10-second target is meant for a final export that runs several passes, or for the preview, is not stated (Open questions of EXP-060). This note reports both.

## Earlier runs, for the spread

The Notes of EXP-060 record two earlier runs of the same script on this machine under heavier load: `s4-20p` final took 47.5 s on 2026-11-14 (round 8), and the one-page document took 12.7 s final. They are not repeated here; the run above is the quietest of the three, and the machine's load is the main reason for the difference.

## Update, 2026-11-27 (lane w2)

- **The target.** Owner decision 235 (`docs/owner-decisions-2026-11-26.md`) answers the question above: the 10-second target is for the preview. The final export has its own, longer target, to be measured on the reference machine, and no engines are started ahead of time (EXP-063 is not built). The first measurement of this note stands for the final export: 23.07 s median and 25.86 s slowest of 8 runs for 23 pages. No target figure for the final export is set here; it is to be set from a quiet measurement.
- **A run on a loaded machine.** `node services/export-worker/scripts/latency.ts --docs s4-20p --runs 20 --profiles preview`, same host, Podman 6.0.2 (direct route), image `localhost/docedit-export-worker:s4`, no cgroup limit. Job time: minimum 11.36 s, median 17.92 s, 19th of 20 runs 26.73 s. The stage medians were 5.83 s for the sandbox outside the passes (1.21 s on 2026-11-17) and 10.39 s for the one pass (4.63 s). The host's CPU was at 100 percent from the other agents' work when this was taken, so the run neither confirms nor refutes the target. It is kept as a record of how far a loaded host moves the figures (about three times for the preview), and as the reason the preview criterion stays open until a quiet run of 20 or more is made.
- **The regression check.** `services/export-worker/scripts/compare-latency.ts` compares a `results.json` with a baseline of three consecutive runs, with a tolerance measured as in ADR 0037 section 6. No baseline is committed yet, for the reason above.