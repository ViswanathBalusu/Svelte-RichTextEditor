# Phase 1a work plan

**Status:** working plan, 2026-11-06. It splits the 164 stories of phase 1a (`BACKLOG.md`) into packets that agents can run in parallel without editing the same files. 11 §3 gives the goal: the smallest thing that proves the risky ideas together. The exit criteria are that the demo runs from a compose file and that the S3 property tests run against the real service.

## Inputs from phase 0

| Input | From | Used by |
|---|---|---|
| CDM definition, schemas, `validate()`, canonical form | `packages/model` (done; completion agent ticking CDM and FND) | everything |
| Authority, room state machine, outcome check, S3 harness | `packages/authority` (S3 done; completion agent ticking SYN and PRM) | A1, B, F |
| DEP definitions, port typings, mock backend, contract tests | `packages/protocol`, `packages/backend-mock` (S6 agent) | A1, A2, B, F |
| Element, ProseMirror in the shadow root, CSP findings | `packages/element`, `packages/engine` (S1 and S2 agent) | B, C, D |
| PostgreSQL storage, GrantStore, test environment | `services/document-service/src/storage`, `infra/` (storage agent) | A1, A2, E |
| Converter, house class, sandboxed worker | `packages/export-latex`, `services/export-worker` (S4 agent) | D |
| Corpus | `packages/corpus` (corpus agent) | D, F, perf |

## Packets

Each packet lists its stories, the directories it owns, and what it waits for.

| Packet | Stories | Owns | Waits for |
|---|---|---|---|
| **A1 Data plane** | BE-019, BE-024, BE-025, BE-026, BE-029; PRO-017 (server side), PRO-021, PRO-022, PRO-023, PRO-027, PRO-028, PRO-029, PRO-031, PRO-032, PRO-033, PRO-037; PRM-006, PRM-019, PRM-020, PRM-024; SYN-004, SYN-014, SYN-015, SYN-035, SYN-047; HIS-001, HIS-002, HIS-003 | `services/document-service/src/data-plane/` | storage, S6 |
| **A2 Control plane** | BE-001, BE-003, BE-008 to BE-013, BE-017, BE-032, BE-033, BE-035, BE-036, BE-049, BE-088; PRO-008, PRO-009, PRO-010, PRO-011, PRO-012, PRO-038, PRO-040, PRO-041, PRO-042, PRO-045, PRO-046, PRO-049, PRO-051, PRO-052, PRO-063, PRO-064; PRM-002, PRM-018 | `services/document-service/src/control-plane/`, `src/server.ts` (composition) | storage, S6 |
| **B Client** | FE-001 to FE-039 of phase 1a, FE-121, FE-122, FE-127; SYN-017 to SYN-020; PRO-004, PRO-005, PRO-006, PRO-074, PRO-075, PRO-076, PRO-080, PRO-087, PRO-088, PRO-093, PRO-094; CDM-012 (engine side) | `packages/engine`, `packages/backend-dep`, `packages/element` | S1/S2, S6 |
| **C Shell** | UX-001, UX-003, UX-004, UX-006, UX-014, UX-016, UX-025, UX-026, UX-064; FE-007 | `packages/ui` | B's element API (can start on components first) |
| **D Export** | EXP-001, EXP-042; FE-071 | `packages/export-latex`, `services/export-worker`, `packages/element/src/pdf/` | S4, A2 (export jobs), B |
| **E Reference host** | UX-091, UX-092, UX-093, UX-094; BE-005 | `apps/reference-host`, `infra/compose` | A2 (token minting), B |
| **F Security proofs** | SEC-001, SEC-002, SEC-003, SEC-012, SEC-013, SEC-017, SEC-019, SEC-021, SEC-025, SEC-026, SEC-027, SEC-031, SEC-045, SEC-047, SEC-050, SEC-059 | `tests/security/`, `packages/tck` | A1, A2 |
| **G Foundations** | FND-008 (bundle gate), the rest of FND-004 and FND-011 (notices in bundles and images) | root scripts and CI (main session) | B's build |

Shared files are the main session's to edit: `services/document-service/package.json` (agents add dependencies only through `scripts/pnpm-locked.ps1`), root configuration, CI.

## Interfaces fixed before the packets start

- The storage contract between the room and PostgreSQL: `WriteRequest`, `WriteResult` and `StoredCommit` in `packages/authority/src/room/types.ts`.
- DEP messages, resources, the error registry and the ports: generated from `packages/protocol` (S6). The room's in-process message names (`sync.ack` and the rest) are reconciled with them in A1.
- The element's embedding contract (attributes, properties, methods, events), from PRO-074 to PRO-088.
- Read restrictions (ADR 0019, proposed): no packet may assume readers see the whole document. Content reads, sync and presence go through one function per visibility class, even while that function is still the identity, so that S12's projections plug in.

## Exit check (11 §3)

The demo runs from the compose file:

- two browser tabs with different region grants edit at once;
- one tab gets a visible rejection when it tries to change the other's region;
- a grant change takes effect live;
- the commit log is recorded in full;
- a PDF from LuaLaTeX in a container without network shows in the PDF panel.

The S3 property suite passes against the real service (SYN-047).

## Progress (kept by the main session)

- 2026-11-06: phase 0 inputs landed: model and authority completion, PostgreSQL storage (ADR 0020), S6 (protocol, backend-mock), S1 and S2 (engine, element, ui), S7 (layout core: fork Docen), S12 (read restrictions), the second review. S4 (LaTeX) and S11 (DOCX) are still running.
- Started on 2026-11-06: A1 data plane, A2 control plane (interface between them: `services/document-service/src/seams.ts`), B1 engine, B2 element (takes FE-071 from D, since it owns `packages/element`), B3 `backend-dep` (takes PRO-004 to PRO-006), C shell. Also running outside 1a: field rules (`packages/rules`, FRW-014 to FRW-020), M1 and M2 (model, 1b), R1 and R2 (authority, 1b), and the client performance harness with S5 and S10 (`packages/perf`, FND-007).
- Waiting: D export (for S4), E reference host (for A2's token minting and B2), F security proofs (for A1 and A2), G foundations (bundle gate after B2's build).
- ADR numbers reserved for the agents, so that none is taken twice: 0030 rules, 0031 M1, 0032 M2, 0033 R1, 0034 R2, 0035 A1, 0036 A2, 0037 performance harness, 0038 B1, 0039 B2, 0040 B3, 0041 C, 0042 K (conformance kit). Protocol decision numbers: D40 to D59 A1, D60 to D79 A2, D80 to D99 B3, D100 to D119 K.
- B1 (editing core and sync client, ADR 0038) finished. Waiting on B2's Playwright rerun in the four browsers: when it passes, tick FE-032 criteria 4 and 6, FE-038 criterion 7 and FE-039 criterion 4 (B1's stories, which need that browser run), and check the nested-footnote paste test of e2e/s1-footnote-model.spec.ts. Done by the main session: `hosts-no-prosemirror` boundary rule (FE-026 criterion 1), `@docedit/backend-mock` moved to the engine's dev dependencies.
- The performance agent finished FND-007 (criteria 1 to 4), S5 (font-file measurement) and S10 (harfbuzzjs with breaking in TypeScript; ADR 0016 updated). Findings: web-view typing on pages-100 is 40 ms at the median against 16 ms, and `validate()` after a commit costs 192 ms on pages-100; two agents now work on them (ADR numbers 0055 typing latency, 0056 incremental validation). `.github/workflows/perf.yml` (main session) holds the nightly harness on a self-hosted `docedit-reference` runner (not registered yet), calibration on demand, the weekly S5/S10 matrix and the Rust module check.
- Finished: B2 (the element, ADR 0039; 781 passed in four browsers; first interactive editor 166.1 kB gzip) and the release and supply-chain packet (ADR 0044). Done by the main session from their reports: every action in ci.yml and perf.yml pinned to a commit verified against the GitHub API; `pins:check`, `origins:check` and `release:dry-run` scripts, with the first two in CI's check job; scripts/third-party-notices.ts follows the workspace closure; the four old licence scripts formatted; `svelte-check` moved to the shell's dev dependencies; FND-008 criterion 1 ticked.
- Finished: K (conformance kit, ADR 0042; 19 profiles; its defects in the reference service went to A-1b, C-1b and the authority's phase 2 agent) and S (asset worker, ADR 0043; its interface went to C-1b). CI gained the `conformance-kit` job (Python canonical form, the kit's tests, its Podman image).
- Started: the element's phase 1b agent (ADR 0057), first task the shell's hand-over. Queued for the editing core's phase 1b agent, which starts when the typing-latency agent (ADR 0055) finishes in packages/engine: the shell's core-side CoreApi members (commandNames/runNamed, 1b queries and queryReason, selection contexts, stats, language, styles, carets, setRegionLabels, selectBlock, search, caretRect, modes, fill), plus PLAN-1b packet B1's stories.
- Before the first release: the MIT texts with copyright lines of the packages the licence exceptions name (is-reference, locate-character, pg-types, pgpass, and any added since) must be written into the notices; the owner sets up a `release` environment with required reviewers and npm trusted publishing for `@docedit/element` once the repository has a remote; backend-dep should export its in-memory DEP server and network as a testing entry (packages/element's test imports them by path).
- Main-session follow-ups (root configuration and CI, which agents may not edit): a CI job comparing artifact sets across versions (PRO-006 criterion 2, once a second artifact set is published); the lossless DOCX round trip in CI (EXP-120, job from the DOCX agent); a self-hosted reference runner for the perf workflow (FND-007 criterion 5); the release and supply-chain workflows' root script entries (from the release agent); Vite's dependency pre-bundling for the browser test project (Vite reloads a test after optimising `prosemirror-transform`; under pnpm the entry must resolve from the root, so test the fix before adding it); `tests/security` has no lockfile importer until its first dependency is added.
- More reservations: 0045 compile service, 0046 converter, 0047 DOCX, 0048 E (reference host), 0049 F (security proofs), 0050 authority phase 2 permissions, 0051 history algorithms (`packages/history`), 0052 U (shell 1b), 0053 A-1b (data plane; protocol decisions D120 to D139; migrations 0030 to 0039), 0054 C-1b (control plane; D140 to D159; migrations 0040 to 0049). A1 (data plane 1a, ADR 0035, decisions D40 to D42) finished; packets A and C of phase 1b started. Finished too: R2 (sync, ADR 0034: S12 leaks fixed, mapped steps), C (shell 1a, ADR 0041). Finished: A2 (control plane, ADR 0036), B3 (backend-dep, ADR 0040), S4 (LaTeX spike).
- More reservations: 0043 S (asset worker), 0044 the release pipeline and supply chain (FND-012, SEC-051, SEC-052, SEC-054; allowed to create new files under `.github/workflows/` and `scripts/`, not to edit existing ones).
- Finished on 2026-11-06: the field rules (ADR 0030), S11 (lossless DOCX; ADR 0017 holds, with its "Changes from spike S11"; the model changes went to M1), M2 (computed semantics, ADR 0032) and R1 (permissions and fills, ADR 0033). The S12 property suite went red when R2's snapshot work landed (a hidden value in `sync.commit`); R2 has it. Packet K (conformance kit, phase 1b) started.
