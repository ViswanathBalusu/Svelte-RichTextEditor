# ADR 0434: The sandbox technology of the compile workers (EXP-069)

**Status:** accepted for the choice, 2026-11-15 (owner decision 146 in `docs/owner-decisions-2026-11-15.md`: "gVisor (ADR 0045), still to be measured"). The comparison measurements are outstanding. Recorded by lane w2, 2026-11-26.

**Story:** EXP-069 (`docs/stories/EXP-export.md`). **Related:** ADR 0007 (linked from there), ADR 0045 section 10, EXP-070.

## Context

Every export job runs in a single-use sandbox (EXP-070). The spec (09 §9.3 item 3) asks for one technology to be chosen between gVisor and a Firecracker microVM. ADR 0045 §10 holds the comparison as a proposal and says gVisor is recommended for production, with Podman and crun for development. The owner answered on 2026-11-15 with gVisor.

## Decision

1. The sandbox of a production compile worker is gVisor (`runsc`), as an OCI runtime under Podman, containerd or Kubernetes (`RuntimeClass`). This is the owner's decision 146.
2. Development and the compose demo keep Podman with crun, as built (ADR 0045 §10).
3. Firecracker is not chosen. Its cost (KVM on every node) is the reason, as ADR 0045 §10 states; the owner's answer does not name it, so the choice of gVisor over Firecracker rests on ADR 0045 §10 and is not measured here.
4. The record is accepted for the choice only. It is not accepted as a measured comparison: the start-up time and memory overhead of gVisor and Firecracker are not measured (see Consequences).

## How each property of EXP-070 is met with gVisor

These are the properties that the OCI runtime settings give, and the runtime runs the same image. They are stated here, not measured on gVisor. The escape suite (`services/export-worker/src/sandbox.escape.test.ts`, `exp-070-sandbox-properties.escape.test.ts`) ran under Podman with crun only.

| EXP-070 property | How it is met |
|---|---|
| Single-use sandbox | One container per job, started with `--rm` and removed at the end, whether the job finished, failed, timed out or was cancelled. |
| No network | `--network=none`. |
| Read-only root file system | `--read-only` with `--read-only-tmpfs=false`. |
| Temporary working directory | One tmpfs at `/work` with `noexec,nosuid,nodev`. |
| Capabilities dropped | `--cap-drop=ALL`, no `--cap-add`, and `--security-opt=no-new-privileges`. |
| Non-root user | `--user=10001:10001`. |
| Nothing visible to the next job | Nothing a job writes outlives its container; no volume or mount is shared between jobs. Same-host check: `sandbox.escape.test.ts`. Another-host check: not run. |
| Plain runtime and orchestrator | The same image runs under a plain runtime and under an orchestrator's `RuntimeClass` (gVisor). The orchestrator run is not done here. |

## Consequences

- The choice is recorded and linked from ADR 0007. Criterion 2 of EXP-069 is met as a statement.
- Criterion 1 (a comparison on S4 measurements of both options) is not met. gVisor and Firecracker are not installed on the development machine, and only Podman measurements exist. The record is accepted for the choice only after the escape suite and the corpus timings run on gVisor on the reference worker (ADR 0045 §10).
- EXP-070 criterion 4 (orchestrator) and criterion 2 (another host) stay open for the same reason.
- The gVisor run of the escape suite is the next step; it needs a Linux host with `runsc`.
