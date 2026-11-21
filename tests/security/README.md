# Security proofs

Black-box tests for the threat model of 10 (PLAN-1a packet F and PLAN-1b packet F). Each test file proves one story's claim against the real service, room or component, and names the story it ticks. They run with the Node.js tests (`pnpm test`); tests that need the integration environment (`infra/test-env.ps1`) skip with a reason when it is down.

## Targets

The adversarial client (`test/support/wire.ts`, `jws.ts`, `harness.ts`) attacks a `Target`: the service's address, two tenants with their keys, and the calls and tokens the client makes itself. Three things give one:

- `startHarness('memory')`: the real service in the test process, on memory storage. Always runs.
- `startHarness('postgres')`: the same on PostgreSQL, when the integration environment is up (`pwsh -NoProfile -File infra/test-env.ps1 up -NoExport`). Skipped with the reason otherwise.
- `openStackTarget()` (`test/support/stack-target.ts`): the compose stack of BE-005, already running, when `DOCEDIT_DEMO_STACK=1`. The service is then another process on its own PostgreSQL and S3-compatible store.

`pwsh -NoProfile -File tests/security/scripts/stack-suite.ps1` starts that stack under its own project name, ports and data directory, runs the client's suite (`test/adversarial-client.test.ts`) against it, removes the stack with its volumes and exits with the suite's code. `-NoExport` leaves the export worker out; `-Keep` leaves the stack running. A suite that only needs the client's half takes a `Target`, so it can be named after the script to run against the stack as well.

## The threat register

`threat-register.json` lists every threat of 10 §3 with its control, the stories that build it and the SEC story whose tests prove it (SEC-001). `test/register.test.ts` checks it on every build, with the rules of `test/support/register-check.ts`.

A row's `status` follows the backlog:

- `proven`: every acceptance criterion of the proving story that the row names is ticked in the epic file. `criteria` lists them by number, starting at 1; without it, all of them count.
- `partly-proven`: tests exist and at least one of those criteria is unticked. `open` lists each unticked criterion and what it still asks for.
- `control-not-built`: no tests yet, with the `phase` the control is due in.

`tests` names test files: a name without a slash is a file of `test/` here, a path with a slash starts at the repository root. Each file must exist and must name the proving story in its own text.

When you tick or untick a criterion of a proving story, edit the row in the same change: the test fails and says which row and what to change. A change to the register is reviewed by a second maintainer (SEC-001 criterion 5).
