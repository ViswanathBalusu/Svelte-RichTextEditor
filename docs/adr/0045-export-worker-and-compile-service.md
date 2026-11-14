# ADR 0045: The export worker and the compile service

**Status:** proposed, 2026-11-06. Records the choices made while building the export worker of `services/export-worker` (PLAN-1a packet D, EXP-001; PLAN-1b packet X3: EXP-060 to EXP-076, SEC-035, SEC-036, SEC-053) on top of spike S4 ([report](../spikes/2026-11-06-s4-latex-compile.md)). The project owner has not reviewed any of it.

## Context

09 §9 describes the compile service and its sandbox rules, 10 §3.4 the threats, and [ADR 0007](0007-latex-export-pipeline.md) the pipeline. The control plane of [ADR 0036](0036-control-plane.md) has the export job resource, the queue and the object store, with decisions D68 and D69 of the protocol's register. Spike S4 built the sandbox, the compile script and the layout report, and measured them. Several things the worker needs are not settled by any of these: where the worker runs and where its trust boundary is; how a worker knows a bundle came from the converter (EXP-067, open question); what a preview compiles with; whether the 120 seconds of 09 §9.3 item 4 cover all passes; whether a final export that does not converge fails; which error code a failed job carries; the defaults of `locale` and `timeZone`; the sandbox technology (EXP-069); and what production needs for limits and mounts.

## Decision

### 1. The worker is a queue consumer; the sandbox is the boundary

- The worker is its own process, `pnpm --filter @docedit/export-worker start` (`src/main.ts`): a `JobRunner` of the control plane over its PostgreSQL queue (`docedit_claim_job`), with no HTTP port. It reads the content at the job's `seq` from the service's database and bucket (the newest checkpoint and the commits after it, rebuilt with the authority's `contentAt`), and writes its outputs under the job's prefix through the service's `AssetStore`. Every storage call uses the tenant of the job's row (BE-049). In tests the same worker runs on the parts of an in-process service.
- The trust boundary is the sandbox container, not the worker process. The worker process never runs document content: it converts with the pure converter and reads everything the sandbox returns as hostile. The sandbox has no credential at all: no network, no host path, no environment beyond the job's variables, and its outputs leave on standard output. 09 §9.3 item 6 allows at most a write-only, per-job upload location; this design needs none, because the upload happens in the worker process after the sandbox has ended. The worker process holds the database and bucket credentials of the service.

### 2. Job flow

`queued`, then `converting` (content, plan, conversion, seal, checks), then `compiling` (sandbox, parsing, storing), then `completed`, `failed` or `cancelled` (D68). The outputs are `output.pdf` (`application/pdf`), `layout.json` (`application/json`, only when it passed its schema), `compile.log` (`text/plain; charset=utf-8`, at most 16 MiB) and `manifest.json`, the result manifest: job, document, `seq`, profile, tagging, standard, locale, time zone, SOURCE_DATE_EPOCH, bundle hash, class version, CDM version, image name and identifier, passes, convergence, limits, and the size and SHA-256 of every output. The job's result holds the file names (`ExportOutputs`), the page count, convergence, the diagnostics, and stage times (`metrics`: queue wait, content, conversion, checks, sandbox, each pass, the sandbox's time outside the passes, parsing, storing, log size). The worker logs the same numbers as one `export.completed` line (BE-088: numbers only).

A cancelled job aborts the sandbox's signal: the worker kills the container, whose `--rm` removes it, and stores nothing further.

### 3. Profiles

| Profile | Passes | Tagging | Standard |
|---|---|---|---|
| `final` (default) | at least 2, at most 4, until `main.aux`, `main.toc` and `main.out` stop changing (S4) | `on` | PDF/UA-2 and PDF/A-4f |
| `preview` | exactly 1 | `off` | none |

- **Previews compile with `tagging=off`, not draft tagging.** S4 found that `off` keeps exactly the line and page breaks of a tagged compile at 36 to 65 % of its cost, while draft tagging saved only 13 to 35 %, and that leaving out `\DocumentMetadata` moves breaks (S4 §4.4). 09 §3.1 and §8 say previews "may" use draft tagging; `off` keeps what that wording is for. A tagging mode named in the request wins over the profile's default.
- **A final export that does not converge is delivered, flagged**: `converged: false` and the warning `references_not_converged`. 09 leaves this open (EXP-061 notes). Sealing (EXP-079) should refuse such a PDF.
- **A preview's page references may be stale**: `converged: false` and the information `preview_one_pass`.
- `pdfStandard` `a-4` is declared as PDF/A-4f with the warning `pdf_standard_substituted`, because tagged PDF embeds associated files that PDF/A-4 forbids (S4 §2). `ua-2` needs tagging `on`.
- **Defaults where 09 and EXP-005 name none:** the locale is the document's language (`settings.lang`), else `en-GB`; the time zone is UTC. `date` fields print the job's creation instant in that zone (09 §3.1).
- An option the worker cannot honour fails the job with `option_unsupported` instead of being dropped: `comments: margin` (EXP-084), `suggestions: markup` (EXP-083), `certificate` (FRW-050). Options it does not know are ignored with `option_ignored`, so a request can never add TeX (EXP-067).
- **Restricted views are refused** with `unsupported_feature` and `view_unsupported` while the job's class hides any region or value, until the projection reaches the converter (EXP-123). The full document is never exported for a reader who may not see all of it.

### 4. Limits

The values are 09 §9.3 item 4's; how each is enforced, and how the worker tells which was reached:

| Limit | Value | Enforced by | Recognised by |
|---|---|---|---|
| Wall clock | 120 s for the whole job, all passes; 110 s for one pass | `timeout -s KILL` per pass (compile.sh), `podman run --timeout`, the worker's own timer | exit 137 at the pass limit, exit 255, the timer |
| CPU | 1 core | `--cpus=1` (cgroup `cpu.max`), `RLIMIT_CPU` 120 s | |
| Memory | 1.5 GiB, no swap | `--memory`, `--memory-swap` | exit 137 before the pass limit (the kernel's out-of-memory kill) |
| Processes | 64 | `--pids-limit`, `RLIMIT_NPROC` | |
| Output | 200 MiB per file and on standard output | `RLIMIT_FSIZE`, the worker's read limit | exit 153 (SIGXFSZ), the read limit |
| Working directory | 256 MiB | tmpfs size | "No space left on device" in the log |
| Pages | 2,000 | the class, for converter output only | the class's message in the log |

- 09 does not say whether the 120 seconds cover all passes (EXP-071 notes). This record says they do: 09 §9.3 names limits "per job". The figure is the spec's target, not a measurement. Measured on the test desktop with the shared corpus (§9), a final export of `pages-100` (81 pages, three tagged passes) took 65.8 to 81.1 s of wall clock; S4's 99-page document took 56 to 95 s. Longer documents will reach the limit. Whether they should is the owner's and the spec's question; EXP-063 is the alternative.
- A job that reaches a limit fails with `too_large`, a message that names the limit and its value, and a diagnostic `limit_<name>`.
- **What production needs.** cgroup v2 with the `cpu`, `memory` and `pids` controllers delegated to the user that runs rootless Podman (for example `Delegate=cpu memory pids` for `user@.service`), or the equivalent of the orchestrator's runtime. Without delegation crun refuses `--pids-limit` and the memory and CPU limits ("controller `pids` is not available", S4 §3). The route `DOCEDIT_PODMAN_MACHINE`, which runs `podman --cgroup-manager=cgroupfs` inside a Windows or macOS Podman machine, is for development only.

### 5. Nothing from the host in the sandbox

- Podman's default `mounts.conf` puts the host's `/run/secrets` into every container (S4 §3). Every `podman run` of the worker names an empty default mounts file with the global flag `--default-mounts-file` (`DOCEDIT_DEFAULT_MOUNTS_FILE`, default `/dev/null`), on a local Podman and on the machine route. The Windows and macOS remote clients refuse that flag, so there the readiness check refuses any sandbox in which `/run/secrets` exists, and the worker falls back to the machine route or does not start. Production worker hosts should also ship an empty `/etc/containers/mounts.conf`.
- The tests list the sandbox's mounts (only overlay, tmpfs and kernel file systems), its environment (job variables only), the ports of the database and the object store (unreachable), and every readable file outside the TeX tree for private keys (none).

### 6. Workers compile only converter bundles

09 leaves open how a worker knows a bundle came from the converter. Two checks run before the engine starts:

- **Provenance.** Right after conversion, the worker seals the bundle with HMAC-SHA256, under a key that never leaves the worker process, over the job's identifier and the bundle hash. The compile step refuses a bundle whose seal does not verify. The job payload cannot carry a bundle: a payload with a member such as `files`, `tex` or `preamble` fails with `bundle_refused` and nothing compiles. The control plane writes no such member.
- **Content.** Exactly the converter's files (`main.tex`, `styles.tex`, `docedit.cls`, `docedit.lua`, `map.json`, `manifest.json`, and `assets/<sha256>.<ext>` named by the hash of their bytes); every hash as `manifest.json` lists it and the right bundle hash; the class files byte for byte the pinned ones and the pinned class version; and neither `main.tex` nor `styles.tex` loads a package or a class, inputs a file other than `styles.tex`, runs Lua, changes category codes or opens files. The converter writes user text only through its emitters, so these commands can come only from someone else.

### 7. Diagnostics

- The log is written without wrapping (`max_print_line` 1,048,576), so document text, which TeX prints only after other text on a line, never starts a log line. Errors carry `./main.tex:<line>:` (`--file-line-error`).
- The parser (`src/diagnostics.ts`) reads only fixed line shapes at the start of a line; skips every box dump up to its empty line and the line after a runaway argument; finds a block only from TeX's line number through `map.json`; and builds every message from a catalogue of codes, with a detail cut to plain characters (no `<`, `>`, `&`, quotes or backslashes, at most 160 characters). Its bounds are settings: 16 MiB of log, 500,000 lines, 2,048 characters per line, 200 entries, 2 s; a bound reached adds `log_truncated`.
- The codes: `tex_error`, `tex_undefined`, `tex_fatal`, `latex_error`, `class_error`, `package_error`, `missing_glyph`, `overfull_line`, `references_changed`, `undefined_reference`, `font_substituted`, `package_warning`, `log_truncated`, `limit_time`, `limit_memory`, `limit_output`, `limit_pages`, `limit_workdir`, `limit_processes`, `layout_invalid`, `references_not_converged`, `preview_one_pass`, `pdf_standard_substituted`, `option_ignored`, `option_unsupported`, `option_invalid`, `suggestions_unsupported`, `view_unsupported`, `bundle_refused`. The converter's own codes come with its diagnostics. Codes never change meaning.
- A failed job keeps its diagnostics. For that, `JobFailure` and `JobQueue.fail` of the control plane take an optional result, kept when the job ends failed (the one edit this work made in `services/document-service/src/control-plane/jobs/`).

### 8. Error codes of failed jobs

The registry of 05 §5.8 has no code for exports, so a failed job uses the nearest registered one: `too_large` (a limit), `validation_failed` (the document did not compile, an option is invalid or unsupported, the payload carries TeX), `unsupported_feature` (the converter cannot write the document, a restricted view), `unavailable` (the sandbox did not run; retried), `not_found` (the document is gone or was replaced), `internal` (a bundle failed its checks, a malformed payload, content that cannot be rebuilt). The diagnostics say exactly what happened. Whether DEP should register an export code is for the protocol.

### 9. Reproducibility

SOURCE_DATE_EPOCH is the job's creation time in whole seconds and FORCE_SOURCE_DATE is set (09 §9.4); the converter fixes TeX's random seed; the job path is always `/work/job`; fonts are addressed by hash; the base image is pinned by digest and the result manifest records the image's identifier. The same bundle with the same epoch on the same image gives the same PDF.

### 10. The sandbox technology (EXP-069): proposal, not yet measured

| | Podman with crun (built) | gVisor (`runsc`) | Firecracker microVM |
|---|---|---|---|
| Isolation | Namespaces, seccomp, cgroups; the host kernel is shared | A user-space kernel between the compile and the host kernel | A hardware virtual machine per job |
| Runs the OCI image as it is | yes | yes, as an OCI runtime under Podman, containerd and Kubernetes (`RuntimeClass`) | through Kata Containers or firecracker-containerd |
| Needs | cgroup v2 delegation | nothing beyond the runtime | KVM on every node |
| Start-up and memory overhead | S4: 1.1 to 2.1 s per job outside the passes, on the WSL machine route | not measured | not measured |

The recommendation is gVisor for production, with Podman and crun for development and the compose demo, because gVisor adds a kernel boundary without needing KVM on every node and runs the same image under every supported orchestrator. Neither gVisor nor Firecracker is installed on the test desktop (nor libkrun, so `--runtime=krun` could not be tried), so their costs are unmeasured; the record is accepted only after the escape suite and the corpus timings run on gVisor on the reference worker. How each property of EXP-070 is met with gVisor: one container per job with `--rm` (single use); `--network=none`; `--read-only` with `--read-only-tmpfs=false`; one tmpfs at `/work`; `--cap-drop=ALL` and `no-new-privileges`; user 10001; nothing a job writes outlives its container; the same image starts under a plain runtime and under an orchestrator's `RuntimeClass`.

### 11. The image

Still S4's: the full TeX Live 2026 scheme of the Island of TeX image, pinned by digest (5.99 GB). A curated image with only the class's packages (EXP-073), the licence manifest from the TeX Catalogue and the source offer (SEC-053) are not built yet. CJK fallback fonts (Noto Serif CJK and Noto Sans CJK, OFL-1.1, from Debian's snapshot archive of the base image's date) need a network download at build time and wait for the owner's permission; until then the fallback chain is STIX Two Math only, and Chinese, Japanese and Korean text is missing from previews and stops final exports.

### 12. Security notes (EXP-068)

- Shell escape is off, `openin_any` and `openout_any` are paranoid, LuaTeX is 1.24 (the build refuses one older than 1.17), and `--safer` is not used, because it stops OpenType fonts loading.
- Any TeX injection is arbitrary Lua: `debug` and `io` stay reachable inside LuaTeX. In LuaTeX 1.24 paranoid input does not stop `\openin` or Lua from reading absolute paths (S4 §6), so the image must hold nothing secret, no host path may be mounted, and the container is the boundary. The worker treats the PDF, the log, the layout report and the pass timings as hostile.

## Consequences

- An export needs only the service's database, its bucket and a host with Podman; the document service runs no compile.
- A document that passes a limit fails with a diagnostic instead of a partial PDF; long final exports reach the 120 s limit first.
- Previews are cheaper than S4's draft-tagging assumption, and their breaks are the final breaks.
- Restricted readers cannot export until EXP-123.
- Measured figures replace the unit-cost sheet's assumptions A13, A14, A15 and A20 only in its basis column; the sheet's section 9 has not been re-run.

## Open questions

1. Whether the 120 s limit covers all passes, and what long final exports should do (owner, 09 §9.3 item 4). This record: it covers all passes.
2. Whether a final export that does not converge fails or is delivered flagged (09 §8; EXP-061). This record: delivered flagged.
3. Whether previews may compile with `tagging=off` although 09 names draft tagging (EXP-062). This record: `off`.
4. An export error code in DEP's registry (05 §5.8).
5. The default time zone (UTC here) and locale (the document's language) of EXP-005.
6. The sandbox technology, after gVisor (and, if needed, Firecracker) are measured on the reference worker.
7. The download of the CJK fallback fonts at image build time (owner, asked on 2026-11-06).
