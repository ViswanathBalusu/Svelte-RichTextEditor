# ADR 0037: The reference machine, its CPU throttling profile, and how the harness compares runs

**Status:** proposed, 2026-11-06 (FND-007).

## Context

The client targets are written for "a mid-range laptop": typing latency of 16 ms at the median and 50 ms at the 95th percentile up to 100 pages (00 §9), time to interactive under 2 seconds for 20 pages and memory under 300 MB for 100 pages (13 §9). 00 §9 asks for the measurement to be "the Event Timing API on a named reference machine with CPU throttling, not an unspecified laptop". Nothing in the spec names the machine, the laptop class or the throttling factor, and nothing says how a regression is told apart from noise. FND-007 needs all of that before any figure from the harness means anything.

Chromium can slow a page's main thread through the DevTools protocol (`Emulation.setCPUThrottlingRate`). A rate is only meaningful against a workload: the same rate slows different machines and different work by different amounts. So the profile has two parts, a machine and a rate, and the rate is chosen by measuring a calibration workload against the laptop class it stands for.

## Decision

### 1. The reference machine (`reference-1`)

| Part | Value |
|---|---|
| Machine | Alienware Aurora R11 desktop, the development machine of 2026-11-06 |
| Processor | Intel Core i9-10900KF: 10 cores, 20 threads, 3.7 GHz base (Comet Lake) |
| Memory | 128 GiB, DDR4-2667, four 32 GiB modules |
| Graphics | NVIDIA GeForce RTX 3080 |
| Operating system | Windows 11 Pro 10.0.26300, power plan "High performance" |
| Browser | Playwright 1.65's Chromium build (158.0.8127.18 on that date), headless (`channel: 'chromium'`), one page of 1280 × 800 CSS pixels at device scale factor 1, no extensions |
| Node.js | 22.18 |
| Harness | `packages/perf` (`src/reference.ts`), tests run one at a time |

### 2. The laptop class and the throttling rate: 1

- **The class.** "Mid-range laptop" is taken to mean a mainstream business laptop with an Intel Core i5-1235U, a 2022 processor four years old at the time of writing. Examples are the Lenovo ThinkPad T14s Gen 3 and X13 Gen 3, and the Microsoft Surface Laptop Go 3. The class is a proposal; the owner may name another, and the procedure below then gives its rate.
- **The published scores.** Notebookcheck's processor database (consulted 2026-11-06) lists the browser benchmark WebXPRT 3 for both processors:
  - [Core i5-1235U](https://www.notebookcheck.net/Intel-Core-i5-1235U-Processor-Benchmarks-and-Specs.589637.0.html): median 251 points over 11 laptops;
  - [Core i9-10900K](https://www.notebookcheck.net/Intel-Core-i9-10900K-Processor-Benchmarks-and-Specs.466211.0.html): median 255 points over 3 systems. The 10900KF is the same chip without integrated graphics.

  The same database lists WebXPRT 4 for the i5-1235U (median 226 over 10 laptops) but not for the i9-10900K.
- **The rate.** By the published scores, the laptop class runs browser work at 251/255 = 0.98 of the development machine's speed: the machine has to be slowed by about 1.6 %. The calibration workload (§3) needed a rate of 1.25 for a slowdown of 30 % to 36 % (two runs), so a 1.6 % slowdown lies inside the workload's own run-to-run spread. The profile's rate is therefore **1**. It is still set explicitly in every run, and recorded.
- **Why the rate is 1 although 00 §9 asks for throttling.** The throttling is part of the definition, not a fixed slowdown. It is 1 on this machine because this machine is about as fast as the laptop class. It is greater than 1 on a faster machine, or for a slower class, and the procedure of §4 finds it.

### 3. The calibration workload

`packages/perf/pages/calibrate.html`. One iteration does the main-thread work the editor does, in a fixed amount:

1. builds the corpus document `pages-100` with the corpus generator;
2. serialises it to JSON and parses it again;
3. renders its paragraphs as DOM in a 624 px column in Noto Serif, then changes the text of 300 paragraphs one at a time with a forced layout after each.

The spec `e2e/calibrate.spec.ts` (`DOCEDIT_CALIBRATE=1`) runs a warm-up and seven iterations at each rate and writes the times to `test-results/calibration/`. Two runs on the reference machine on 2026-11-06, median of seven iterations at each rate:

| Rate | Run 1 (machine 39 % to 63 % busy) | Run 2 (24 % to 43 % busy) | Slowdown, run 1 / run 2 |
|---:|---:|---:|---|
| 1 | 237.4 ms | 223.4 ms | 1 / 1 |
| 1.25 | 308.1 ms | 302.9 ms | 1.30 / 1.36 |
| 1.5 | 410.3 ms | 366.1 ms | 1.73 / 1.64 |
| 2 | 531.1 ms | 483.5 ms | 2.24 / 2.16 |
| 3 | 1,499.0 ms | 1,076.8 ms | 6.31 / 4.82 |
| 4 | 1,734.0 ms | 1,146.3 ms | 7.30 / 5.13 |

- **The slowdown is not the rate.** It is close to proportional up to 2 and grows much faster above it, and it varies between runs above 2. A rate therefore has to be calibrated by measurement, never assumed.
- **The reference time.** The reference time at rate 1 is kept in `packages/perf/baseline/calibration.json`: 223.4 ms, from run 2.
- **Other load.** Other agents' builds and tests shared the machine during both runs. The busy share of all logical processors is recorded with every result.

### 4. How another maintainer reproduces the profile

1. Use a machine at least as fast as the reference machine, with its power plan set for performance and nothing else running.
2. Run `DOCEDIT_CALIBRATE=1 pnpm exec playwright test -c packages/perf/playwright.config.ts --project=reference calibrate`. The result's `advice.rateForThisMachine` is the reference time divided by this machine's time at rate 1.
3. Run the calibration again with `DOCEDIT_CALIBRATE_RATES=<that rate>`. Adjust the rate until the median is within the spread observed on the reference machine. Bisect: the response is not proportional above 2.
4. Run the harness with `DOCEDIT_CPU_THROTTLE=<rate>`. Its results are recorded under the profile `custom-<rate>x` and compared only with each other, unless the owner adopts the machine as a new reference.
5. A machine slower than the reference cannot reproduce it, and its results are not comparable with the baseline.

To change the laptop class:

1. Take the class's published median from the same benchmark and source as this machine's.
2. The required slowdown is this machine's median divided by the class's.
3. Find the rate that gives that slowdown on the calibration workload.

### 5. What the harness measures, and how

`packages/perf/e2e/harness.spec.ts` on the reference profile:

- **Typing latency (00 §9).**
  - *Setting.* `pages-100` in the web view of `<doc-editor>`, loaded through the in-memory backend as the element's demos load documents. 150 keystrokes are typed into a body paragraph in the middle of the document, 80 ms apart. Each keystroke starts on an idle main thread: the in-page backend's work runs after the frame, and the harness waits for it.
  - *What is measured.* The Event Timing API, per keystroke: the longest entry of its interaction.
  - *How it is reported.* Browsers report nothing under the 16 ms threshold and round to 8 ms. So the median and the 95th percentile are nearest-rank quantiles over all keystrokes sent, given as "below 16 ms" when they fall among the unreported ones.
  - *Cross-check.* A requestAnimationFrame-based figure is reported beside it.
- **Time to interactive (13 §9).** For `pages-20`, the median of five cold loads. Lighthouse's definition is used without its network condition: the end of the last long task before a 5-second window with none, never before the element's `de-ready` or the first contentful paint. The in-page backend's document creation is subtracted, because a host's backend is not in its page.
- **Memory (13 §9).** For `pages-100` after loading and typing, and after a forced garbage collection: the private memory of the page's renderer process (Windows `PrivateMemorySize64`; on Linux, private clean plus private dirty pages). `measureUserAgentSpecificMemory()` and the JavaScript heap are reported beside it.
- **"Usable to 300 pages" (13 §9).** The spec gives no figure for "usable", and this record does not invent one. The metric is the typing measurement above on `pages-300`, judged against the same typing targets of 00 §9. Load time, time to interactive and memory are reported without a target. If the owner wants a looser threshold for 300 pages than for 100, it is the owner's number to set.
- **Result files.** Every run writes `test-results/runs/<run>.json`, stamped with the machine, the browser version, the profile, the corpus version (`corpusStamp()`), the commit (`DOCEDIT_COMMIT`) and the machine's busy share.

### 6. Regressions: baseline and tolerance

- **The baseline.** `packages/perf/baseline/reference-1.json` holds one value per metric, taken from a run on the reference profile.
- **The check.** `node packages/perf/scripts/compare-baseline.ts` fails when a metric is worse than its baseline by more than the tolerance, relative to the baseline value. It also fails when a baseline metric is missing, or when the corpus version or the profile differs.
- **The tolerance.** It is not chosen; it is measured, per metric, across three consecutive harness runs on the reference machine. It is the relative spread (maximum minus minimum, over the median), rounded up to the next 5 %, and never under 5 %. For the Event Timing quantiles it is at least one step of the API's own 8 ms rounding. `scripts/spread.ts` computes it and writes the baseline (values: the medians of the runs). Until the scheduled job runs on a quiet, dedicated machine, the tolerance reflects a shared machine and is wide; it is re-measured there.

### 7. Measured spread (2026-11-06)

Three runs of `pnpm exec playwright test -c packages/perf/playwright.config.ts --project=reference harness` (run identifiers 2026-11-06T17-17-42Z, T17-21-20Z and T17-26-16Z). Other work kept 30 % to 39 % of the machine's processors busy during run 1, 52 % to 88 % during run 2 and 62 % to 77 % during run 3:

| Metric | Run 1 | Run 2 | Run 3 | Spread | Tolerance |
|---|---:|---:|---:|---:|---:|
| Time to interactive, `pages-20` (ms) | 236.0 | 278.0 | 388.6 | 54.9 % | 55 % |
| Typing, `pages-100`, median (ms, Event Timing) | 40 | 40 | 40 | 0 % | 20 % (one 8 ms step) |
| Typing, `pages-100`, 95th percentile (ms) | 40 | 40 | 40 | 0 % | 20 % |
| Memory, `pages-100` (MB, renderer private) | 106.8 | 98.7 | 98.0 | 8.9 % | 10 % |
| Typing, `pages-300`, median (ms) | 56 | 96 | 64 | 62.5 % | 65 % |
| Typing, `pages-300`, 95th percentile (ms) | 72 | 112 | 104 | 38.5 % | 40 % |
| Memory, `pages-300` (MB) | 169.3 | 155.9 | 159.1 | 8.4 % | 10 % |

The baseline file has every metric of a run, the informational ones included.

**Sensitivity at rate 2** (profile `custom-2x`, one run, 2026-11-06T17-30-33Z). The machine was 79 % to 96 % busy, partly with the model measurements of `scripts/model-costs.ts`, so these figures are an upper bound and not a profile:

- time to interactive for `pages-20`: 1,383 ms;
- typing on `pages-100`: 72 ms at the median, 184 ms at the 95th percentile;
- typing on `pages-300`: 152 ms and 312 ms;
- memory unchanged (94.6 MB and 159.0 MB).

A run at rate 4 was started and stopped to save time. It is not reported.

## Consequences

Good:

- Every performance figure names its machine, browser, rate and corpus, and runs are compared only like with like.
- The rate is defined by a procedure, so a new machine or a new laptop class needs a measurement, not a guess.
- The harness separates the client's own work from the in-page test backend's.

Bad:

- The reference machine is a shared development desktop. Its other work adds noise (24 % to 88 % of its processors were busy during the runs of 2026-11-06), so the tolerance is wide until the scheduled job has a dedicated machine.
- The laptop class rests on a published benchmark from other browser versions (WebXPRT 3 results labelled Chrome 82). That is a weaker link than running the calibration workload on a real laptop of the class, which is the better calibration when one is available.
- Throttling slows only the page's main thread. Compositing, rasterisation and workers run at the machine's full speed, so a real laptop is slower than the profile wherever those dominate.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A fixed rate of 4, Lighthouse's default multiplier ([Lighthouse throttling guide](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md), consulted 2026-11-06) | The guide's table recommends 2 (range 1 to 4) from a high-end desktop to a low-end desktop, and 4 (range 2 to 10) from a high-end desktop to a mid-tier phone; neither row is a laptop, its classes date from Chrome 86, and §3 shows that a rate's effect must be measured. The harness can still run at 2 or 4 as a sensitivity check (`DOCEDIT_CPU_THROTTLE`); those runs are labelled custom profiles |
| Calibrate directly against WebXPRT 4 by running it on this machine | WebXPRT sends results and device data to its publisher, which the harness should not do; and its workloads use workers, which CPU throttling does not slow |
| Speedometer 3 as the calibration workload | Close to the editor's work, but no laptop scores from one source were found to calibrate against |
| A real mid-range laptop as the reference machine | The best option when the project owns one; this record's procedure moves to it unchanged |
| No throttling profile, only "the developer's machine" | What 00 §9 rules out |

## Revisit when

- The project has a dedicated runner for the scheduled job, or a laptop of the class: calibrate on it and re-measure the tolerance.
- The owner names a different laptop class, or a phase adds mobile targets.
- Chromium changes how `setCPUThrottlingRate` works (the response in §3 changes).
