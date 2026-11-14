# Stories

**Status:** first draft, 2026-11-06, written from specification draft 0.2 (docs/spec 00 to 13) and the decision records 0001 to 0016, then cross-checked (section 5). Not yet reviewed by the project owner. Like the spec, every number in a story is a target to validate, not a measurement.

This folder turns the specification into a backlog. Each epic file holds the stories for one area of the spec. The phase of every story follows [11 Roadmap](../spec/11-roadmap.md), which is the source of truth for sequencing.

## 1. Epics

| Prefix | Epic | Source | File |
|---|---|---|---|
| FND | Foundations: repository, toolchain, conventions, CI, performance harness, release | 00, 01, 13 §9 | [FND-foundations.md](FND-foundations.md) |
| SPK | Phase 0: owner decisions, spikes S1 to S10, notes | 11, ADR 0016 | [SPK-phase0.md](SPK-phase0.md) |
| FE | Element, Shadow DOM, Svelte integration, editing core, views, layout engine | 02 | [FE-frontend.md](FE-frontend.md) |
| CDM | Canonical Document Model | 03 | [CDM-document-model.md](CDM-document-model.md) |
| SYN | Sync engine `pm-steps/1` and the authority package | 04 | [SYN-sync-engine.md](SYN-sync-engine.md) |
| PRO | Protocol DEP/1, embedding API, backend ports, authority service, conformance kit | 05 | [PRO-protocol.md](PRO-protocol.md) |
| BE | Document service: gateway, rooms, storage, scaling, operations | 06 | [BE-backend.md](BE-backend.md) |
| PRM | Permissions: roles, regions, grants, outcome check, leases, region states | 07 | [PRM-permissions.md](PRM-permissions.md) |
| HIS | History: versions, comparison, attribution, restore, retention, tamper evidence | 08 | [HIS-history.md](HIS-history.md) |
| EXP | Export and LaTeX, DOCX import and export | 09 | [EXP-export.md](EXP-export.md) |
| SEC | Security: threat-model coverage, security testing, supply chain, privacy, tenancy | 10 | [SEC-security.md](SEC-security.md) |
| FRW | Fields, rules, workflow, signing, sealing, evidence | 12 | [FRW-fields-rules-workflow.md](FRW-fields-rules-workflow.md) |
| UX | Shell, commands, collaboration experience, assistance ports, extensions, governance, host integration, reference host | 13 | [UX-experience.md](UX-experience.md) |
| WASM | Rust compiled to WebAssembly for compute kernels | [ADR 0016](../adr/0016-rust-wasm-compute-kernels.md), [assessment](../research/2026-11-06-rust-wasm-assessment.md) | [WASM-rust-kernels.md](WASM-rust-kernels.md) |

## 2. Story format

Every story is a level-3 heading with a fixed set of fields, so the files can be read by people and imported by a script.

```markdown
### FE-012 Short imperative title

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 02 §5.2; ADR 0003 · **Requirements:** R1, R7 · **Depends on:** FE-003, CDM-004

As an author, I want <capability>, so that <outcome>.

**Acceptance criteria**

- [ ] Given <context>, when <action>, then <observable result>.
- [ ] ...

**Notes:** pitfall references, inferred phase, open questions. Optional.
```

### 2.1 Fields

| Field | Values |
|---|---|
| Type | `story` (user-visible capability), `enabler` (technical work another story needs), `spike` (time-boxed investigation that ends in a written recommendation), `decision` (an owner decision the backlog waits on) |
| Phase | `0`, `1a`, `1b`, `2`, `3` (gated on the evidence review at the end of phase 2), `4`, or `cond` (only if an owner decision or spike goes a certain way; the Notes say which) |
| Size | `S`, `M`, `L`. Relative, roughly doubling at each step. L is the largest a story may be: split anything bigger. Spikes and decisions may be sized by their time box |
| Priority | `must`, `should`, `could`, within its phase |
| Persona | Author, Owner, Editor, Suggester, Commenter, Viewer, Participant, Relying party, Integrating developer, Operator, Tenant administrator, Maintainer, Project owner. The primary persona is the author and owner (PRODUCT.md); Maintainer is for enablers; Project owner is the person who decides for the project, used for decision stories |

### 2.2 Writing rules

1. **Trace everything.** Each story cites the spec sections and decision records it comes from. Every MUST and MUST NOT in the normative documents (03, 04, 05, 07, 12) is covered by at least one acceptance criterion.
2. **Do not invent scope.** If the spec leaves something open (an "Open issues" item, an owner decision, a spike), write a `spike` or `decision` story or put it in Notes. Never decide it inside an acceptance criterion.
3. **Testable acceptance criteria.** Given, when, then, with an observable result. Three to eight per story. Numbers come from the spec and are called targets.
4. **Capabilities, not imitation.** Word for the web is a feature checklist (13 §2). Stories describe what a person can do; they never prescribe Microsoft's look, layout or names.
5. **Language.** Plain English with the spec's British spelling (authorisation, behaviour, colour). Working names stay as they are: `<doc-editor>`, DEP, CDM, `pm-steps/1`, `@docedit/*`.
6. **Cross-epic dependencies.** Use the other epic's story identifier. While a draft is in progress, a reference may be written as `[CDM: ProseMirror schema generated from the CDM (03 §4)]` and is resolved to an identifier before the draft is marked done.
7. **Pitfalls.** Where the first review (docs/review) changed the spec, the change appears as an acceptance criterion, and the Notes cite the review section.
8. **Read restrictions.** Since 2026-11-06 a reader may not see the whole document (SPK-005; ADR 0019). A story that sends content, steps, positions, history, search results, exports, comments, presence, field values or attribution serves the requester's projection, even where its text predates the decision. The S12 report (`docs/spikes/2026-11-06-s12-read-restrictions.md`, "Stories to add or change") lists the stories this changes and how; whoever builds one of them applies the change and updates the story's text.

### 2.3 Ownership of cross-cutting topics

A topic described in several spec documents is split by angle. The owner writes the core stories; the other epics write only their own angle and reference the owner.

| Topic | Owner | Other angles |
|---|---|---|
| Embedding contract: attributes, properties, methods, events (05 §8.1, §8.2) | PRO | FE: element internals (lifecycle, shadow root, Svelte mount) |
| Backend ports, local backend, mock backend (05 §8.3) | PRO | |
| Authority package: rebase, apply, invariants, range mapping | SYN | PRM: outcome check; FRW: fill rules |
| Outcome check (07 §5) | PRM | SYN: where the authority calls it |
| Comments (ADR 0015) | SYN: range mapping in the authority | PRO: resources and messages; PRM: who may comment; FE: decorations; UX: threads, mentions, tasks |
| Suggestions | FE: suggestion mode | CDM: marks; PRM: `suggest` enforcement; UX: review tools; HIS: relation to history; EXP: output |
| Read restrictions (ADR 0019) | SYN: projections and sync per visibility class (SYN-050 to SYN-053); PRM: hidden sets and confidential regions (PRM-066, PRM-067) | CDM-053; PRO-130, PRO-131; BE-098; HIS-046; EXP-123; FRW-088, FRW-089; FE-141; UX-104; SEC-064 |
| Field nodes and values (12 §3) | FRW | CDM: reserved nodes only |
| Presence | SYN: engine | PRO: messages; UX: presence in the header and at carets |
| Recovery journal (02 §2.2) | FE | UX: save-state indicator and recovered-edits pane |
| Fonts | FE: registry and aliases | BE: manifest and assets; EXP: LaTeX side |
| Math | EXP: math gate and LaTeX | FE: display and editing |
| Layout engine, painter, page view (02 §9) | FE, written against injected interfaces | WASM: Rust kernels behind those interfaces |
| Performance harness and budgets | FND: harness and CI gates | every epic: budget criteria for its own work |
| Webhooks | PRO: contract and signatures | BE: dispatcher |
| Authority service, conformance kit (05 §10, §11) | PRO | BE: deployment |
| Security controls | the component's own epic | SEC: threat-model coverage, testing, supply chain, privacy, tenancy verification |
| Leases and region states (07 §10, §11) | PRM | UX: governance and administration interfaces (13 §10) |
| History panel and history service | HIS | |
| Permissions behaviour in the editor (07 §7) | PRM | |
| Fill mode in the editor (12 §11) | FRW | |
| Accessibility | FE: editing surface | UX: shell and checker; EXP: tagged PDF |
| DOCX import and export | EXP | |
| Reference host (13 §11.2) | UX | |

## 3. Definition of done

A story is done when, in addition to its own acceptance criteria:

- unit tests run in Node.js without a browser where the code allows it, and Playwright covers user-visible behaviour in the supported browsers (02 §12);
- protocol or schema changes are reflected in the machine-readable artifacts in `spec/` and in the conformance kit;
- the performance budgets that apply (13 §9) still pass in CI;
- new interface strings are external, controls are keyboard operable with visible focus, and axe reports no new violations;
- changes to the authority, permissions, rules, export sandbox or signing have had a security review;
- documentation for integrating developers is updated where the embedding contract, DEP or the administration API changed.

## 4. Backlog by phase

The full list, phase by phase with links to every story, is [BACKLOG.md](BACKLOG.md). It is generated from the epic files by `tools/build-backlog.ps1` (PowerShell 7); regenerate it when a story's fields change, and run `tools/check-stories.ps1` and `tools/check-dependencies.ps1` after editing stories. Counts on 2026-11-06, after the owner's decisions:

| Epic | 0 | 1a | 1b | 2 | 3 | 4 | cond | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| FND | 4 | 7 | 3 |  |  |  |  | 14 |
| SPK | 26 |  |  | 1 |  |  | 1 | 28 |
| CDM | 9 | 5 | 35 | 2 |  |  |  | 51 |
| SYN |  | 20 | 19 | 2 |  | 3 | 1 | 45 |
| PRM | 1 | 12 | 24 | 24 |  |  |  | 61 |
| PRO | 5 | 38 | 40 | 29 |  | 13 | 4 | 129 |
| BE |  | 22 | 33 | 16 |  | 11 | 14 | 96 |
| SEC |  | 16 | 24 | 17 |  | 2 | 3 | 62 |
| FE |  | 26 | 61 | 15 | 30 | 3 | 1 | 136 |
| UX |  | 13 | 26 | 47 | 1 | 9 | 1 | 97 |
| HIS |  | 3 | 4 | 35 |  | 2 |  | 44 |
| EXP |  | 2 | 68 | 31 | 3 | 13 | 1 | 118 |
| FRW | 1 |  | 26 | 49 | 1 | 5 | 1 | 83 |
| WASM |  |  |  |  |  |  | 16 | 16 |
| **All** | 46 | 164 | 363 | 268 | 35 | 61 | 43 | **980** |

By type: 536 stories, 368 enablers, 43 decisions, 33 spikes.

Eight stories were added on 2026-11-06 after the owner decided assumptions A1 to A4 and reversed A2 (lossless DOCX round-trip): SPK-028, CDM-051, EXP-116 to EXP-120 and FE-139. The decision stories SPK-001 to SPK-004 are done; their criteria are ticked and each records its outcome.

**Phase 1a is too big.** Roadmap principle 2 says the first phase must be small enough for one person to finish, and 11 §3 describes a minimum demo. The drafts place 164 stories in phase 1a (30 of size L, 101 of size M), almost all of them `must`. Many are slices of the demo's real needs, especially protocol messages and authority steps, but the set needs a trim pass against 11 §3 before phase 1a is planned.

## 5. Status of the drafts

All fourteen epics are drafted and were cross-checked on 2026-11-06. The project owner has not reviewed them.

The cross-check, recorded in [the findings note](../review/2026-11-06-story-writing-findings.md):

- resolved 383 cross-epic placeholders to story identifiers; five point at work the specification does not yet cover and are marked "gap";
- added 14 stories no epic owned: the authoring commands FE-127 to FE-138, the export dialog UX-101 and the rulers UX-102;
- merged 25 duplicate stories into their owners and narrowed 12 overlapping groups. A merged story leaves a one-line pointer (`> FE-074 … was merged into SPK-013`), so its identifier is never reused;
- removed every dependency on a later phase and every dependency cycle, which moved four stories between phases.

Checks that pass on every epic file: the fields of section 2.1 have valid values; every story has 3 to 8 acceptance criteria; every identifier in a **Depends on** line exists; no story depends on a story in a later phase; the dependency graph has no cycle.
