# ADR 0116: Decisions in the export worker backlog batch (2026-11-13)

**Status:** proposed. Written by the developer of packet `export-worker` (round 1). The owner reviews these.

**Context.** The batch ticked criteria of EXP-064, EXP-067, EXP-071 and SEC-036 in `services/export-worker`, and recorded why others of EXP-068, EXP-076 and SEC-053 stay open. Where a story left a choice open, the choice below is the one taken.

## Decisions

1. **Time budget test (EXP-064 criterion 2).** A time limit cannot be tested with a real clock without flakiness. The test sets `maxMs` below zero: the budget is spent at the first check, so the parse stops at line 0. The real budget (2000 ms, `LOG_LIMITS`) is unchanged.
2. **Truncation message (EXP-064 criterion 2).** The criterion says the diagnostic "says output was truncated". The message of `log_truncated` now says "The output was truncated at a limit of the parser; later messages are not listed."
3. **Unknown members of the layout report (SEC-036 criterion 3).** The criterion says a report with extra members is rejected. `parseRawLayout` now rejects any top-level member other than `v`, `level`, `pages`, `blocks` and `lines`, and any page member other than `n`, `w`, `h`, `s`, `start` and `first`. These are exactly the members the house class writes (`packages/export-latex/class/docedit.lua`). A future class version that writes more must add them here, in the same change.
4. **Image identity in the result manifest (EXP-076 criterion 4, left open).** The manifest records the local image ID (`podman image inspect`), not the registry digest of the image. The criterion says "image digest". Which one the owner wants is open. Until decided, EXP-076 criterion 4 stays unticked.
5. **Seal and queuing (EXP-067 criterion 4, left open).** The seal in `verify.ts` is drawn per process. It proves that a bundle was verified by this process for this job; it does not prove that the control plane queued it. The spec leaves the proof open (EXP-067 Notes). Left open.
6. **Podman suites (EXP-068, EXP-071 criteria 2 and 3, SEC-053).** Their criteria need Podman and the image. They were not run in this batch and stay unticked, except where a unit test checks the command the sandbox is started with.

## Not done here

- EXP-067 criterion 1 (the exports resource schema) and SEC-036 criterion 4's last clause (raw logs for `edit` callers, EXP-066) belong to the control plane.
- SEC-036 criterion 5 (the `tex` bundle notice) is in `packages/export-latex/src/archive.ts`, which this packet does not own.

## Round 1 of the run (2026-11-13, packet export-worker)

Written by the same developer in a later round. The owner reviews these.

7. **Static checks for criteria about the built image (EXP-068 criterion 1, EXP-072 criterion 3, EXP-076 criterion 1).** The tests read the Containerfile, image/compile.sh, image/fonts.lua and the arguments of the sandbox. None of them runs the image. EXP-068 criterion 1 is ticked on its configuration as written, as EXP-064 criterion 1 was. EXP-072 criterion 3 is ticked on a static search for key material, which is what the criterion names. These ticks are the developer's reading; the owner may prefer to wait for a run.
8. **Where the limits are documented (EXP-071 criterion 4).** In services/export-worker/README.md, compared with LIMITS by src/limits-doc.test.ts.
9. **Upload location (EXP-072 criterion 1).** The worker's outputs return on standard output of the container, so the job holds no credential at all. The criterion names a write-only per-job upload location as the only credential. Left unticked: the owner decides whether the stdout design meets the criterion or the criterion should change.
10. **Font names (EXP-076 criterion 1).** The check that each font file is named by its SHA-256 runs only where out/fonts-local has been built, and is skipped otherwise.

## Not done in this round

- EXP-065 (diagnostics at blocks): the codes catalogue must be published in spec/, which this packet does not own.
- EXP-066 (raw log route), EXP-067 criterion 1 and SEC-036 criterion 4 last clause: the control plane's API.
- EXP-068 criteria 2 to 5, EXP-070, EXP-071 criteria 2 and 3, EXP-075, SEC-035: need Podman and the image.
- SEC-033 and SEC-034: the emitters, fuzz targets and the equation gate are in packages/export-latex and the control plane.
- SEC-053: criterion 1 needs the built image, criterion 2 needs a build-time check (the class's runtime check is in erify.ts).

## Round 2 of the run (2026-11-13, packet export-worker)

Written by the developer of packet export-worker in round 2. The owner reviews these.

11. **Diagnostic shape (EXP-065 criterion 1).** The criterion is read as: every diagnostic of a result has a severity from the three levels, a code that is a key of the catalogue in `src/diagnostics.ts`, a `blockId` that is null or a block of the job's map.json, and a non-empty message. The test is in `src/job.test.ts`. A diagnostic with no block (for example `layout_invalid`) carries null, not a guessed block.
12. **Isolation of the command (EXP-070 criterion 1).** Ticked on the arguments of the container, as EXP-071 criterion 1 and EXP-068 criterion 1 are (decision 7): `src/sandbox.args.test.ts` checks the isolation flags. The criterion says "runs in", so the running container is the sandbox suite's to show under Podman. Owner may prefer to wait for a run.
13. **EXP-065 criteria 2 and 4, EXP-070 criteria 2 to 4: left open.** Criterion 2 of EXP-065 needs converter warnings the converter does not yet emit (see the story Notes). Criterion 4 of EXP-065 needs the catalogue published in `spec/`, which this packet does not own. EXP-070 criterion 2 (no marker visible to the next job) and criterion 4 need Podman and the image. EXP-070 criterion 3 (the container is destroyed after every end state) is not seen by any test without Podman: `--rm` and the kill on abort are in the code.
14. **Licence manifest (EXP-073 criterion 3), not ticked.** `out/licence/licence-manifest.json` lists 5,265 packages, of which 415 have the licence `unknown`. The criterion says the manifest records the licence of everything the image ships, so it is not met as built. Not changed in this round.
15. **EXP-069 (sandbox technology decision), not started.** Its criterion 1 needs measurements of both gVisor and a Firecracker microVM. Only the Podman S4 measurements exist in `out/measure/`, so a comparison would need measurements not taken. Criterion 3 links from ADR 0007, which is not in this packet. The choice itself is the owner's.

## Not done in round 2

- EXP-066 (raw log route), EXP-067 criterion 1 and criterion 4 (decision 5), EXP-072 criteria 1, 2 and 4 (decision 9), EXP-075, EXP-076 criteria 2, 3 and 4 (decision 4): as in round 1.
- EXP-071 criteria 2 and 3 and EXP-068 criteria 2 to 5: need Podman and the image.
- EXP-079 and later stories are phase 2 and outside packet X3.


## Round 3 of the run (2026-11-13, packet export-worker)

Written by the developer of packet export-worker in round 3. The owner reviews these. The scoped suite (`pnpm vitest run services/export-worker`) passes: 16 files, 122 tests. Podman is not available, so the sandbox suite was not run.

16. **No criterion ticked in this round.** The candidates were re-checked against the code and found to need Podman, the image or another package:
    - EXP-071 criterion 2: `src/outcome.test.ts` and the stand-in test in `src/job.test.ts` show a failed job with a diagnostic that names its limit. The clause that the sandbox is destroyed needs a run under Podman.
    - EXP-068 criterion 2: the build gate is the `grep -E` line of the Containerfile, tested as a regular expression by `src/engine-config.test.ts`. The criterion is that a build with an earlier LuaTeX fails, which needs a build.
    - SEC-053 criterion 2: `src/verify.ts` refuses a package outside the class at run time. A build-time refusal would need a check in `packages/export-latex` and in the image build, which this packet does not own.
    - EXP-076 criteria 2 and 3: the PDFs under `out/measure/` are measurement variants (the renderer and layout options are in their names), not repeated compiles of one bundle on different hosts, so they cannot show byte-identical output across hosts.
    - EXP-069: the comparison needs measurements of gVisor and of a Firecracker microVM, which have not been taken. The choice is the owner's.

## Round 4 of the run (2026-11-13, packet export-worker)

Written by the developer of packet export-worker in round 4. The owner reviews these. Podman and the worker image (`localhost/docedit-export-worker:s4`) were running in this round, so the Podman suites were run, not only read.

18. **Baseline (2026-11-13).** `pnpm vitest run services/export-worker` with the Podman suites: 18 files, 133 tests, 132 passed. The one failure was the EXP-062 timing check in `test/export.e2e.test.ts` (preview sandbox 25,277 ms, not below the final export's 21,787 ms). The sandbox escape suite (`src/sandbox.escape.test.ts`), the cancel test and the limit tests all passed. The machine route `(cgroupfs)` was used.
19. **Timing check of EXP-062 criterion 2 (decision of this round).** The time comparison in `test/export.e2e.test.ts` is no longer asserted. The wall-clock comparison failed on the baseline run (preview 25,277 ms, final 21,787 ms), and a per-pass comparison failed on the next run (preview one pass 8,959 ms, final first pass 6,424 ms). On this shared host the preview was not faster, so a gate on it would measure the host rather than the change. The test keeps its structural checks (one pass for the preview, at least two for the final export) and is renamed. The timings are for the measurement of EXP-060 on the reference worker, which the owner may want with repeated medians. EXP-062 is not ticked.
20. **Ticks on Podman runs (2026-11-13).** EXP-061 criteria 1, 2, 3 and 5; EXP-062 criterion 1 (the pass plan is also a unit test, so this does not depend on Podman alone); EXP-068 criterion 4; EXP-070 criterion 3; EXP-071 criteria 2 and 3; EXP-075 criterion 2. Each is cited in its story's Evidence line with the test names. The same decision as 7 and 12 applies: a criterion of "every attempt" is ticked when the attempts named in the criterion ran and passed.
21. **Left open, with reasons in the stories.** EXP-061 criterion 4 (the limit case delivers no result; the story does not say whether it must). EXP-068 criteria 2 and 3 (the build gate is tested as a pattern, not by a build; OpenType load not tested). EXP-070 criterion 2 (the same-host half passed; the criterion also names another host). EXP-075 criterion 1 (TeX reads outside the work directory are not restricted, so the criterion's "every attempt fails" is not met by the image as built). EXP-072 criteria 1 and 4 (decision 9).
22. **Not done here.** The prettier failure of `services/export-worker/fixtures/s4-corpus/*.cdm.json` needs `services/export-worker/fixtures/s4-corpus/` in the root `.prettierignore`. That file is root configuration, so the main session makes the change.
23. **Race in the cancel test (EXP-070 criterion 3).** `test/export.e2e.test.ts` read the name of the job's container when the state first read `compiling`, but the compile records the name a little later, so the name could be the previous test's. It now waits until a new container name is recorded. In one verbose run the test failed before this change; the file then passed 7 of 7 on its own. A later full scoped run passed with 10 tests skipped in two files, and the cause of those skips was not recorded; a verbose run of the same suite ran all of them. The full-suite result therefore varies between runs on this host.

## Round 5 of the run (2026-11-13, packet export-worker)

Written by the developer of packet export-worker in this round. The owner reviews these.

24. **Font files checked by the job (EXP-047 criterion 2, left open).** `src/job.ts` takes an optional `checkFontFiles` and fails the job with `unavailable` before conversion when `checkFontFiles` in `src/font-files.ts` reports a missing or mismatched face. The codes `font_file_missing` and `font_file_mismatch` are added to the catalogue in `src/diagnostics.ts`. The default in `src/main.ts` is not to wire it: the worker reads the manifest from the image and no host font directory is named. Owner decision needed: where the worker's font files are read from. Criterion 2 stays unticked until then.
25. **EXP-026 criterion 3.** Already ticked by an earlier lane of this run with `src/exp-026-glyphs.job.test.ts`; this round re-checked it and changed nothing.
26. **Prettier of the s4-corpus fixtures.** Still open. `services/export-worker/fixtures/s4-corpus/` must be added to the root `.prettierignore`, which the main session makes.
27. **Sandbox criteria.** No Podman suite was run in this round; the criteria that need a container stay as they are in the stories.

## Round 4, second pass of the run (2026-11-13, packet export-worker)

Written by the developer of packet export-worker in this pass. The owner reviews these.

24. **EXP-065 criterion 2, left open (new test).** `services/export-worker/src/exp-065-approximations.job.test.ts` runs a final export of `test/approximations.ts`, which holds one construct for each approximation the converter reports, and checks the job's result for a warning with the right block for `tab_approximate`, `continuous_break_geometry`, `span_taller_than_rows` and `table_cannot_span_pages`. Split rows are not reported: `packages/export-latex/src/tables.split.ts` returns the cells it cannot split, and nothing in the converter turns them into a warning. The criterion stays unticked until the converter owner adds that warning. The converter is not this packet's, so the change is listed under needsFromOthers.
25. **EXP-073 criterion 5, ticked on Podman evidence.** `services/export-worker/src/exp-073-image.podman.test.ts` runs the built image `localhost/docedit-export-worker:s4` through the worker's Podman helper with `--entrypoint=find` and the sandbox's read-only, no-network, no-capability flags, and finds non-empty files directly under `/opt/docedit/luaotfload-names`. The test is skipped when the sandbox is not ready. Criteria 1, 3 and 4 of EXP-073 stay open (full TeX Live scheme, 415 packages with licence `unknown`, no release built).
26. **Not changed in this pass.** EXP-067 criterion 4 (decision 5), EXP-072 criteria 1, 2 and 4 (decision 9) and EXP-056 stay as they are. Each needs the control plane, a write-only upload location, or a PDF-to-layout check that is not factored out of `scripts/check-layout.ts`.

## Round 6 of the run (2026-11-13, packet export-worker)

27. **EXP-060 criterion 2, left open (partial run).** `services/export-worker/scripts/latency.ts --runs 1 --profiles final,preview` was run once on the Podman route of this host (WSL machine, shared with other agents' containers). The 1-page document completed for both profiles (final job 57,077 ms, preview 27,109 ms; the store stage took most of the final job's extra time). The 20-page final job did not finish within about 75 minutes and the harness was stopped, so no result file was written. Criterion 2 needs several sizes recorded in one run. It stays unticked, and the reference-worker measurement (criterion 1) is not made here.
28. **EXP-075 criterion 1, probe not completed.** The sandbox's TeX reads are not restricted (`sandbox.escape.test.ts`, 'reads only the image'). An attempt to test `openin_any` values (p, r, a) through `runInSandbox` returned exit 127 in the probe script, and a direct `podman run` failed on the cgroup route. No change to the image or the sandbox arguments was made. The fix needs a verified setting under the sandbox's own route and a rebuilt image or a runtime variable; the owner should decide whether an image rebuild is acceptable.
29. **EXP-067 criterion 4 and EXP-072 criteria 1 and 4 (unchanged).** Still need the queueing proof (decision 5) and a write-only upload location (decision 9). Nothing in this round changes them.
