# Reference host

A small host application for `<doc-editor>` (13 §11.2) and the demo stack of phase 1a (11 §3): demo sign-in, a token endpoint, the page glue, the host's own document catalogue, and a compose definition of the document service, PostgreSQL, an S3-compatible store, one export worker, a development mail sink (Mailpit; it keeps what the host sends in memory and delivers nothing) and this host. The host's notification mail (a mention, a task) goes to that sink when `DOCEDIT_HOST_SMTP` is set, which the stack does; the addresses are the host's own (`seed/users.json`), never the document service's. The owner of a document can send it for completion from its page (/as/<person>/docs/<id>/send): the host binds people to the roles, invites them by e-mail when the service says their turn has come, and asks each for a one-time passcode before it mints their token (/fill/<reference>). The view in which a participant fills and signs is not built yet.

**Demo only. This is not a production deployment.** Visitors choose a person without a password, every service listens on 127.0.0.1 only, the settings in `stack/.env.example` are test values, and the keys the stack generates are for this demonstration and nothing else. Decisions: [ADR 0048](../../docs/adr/0048-reference-host-and-demo-stack.md).

## Start the demo

From the repository root, with Node.js 22.18, pnpm and Podman (`DOCEDIT_CONTAINER_CLI` names another CLI):

```
pwsh -NoProfile -File apps/reference-host/scripts/stack.ps1 up
```

Then open http://127.0.0.1:56490/, choose a person, and open the document. For two people at once, open the start page in a second tab and choose the other person. `stack.ps1 status` shows each part, `logs` their last lines, `down` stops the stack and keeps its data, `down -Volumes` removes the data too, and `reset` starts again from the seeded state.

Where Compose works (Linux):

```
podman compose -f apps/reference-host/compose.json --env-file apps/reference-host/stack/.env.example up --build
```

## Seeded data

`seed/`: the tenant, four people (`users.json`), and the template and document of `documents.json`: a supply agreement with paragraphs in three styles and two restricted regions, the payment section editable by Ada and the delivery section by Bob. Olivia owns it and can change region grants and roles in the panels under the editor.

## Checks

```
pnpm exec vitest run --project node apps/reference-host
pnpm exec playwright test -c apps/reference-host/playwright.config.ts
```

The second runs the exit check of phase 1a (`e2e/exit-check.spec.ts`) and the host's own checks against the stack, starting it first (`DOCEDIT_DEMO_REUSE=1` uses a running one).
