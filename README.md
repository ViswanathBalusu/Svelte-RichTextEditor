# Document editor web component

**Status:** specification draft 0.2 (2026-09-18), with the owner's decisions of 2026-11-06. Phase 0 spikes and the first packages are being built; progress per story is in [docs/stories/PROGRESS.md](docs/stories/PROGRESS.md). Licensed under Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).

## What this project is

A document editor with the same features as Microsoft 365's Word for the web (styles, tables, headers and footers, comments, suggestions, version history and the rest), delivered as one framework-agnostic web component. The goal is the same capabilities, not an imitation of that product: the editor has its own design. The component is built with Svelte 5 and isolates itself in its own Shadow DOM. It talks to its backend only through a written, versioned protocol, so the backend can be replaced or re-implemented in another language.

Documents can carry fillable fields that are assigned to people and governed by customizable rules, in the manner of e-signature products, and end as a sealed PDF with evidence of who did what.

The requirements that shape the design more than anything else:

1. Owners can allow specific people to change only specific parts of a document, regions of text and individual fields, and the server enforces it.
2. The product keeps a full, tamper-evident history of who changed what and when.
3. Final output is typeset by a LaTeX-based export backend.
4. The backend must scale from one node to very large deployments without a redesign.
5. It is an all-round package: component, backend, reference host application, integration guide and administration interfaces.

## Reading order

| Document | What it covers |
|---|---|
| [00 Overview](docs/spec/00-overview.md) | Goals, non-goals, requirements, assumptions awaiting confirmation, glossary |
| [01 Architecture](docs/spec/01-architecture.md) | System context, components, core flows, package layout, conventions |
| [02 Frontend](docs/spec/02-frontend.md) | Custom element, Shadow DOM, Svelte integration, editing core, the three views |
| [03 Document model](docs/spec/03-document-model.md) | The Canonical Document Model (CDM): nodes, marks, styles, regions, layout semantics, evolution |
| [04 Sync engine](docs/spec/04-sync-engine.md) | Server-authoritative commit log, rebase, rejection, reconnect |
| [05 Protocol](docs/spec/05-protocol.md) | The Document Editing Protocol (DEP): socket messages, REST resources, webhooks, embedding API, backend tiers, conformance |
| [06 Backend](docs/spec/06-backend.md) | Services, rooms, storage schema, scaling stages, failure modes, cost, operations |
| [07 Permissions](docs/spec/07-permissions.md) | Roles, regions, grants, the outcome check, comments, history visibility, the authorisation matrix |
| [08 History](docs/spec/08-history.md) | Commit log as history, checkpoints, versions, comparison, attribution, restore, retention |
| [09 Export and LaTeX](docs/spec/09-export-latex.md) | Converter, tagging-first house class, typed emitters, math gate, compile service, pagination parity, DOCX |
| [10 Security](docs/spec/10-security.md) | Threat model and mitigations per component |
| [11 Roadmap](docs/spec/11-roadmap.md) | Decisions, spikes, phases, exit criteria, risk register |
| [12 Fields, rules and workflow](docs/spec/12-fields-rules-workflow.md) | Fillable fields, role placeholders, the `fill` permission, the rules language, workflow, signing, sealing, evidence |
| [13 Experience, extensibility and host integration](docs/spec/13-experience-extensibility.md) | The Microsoft 365 benchmark and parity profile, shell and commands, collaboration, proofing and assistant ports, extensions, governance, what a host must build |
| [Decision records](docs/adr/) | One file per architectural decision, with alternatives, revisit conditions, and what the first review changed |
| [Research summary](docs/research/2026-09-18-research-summary.md) | Findings and sources from the nine research tracks behind this spec |
| [Pitfall review](docs/review/2026-09-18-pitfall-review.md) | The first independent review: 91 pitfalls, their dispositions, and what remains open |

## Working names

These names are placeholders chosen so they are easy to find and replace.

| Thing | Working name |
|---|---|
| Custom element | `<doc-editor>` |
| Protocol | DEP, the Document Editing Protocol. WebSocket subprotocol `dep.v1`, discovery at `/.well-known/dep` |
| Document format | CDM, the Canonical Document Model. Major version field `cdm` |
| Sync engine identifier | `pm-steps/1` |
| DOM event prefix | `de-` |
| Webhook event prefix | `dep.` |
| LaTeX class and macro prefix | `docedit.cls`, `\DE` |
| npm scope | `@docedit/*` |

## Conventions used in the spec

- The words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as defined in RFC 2119 and only in the normative documents (03, 04, 05, 07, 12).
- Numbers given as limits are defaults that a deployment can change unless the text says otherwise. Numbers given as targets are goals to validate, not measured results.
- Every spec document ends with an "Open issues" section. Nothing in those sections is decided.

## Owner decisions on the assumptions

The project owner decided the four assumptions on 2026-11-06. A1, A3 and A4 were confirmed and A2 was reversed. Each is explained in [00 Overview](docs/spec/00-overview.md#5-assumptions-and-the-owners-decisions). The remaining owner decisions are in [11 Roadmap](docs/spec/11-roadmap.md#10-decisions-needed-from-the-project-owner).

| ID | Assumption |
|---|---|
| A1 | Offline-first editing is not required in version 1. Disconnections are tolerated, and unconfirmed work survives a closed tab. **Confirmed 2026-11-06.** |
| A2 | DOCX import and export are best-effort. Lossless Word round-trip is not required. **Reversed by the owner on 2026-11-06: lossless round-trip is required** ([ADR 0017](docs/adr/0017-lossless-docx-preservation-layer.md)). |
| A3 | Version 1 typesets with one house LaTeX class, not arbitrary customer templates. **Confirmed 2026-11-06.** |
| A4 | LaTeX is an export pipeline. The stored source of truth is the CDM document, not LaTeX source. **Confirmed 2026-11-06.** |

## Building and testing

You need Node.js 22.18 or later and pnpm 12.18 (`npm install -g pnpm@12.18.0`). The integration-test environment and the LaTeX worker run in containers with Podman, never Docker; set `DOCEDIT_CONTAINER_CLI` to use another command. The browser tests need Playwright's browsers (`pnpm exec playwright install chromium firefox webkit`).

| Command | What it does |
|---|---|
| `pnpm install` | Installs the workspace, once after cloning |
| `pnpm check` | Lint and formatting, type-check, architecture boundaries, Node.js tests and the build, in that order |
| `pnpm test` | Tests in Node.js (`src/**/*.test.ts`, `test/**/*.test.ts`) |
| `pnpm test:browsers` | `*.universal.test.ts` in Chromium, Firefox and WebKit; `DOCEDIT_BROWSERS=msedge` runs Edge |
| `pnpm generate` | Regenerates the machine-readable artifacts in `spec/` and the generated sources |
| `pnpm lint`, `pnpm format` | ESLint and Prettier, with the same configuration locally and in CI |
| `pnpm deps:check` | The architecture boundaries (`.dependency-cruiser.cjs`) |
| `pnpm licence:check`, `pnpm notices` | The licence gate and the third-party notices |
| `pnpm stories:check`, `pnpm trace` | Checks the backlog's format; writes the requirements traceability table |

The workspace has `packages/*` (universal and browser packages), `services/*` (Node.js services) and `apps/*` (hosts; none yet). `spec/` holds generated artifacts and is never edited by hand. Package layout and rules: [01 Architecture](docs/spec/01-architecture.md) §6 and [CLAUDE.md](CLAUDE.md).

## What is not here yet

- A second review pass over draft 0.2 is running (SPK-027). The changes made after the first review have not themselves been reviewed.
- Phases 1a to 4 of the backlog ([docs/stories/BACKLOG.md](docs/stories/BACKLOG.md)) are not built yet.
