# 0114 Reference host backlog batch (round 1)

Status: proposed

Date: 2026-11-13

## Context

Packet "reference-host" covers UX-091 to UX-097 and BE-005. Its code lives in `apps/reference-host`. Most of the packet needs a running stack (containers, PostgreSQL, object storage, a browser), which this round did not run. This note records the decisions taken in code and stories, and the questions left open. None of them is an owner decision.

## Decisions taken (spec defaults, to be confirmed)

1. Tests of the page glue (`apps/reference-host/test/glue.test.ts`) use a stand-in element and a fake `fetch`, not a browser. The stand-in covers the glue's branches; the element itself and the page are tested elsewhere.
2. `EditorLike` in `apps/reference-host/src/lib/glue/page-glue.ts` no longer extends `HTMLElement`. It lists the four event and attribute members the glue uses. This keeps the module checkable under Node types and changes no runtime behaviour. Callers that pass a real element still type-check structurally.
3. The token request sets `cache: 'no-store'` (UX-092 criterion 3, the browser side only).
4. The host's catalogue and the service calls stay as already built. UX-092 criteria 2, 4 and 5, UX-093 criteria 2 and 5, and UX-094 criteria 1 and 4 are ticked on the evidence in their stories.

## Open questions (not decided here)

| Question | Where | Status in this round |
|---|---|---|
| Where the compose file for BE-005 lives: `infra/compose` (PLAN-1a names it) or `apps/reference-host/compose.json` (already present) | BE-005, UX-091 | Not decided. BE-005 needs `infra/compose`, which is outside this packet. |
| Whether the compose file also runs the reference host and a mail sink | UX-091, UX-098 | Open in the spec (13 section 11.2). Not decided. |
| Semantics of `DEP-Actor` (which operations accept it, whose rights bound the call, what history records for a service credential without a session) | UX-096 | Not picked up: a security decision, with owner review required. UX-097 waits for it. |
| Whether the share dialog sets `restrict` and when the change takes effect | UX-095 | Not picked up: depends on UX-039, which is not built. |

## Criteria left open, with reasons

- UX-091: every criterion needs the containerised stack (Podman), so none is ticked. The export worker's lack of network (criterion 2) and the two-user scenario in CI are not run.
- UX-092 criterion 1 (demo sign-in marked as demo-only), criterion 3 (private key never reaches the browser in a running stack).
- UX-093 criterion 1 (the three functions against the seeded directory: the route needs a SvelteKit run), criterion 3 (the journal reappears after navigation: element side, PRO-083), criterion 4 (example toolbar: needs PRO-085 and a DOM), criterion 6 (depends on UX-095).
- UX-094 criteria 2 and 3 (the new-document dialog and the title slot are UI), 5 (editor network traffic in a browser), 6 (keyboard, screen reader and axe).
- BE-005: the whole story needs `infra/compose` and the containers.

## Consequences

Stories UX-092, UX-093 and UX-094 are partly done. The evidence names `apps/reference-host/test/host.test.ts` and `apps/reference-host/test/glue.test.ts`. Both run with `pnpm vitest run apps/reference-host` (27 tests pass; no containers or browsers used).

## Round 1 additions: UX-095, UX-096 and UX-097

### Decision: semantics of `DEP-Actor` (UX-096, accepted with changes by owner decision 174 on 2026-11-15; security review pending)

Owner decision 174 (docs/owner-decisions-2026-11-15.md) tightens points 2 and 3 below: a service credential acting for a user is bounded by that user's rights, and the audit trail records the credential as well as the user. The text of points 2 and 3 as first proposed follows, then the rule as it now stands in 05 section 3.2 and 07 section 14. A security review is still required before release. Lane w3, 2026-11-18: 05 section 3.2 and 07 section 14 are amended; the kit's `authz` profile has the scenarios `actor.user-token` and `actor.opaque` (packages/tck/src/profiles/authz.ts, `packages/tck/test/ux-096-actor.reference.test.ts`). The scenario for the bound itself, a service call naming a user who lacks the right is refused, is not in the kit, because the service cannot yet tell what the named user may do (a document role and groups are claims of the user's tokens); that is UX-097 criterion 4.

The spec default, read from the code the document service already runs (BE-033), with the open points named:

1. **Which operations accept the header.** The control plane reads `DEP-Actor` on every call that carries a service credential, whatever the route (`services/document-service/src/control-plane/pipeline.ts`, the caller resolution). It names the user by `sub`; the value must be an opaque identifier (otherwise `validation_failed`, 400), and the service resolves it to the tenant's surrogate. Creation, content writes and grant changes then record that surrogate. Without the header the actor is `system`.
2. **Whose rights bound the call.** The service credential's. A service credential passes every row of the authorisation matrix (the `guard` comment in `pipeline.ts`, decision D65). The named actor's capabilities do not bound the call, so a host that names a user it has not checked can act with the tenant's full service rights. This is the least safe reading and it is the one the code takes today. The story's aim (no call may exceed anyone's rights) would need the actor's capabilities to bound the call. That is a change in the document service, outside this packet: recorded as `needsFromOthers` in the round report and left for the owner and a security review.
3. **What history records for a service call with no session.** The surrogate of the named user, or `system` when none is named. The audit trail does not record which service credential (key identifier) made the call: that identifier is written to the logs only (`Caller.credential`). The spec's attribution table (08 section 2) lists user, session and agent, and no credential. Proposed: add the key identifier to the audit entry. Open; not decided here.
4. **A user token with `DEP-Actor`.** The header is ignored: the actor of a user call is the token's own `sub` (`pipeline.ts`, the user branch, BE-033). The service's route tests send such a call and assert the status only, so the attribution is not yet asserted end to end (see UX-097 criterion 3).

Not done in this round: the 05 and 07 amendments and the conformance-kit negative tests named by UX-096 criterion 5 wait for acceptance.

### UX-095: output restrictions in the next token

The host keeps `restrict` per user and document in its catalogue (`apps/reference-host/src/lib/server/catalogue.ts`, `setRestrict`; `documents.ts`, `setRestrictions`, which refuses names outside `no-export`, `no-copy`, `no-print`). The token endpoint puts them into the token (`tokens.ts`, `claimsOf`; `routes/as/[user]/api/token/+server.ts`). Tested in `apps/reference-host/test/host.test.ts`, "output restrictions in the next token": the service reads the claim back for both issuers. The share dialog itself is not built (UX-039 is not built); criteria 1 to 4 and 6 of UX-095 stay open.

### Test caveat

The `DEP-Actor` test in `host.test.ts` checks creation (`createdBy`). It does not check a commit or an audit entry, so UX-097 criterion 1 stays open.

### Round 1 tooling

Checks run: `pnpm vitest run apps/reference-host` (31 tests in two files, in memory, no containers or browsers) and `tsc --noEmit -p apps/reference-host/tsconfig.node.json` (clean). `progress.ps1` was not run (the orchestrator runs it).

## Round 2

Stories ticked: UX-093 criterion 1 (`getToken`, `resolveUsers`, `searchPrincipals` against the host's own routes and the seeded directory; `test/glue-wiring.test.ts`) and UX-091 criterion 4 (demo-only secrets and the statement that it is not production; `test/stack.test.ts`). Both are tested at handler and configuration level. Neither needs a browser or a container, and neither is claimed beyond that.

### Fixed from the review

`svelte-check` reported three errors in `src/routes/as/[user]/docs/[id]/+page.svelte`. The editor element is an `HTMLElement` and the glue's `EditorLike` view of it needs a cast through `unknown`. The toolbar now receives the element itself, which is a `CommandHost` because `queryCommand` and `exec` are optional on it. `svelte-check` reports 0 errors.

### Decisions for the owner (proposed, spec default kept)

1. Export worker network (BE-005 criterion 4, UX-091 criterion 2). `apps/reference-host/compose.json` gives `export-worker` `network_mode: host`. The worker has the host's network, so the criterion is not met as written. The spec default (09 section 9.3) is that only the sandbox has no network, which is what `export-sandbox` does (`network_mode: none`). Left as it is: changing the worker to a network with no route out needs a compose decision in `infra/`, which this packet does not own. Owner to decide whether the worker's own network is acceptable.
2. Output restrictions before the share dialog (UX-095, owner panel). Unchanged from round 1: the owner sets them in the editor page's owner panel, applied from the person's next token, with no session revocation.

### Still open (not decided here)

- UX-094 criterion 2 (title slot), 3 (title slot and the list updating live), 5 (editor traffic) and 6 (accessibility) need the page in a browser. The server side of 2 and 3 is in `host.test.ts`.
- UX-092 criterion 3 (the private key never reaches the browser; token not in a URL, log or storage) needs a built page and a running stack. Not ticked.
- UX-093 criterion 3 (flush before navigation) and 4 (example toolbar) wait for PRO-083 and PRO-085.
- UX-091 criteria 1, 3 (registration of keys and origins through `scripts/setup.ts`), 5, 6 and 7 and BE-005 criteria 1 to 3 and 5 need containers or PostgreSQL. Not run in this round.

### Round 2 tooling

`pnpm vitest run apps/reference-host`: the two new files pass (11 tests). `svelte-check --tsconfig ./tsconfig.json`: 0 errors. Containers, PostgreSQL and browsers were not running and were not used.

## Round 3

Stories ticked: UX-097 criterion 3 (a user token's `DEP-Actor` has no effect; `test/host.test.ts`, "a user token with DEP-Actor acts for the token holder only"). Bob, an editor, is refused with 403 when `DEP-Actor` names the owner, and the owner's token with `DEP-Actor` naming Bob succeeds, so the header is not honoured either way. This rests on the pipeline's rule that `DEP-Actor` is read only for a service credential (`services/document-service/src/control-plane/pipeline.ts`, BE-033).

New test file: `test/server-only.test.ts` (UX-092 criterion 3, in part). It runs the layout load, the editor page load and the token endpoint, and checks that no response names the signing key. A second test checks that no client-side file (route `.svelte` and `.ts` files that are not server modules, and `lib/glue`) names the signing key or imports the server's token or config modules. UX-092 criterion 3 stays unticked: it also says the token is not placed in a log or in browser storage, and neither is asserted. The page itself is not loaded in a browser.

Decision recorded, not taken: UX-097 criterion 1 (commit and audit name the surrogate) needs a room commit or an audit entry. The audit store records only rejections (`services/document-service/src/data-plane/audit.ts`), so the criterion stays open.

### Round 3 tooling

`pnpm vitest run apps/reference-host`: 6 files, 51 tests pass, in memory, no containers or browsers. `tsc --noEmit -p apps/reference-host/tsconfig.json` and `tsconfig.node.json`: clean. `check-stories.ps1` and `progress.ps1` were not run (the orchestrator runs them).

## Round 4

Stories ticked: none. The packet's remaining criteria that a test in `apps/reference-host` can reach were checked against the code, and each one that is left needs a browser, a running container or PostgreSQL, or a decision the owner has not taken.

Work done: the tenant registration that `scripts/setup.ts` writes is now built by `tenantRegistration` in `scripts/lib/stack.ts` (the same content as before, one function). `test/registration.test.ts` applies it with the service's own `parseSeed` and `applySeed` to a `MemoryTenantRegistry` and checks the host key, the hashed API key (the secret is not in the file), the origins, the absence of the private key, and that a second apply changes nothing. This supports UX-091 criterion 3 and BE-005 criterion 2 in memory. Both stay unticked, because each is stated for a running stack.

Checked and left open, with the reason in the story Notes:

- UX-094 criteria 2, 3, 5 and 6: the title slot, live list updates, editor network traffic and accessibility need the page in a browser. The server side of 2 and 3 is already tested in `host.test.ts`.
- UX-095 criteria 1 to 4 and 6: the share dialog's UI is not built (UX-039).
- UX-097 criterion 1: a content-changing call needs a room commit, and the audit store records only rejections.
- UX-097 criterion 4: no refusal exists while the rules in UX-096 say the named actor's rights do not bound a service call. This waits for the owner's acceptance of the decision.
- UX-093 criterion 3: the journal that brings the work back belongs to the element (PRO-083).
- UX-091 criterion 2 and BE-005 criterion 4: the export worker runs with `network_mode: host`. Still the owner's decision (Round 2, item 1).

Tooling: `pnpm vitest run apps/reference-host` passes, including the new file. `pnpm exec tsc --noEmit -p apps/reference-host/tsconfig.json` and `tsconfig.node.json` report no errors. No containers, PostgreSQL or browsers were used.

## Round 5 (reference-host packet, batch round 1)

Stories ticked: none. This round added server-side evidence for three stories and changed one message. Every criterion that a test could reach is either ticked already or is blocked by the reasons below.

Work done:

- `test/attribution.test.ts` (UX-097): a prefill through the service with `DEP-Actor` is stored with the person's surrogate and origin `prefill`; without `DEP-Actor` it is stored as `system`. The wire shows the sub for the person, as the service maps surrogates back to subs (`kit.ts`). Criterion 1 stays open: the audit entry is not written.
- `test/dialog-routes.test.ts` (UX-095 and UX-094): the owner's `role` action, and the list's create, rename and delete actions, are run through the route modules against the in-memory service. The `role` action's message now says whether the change ends the person's sessions now or applies from their next token (`src/routes/as/[user]/docs/[id]/+page.server.ts`).

Decision recorded, as found in the code (not changed here): `changeRole` ends the sessions on any change of an existing role, including a raise from viewer to editor, and not only on removal or lowering. The message follows that behaviour. The spec (05 section 3.3) asks for revocation when a role is taken away or lowered; raising one is stricter than the spec requires. Whether to keep the stricter rule is for the owner. Proposed default: keep it, because it is simpler and fails safe.

Still open, with reasons:

- UX-095 criteria 1 to 3 and 6: the share dialog is not built (UX-039). The owner panel stands in for it; its server halves are tested, the UI is not.
- UX-094 criteria 2, 3, 5 and 6: the title slot, the live list update, the new-document dialog and accessibility are UI.
- UX-097 criterion 1: the audit entry. Criterion 4: waits for the owner's acceptance of UX-096.
- UX-096 criterion 5: the 05 and 07 amendments and the conformance negative tests wait for acceptance.

Tooling: `pnpm vitest run apps/reference-host` passes, 9 files and 65 tests. `tsc --noEmit` on `tsconfig.json` and `tsconfig.node.json` report no errors. `svelte-check` was not run this round. No containers, PostgreSQL or browsers were used. `check-stories.ps1` and `progress.ps1` were not run (the orchestrator runs them).

## Round 6 (reference-host packet, batch round 2)

Stories ticked: UX-092 criterion 1 (the demo sign-in). Built, not ticked: the share dialog (UX-095), and the owner's role action now takes `filler`.

Work done:

- `src/lib/share/share-model.ts`: the role choices (the six of 13 section 5), the label of each, when a change takes effect and the message after a save. The role action (`src/routes/as/[user]/docs/[id]/+page.server.ts`) uses it, so the message is the one the tests check.
- `src/lib/share/ShareDialog.svelte`: a native modal dialog. It lists the seeded people with a role form each (posting to the existing `role` action) and the groups with their members' roles. It has no region-grant or workflow forms; it points to the editor's permissions pane. It is opened by the Share button (owners) and by `de-share-request` through `onShareRequest` in the editor page.
- `src/lib/server/directory.ts`: a `groups` getter, so the owner's load can list them.
- `src/routes/+page.svelte`: a visible "Demo only" notice (UX-092 criterion 1).
- Tests: `test/share-model.test.ts` (pure rules) and `test/share-routes.test.ts` (the filler role through the route module, the owner's groups, the sign-in action and the start page markup, the dialog's markup).

Decisions taken as the spec default, to confirm:

- `filler` is offered and stored. 13 section 5 lists it among the dialog's roles and the criterion names it; the earlier action refused it. Default: offer it as the spec lists it.
- Groups hold no document role. The token and the catalogue keep roles per person, so a group row is read-only and shows its members' roles. Open for the owner: whether a group should be able to hold a role (that needs the catalogue and the token model to key roles by principal, not by person). Default: no.
- A change of an existing role (for example viewer to editor, or to filler) ends the sessions now, as `changeRole` does. The message says so. This is the same stricter rule recorded in round 5.

Still open, with reasons:

- UX-095 criteria 1 to 4 and 6: the dialog's rendering, its save message on screen, the focus trap and the return of focus are browser behaviour and were not run. Criterion 5 is ticked.
- UX-093 criterion 6: the wiring exists (`openShare`); not run in a browser.
- UX-092 criterion 3: unchanged (the page is not loaded in a browser).
- UX-093 criterion 4 (example toolbar): the element now offers `queryCommand`, `exec` and `flush` (`packages/element/src/doc-editor.ts`), but no DOM test library is installed for this package, so the toolbar is not tested. Not added (no dependency change was asked for in this round).
- UX-091 criterion 2 and BE-005 criterion 4 (the export worker's network): unchanged. `compose.json` gives `export-worker` host networking. That is the owner's choice (see Round 2 and Round 4 above).

Tooling: `pnpm vitest run apps/reference-host` passes, 11 files and 82 tests. `svelte-kit sync` and `svelte-check --tsconfig ./tsconfig.json` in `apps/reference-host` report 0 errors and 0 warnings across 380 files. `tsc --noEmit -p tsconfig.node.json` reports no error in `apps/reference-host`; it reports errors in `packages/authority` (another packet's file), which were not touched. No containers, PostgreSQL or browsers were used.

## Round 7 (reference-host packet, batch round 3)

Stories ticked: UX-093 criterion 4 (the example host toolbar). Evidence: `apps/reference-host/test/host-toolbar.test.ts`, which runs `attachHostToolbar` against a stand-in element that offers only `queryCommand`, `exec`, `focus` and the listeners, and a stand-in DOM. The test checks the four buttons, the states, `exec` on click only when enabled, the refresh from `de-command-state`, removal on detach, and (from the source) that the module touches no other element member. The page is not run in a browser.

Checked and left open, with reasons:

- UX-091 criteria 1, 3, 5, 6, 7 and BE-005 criteria 1 to 3 and 5: need containers or PostgreSQL. Criterion 2 and BE-005 criterion 4 (the export worker's network): `compose.json` still gives `export-worker` `network_mode: host`. This is the owner's choice (Round 2, item 1); not changed here.
- UX-096 criterion 5 (05 and 07 amendments, conformance negative tests): waits for the owner's acceptance of the decision.
- UX-097 criteria 1 and 4: audit entry, and refusal under the current rule (see Round 1 and Round 4).
- UX-093 criteria 3 and 6: the flush journal is the element's (PRO-083); the share dialog wiring needs the page in a browser.
- UX-094 and UX-095: UI criteria only, unchanged.

Decision recorded, not taken: none new.

Tooling: `pnpm vitest run apps/reference-host` passes, 12 files and 89 tests. `tsc --noEmit -p apps/reference-host/tsconfig.json` reports no error in `host-toolbar`. `check-stories.ps1` reports 0 problems. No containers, PostgreSQL or browsers were used. `progress.ps1` was not run (the orchestrator runs it).
