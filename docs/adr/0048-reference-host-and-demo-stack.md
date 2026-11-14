# ADR 0048: The reference host and the demo stack of phase 1a

**Status:** proposed, 2026-11-06. Written while building `apps/reference-host` (PLAN-1a packet E: UX-091 to UX-094, BE-005). Not reviewed by the project owner. Where 13 §11, 06 §13 and 11 §3 are silent, the code follows the readings below; none is an owner decision.

## Context

13 §11.2 asks for "a small reference application (SvelteKit and a compose file for the document service, PostgreSQL, object storage and one export worker)" that is the demo harness of the first phase; 11 §3 gives the demo's exit check; 13 §11.1 lists what a host must build. They do not say how a demo visitor signs in, which token issuer the host uses, where the host keeps its catalogue, how the stack runs on a machine where Compose cannot start it, or how the exit check is automated.

## Decisions (proposed)

### 1. SvelteKit 3, with the element from its distributable

- The host is a SvelteKit 3.1 application built with adapter-node into `build/`, as 13 §11.2 says. SvelteKit 3 takes its configuration in `vite.config.ts` (it has no `svelte.config.js`), and its hook types are in `@sveltejs/kit/hooks`.
- `scripts/serve.ts` serves the build on 127.0.0.1 and on ::1. It tells adapter-node the protocol on every request, because adapter-node otherwise assumes `https` and SvelteKit's same-origin check of form posts fails on plain HTTP.
- The page embeds `<doc-editor>` from the element's distributable (`packages/element/dist/lib`), which the host serves under `/element/`, as an adopter serves an installed component. It never compiles the element's source. The page uses only the element's attributes, properties, methods and events (05 §8.1).
- The PDF viewer's page is opened from the host's second origin (`http://localhost:PORT` while the pages are on `http://127.0.0.1:PORT`), so its frame is cross-origin (FE-071), with its own policy: no inline code, no eval, framed only by the host's pages, fetching only from the object store. The set-up gives the bucket CORS rules for GET and HEAD from the host's origins.
- The host page's policy is SvelteKit's, with a nonce per response, plus `connect-src` for the document service (HTTP and WebSocket) and `frame-src` for the viewer's origin. Trusted Types are not enforced on the host page yet.

### 2. Demo sign-in

- A visitor picks a seeded person (`seed/users.json`) and no password is asked. Every page says it is a demonstration and not a production deployment.
- Each person's pages and API live under `/as/<sub>/`, and the session cookie (random identifier, HttpOnly, SameSite=Strict) is scoped to that path, so two tabs of one browser can act as two people, which the demo of 11 §3 needs. The path alone grants nothing: without the cookie the visitor is sent to the start page.
- Sessions live in the server's memory and end after 8 hours without use (a setting, not a measurement).

### 3. Tokens

- The token endpoint (`POST /as/<sub>/api/token` with `{ docId }`) authenticates the person by the demo session, takes their role from the host's catalogue (403 without one), and returns a token for that one document, with `sub`, `name`, `grp` and `access_since`. It answers with `Cache-Control: no-store`; the token is never put in a URL, a log line or browser storage.
- The issuer is a setting, `DOCEDIT_DEMO_TOKENS`: `service-minted` (the default; `POST /tokens`, PRO-011, which packet E's brief names and the plan waits on) or `host-signed` (the host's own P-256 key, ES256, registered for the tenant with the issuer `docedit-reference-host`). UX-092's notes recommend the host-signed path; both are tested against the service (test/host.test.ts), and the owner may prefer to make `host-signed` the default.
- Tokens live 300 seconds by default (a setting; at most 900, 05 §3.1). Each call issues a new token, so the element's renewal on `auth.expiring` works without the person doing anything.

### 4. The host's catalogue

- The catalogue is one JSON file in the stack's data directory, written whole and atomically by the one host process: titles, the role of each person, `access_since`, and a soft-deletion time. A real host keeps this in its own database.
- A new document gets the `externalId` `refhost-<UUID>` and the creator becomes its owner; the template gives the other roles and its region grants, stored with `PATCH /grants` after creation. Seeded documents have fixed `externalId`s, so seeding finds them again instead of creating more; a catalogue entry for another document with the same `externalId` is replaced (the service's data was reset).
- Every service call made for a person sends `DEP-Actor` with their `sub` (13 §11.3).
- Taking a role away, or changing it, calls `POST /sessions/revoke` for that person and document (05 §3.3), so the person is cut off at once.

### 5. The page glue

- `src/lib/glue/page-glue.ts` is framework-free, to be copied into any page. On `de-auth-required` it asks nothing more of the person when it can help it: an ended host session shows the host's sign-in; a role the host no longer gives shows "no longer have access"; otherwise (the service refused the token) it calls `load()` once within 30 seconds (a setting), which asks for a new token.
- Its comments point to the spec section and name the section of the integration guide (UX-090, phase 1b) that will carry the example; until the guide exists they cannot point into it.
- The example host toolbar and `flush()` before navigation are written against 05 §8.1 and do nothing until the element offers `queryCommand`, `exec`, `de-command-state` and `flush` (phase 1b).

### 6. The stack

- `compose.json` (JSON is valid YAML, as in `infra/containers`) defines PostgreSQL and the S3 gateway (the images and digests of the integration environment), one-shot `setup` and `seed` jobs, the document service, the reference host, the export worker, and the export sandbox image (`network_mode: none`). The Node.js services share one image built from `containers/Containerfile` with the whole workspace. Data is in named volumes, so documents and their history survive a restart.
- `scripts/stack.ps1` starts the same definitions on a machine where Compose cannot: containers with `podman run` (`--cgroups=disabled` on a WSL Podman machine, host networking on 127.0.0.1, as `infra/test-env.ps1`), and the services marked `x-docedit-process` as local Node.js processes with the same commands, detached by `scripts/spawn.ts` so that a caller whose output is a pipe is not kept waiting. The container CLI is `DOCEDIT_CONTAINER_CLI` (default `podman`).
- Ports 56432 (PostgreSQL), 56470 (S3), 56480 (service) and 56490 (host), project `docedit-demo`: none collides with the integration environment.
- Secrets (the host's API key, its signing key, the service's token key, the view key and the cursor secret) are generated by the set-up the first time and kept in the data directory with the volumes, marked demo-only; `down -Volumes` removes both, and the next `up` starts from the seeded state.
- The tenant's registration (its key, the API key's hash and the allowed origins) is a seed file the service applies at start (`DOCEDIT_TENANTS_FILE`, BE-012). The allowed origins are the host's two loopback names; `http://[::1]:PORT` is left out because the service's registry does not accept IPv6 literals in origins yet.
- The export worker is packet D's process (`services/export-worker`, `start`), started by the stack when it exists. On a Windows host whose Podman machine cannot apply the sandbox's limits, the stack passes the running machine as `DOCEDIT_PODMAN_MACHINE`. In Compose the worker reaches the machine's Podman through its socket.
- The compose file runs the reference host and no mail sink; the mail sink belongs with UX-098 (UX-091's open question).

### 7. The exit check

- `e2e/exit-check.spec.ts` is a Playwright scenario against the stack: one browser context per person (their own cookies), steps in order. A step that waits for a piece still being built is marked `test.fail` with the reason and the owner, so it reports "expected to fail" now and turns red the day it passes.
- "The commit log is recorded in full" is checked by reading the log back from PostgreSQL with the service role through the service's own storage classes (`scripts/log-report.ts`): contiguous sequence numbers, every field of each record, surrogates instead of the hosts' `sub`, the hash chain, and what each person typed under which grants revision.
- "Without network" is checked by starting the sandbox image with exactly the export worker's own arguments (`sandboxArgs`) and trying a public address, a name lookup and the stack's own ports from inside (`scripts/sandbox-probe.ts`).

## Consequences

- The demo runs on a development machine with one command (`stack.ps1 up`) and is checked by one command (Playwright); on Linux the same definitions run with `podman compose`.
- The scenario runs against the working tree: while other packages change, a step can fail for their reasons; the failure names the step.
- To revisit: the default token issuer; a production image per service (`pnpm deploy`) instead of the workspace image; Trusted Types on the host page; the catalogue in a database once the host has more than one process.
