# 00 Overview

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Informative, except the requirement identifiers, which other documents reference.

## 1. Purpose

Build a document editor that offers the same features as Microsoft 365's Word for the web and ships as a single web component that any web application can embed. The aim is the same capabilities, not an imitation of that product; the editor has its own design. Documents can carry fillable fields that are assigned to roles and governed by customizable rules, in the manner of e-signature products, and end as a sealed PDF. The editor's backend is a separate product reached only through a published protocol. Documents are typeset for final output by LaTeX. The aim is an all-round package: component, backend, reference host application, and the documentation and tools to integrate them.

## 2. Goals

- The editing features of a full word processor: a paginated view, a tabbed toolbar, named styles, multi-level numbering, tables, images, headers and footers, footnotes, a table of contents, comments and suggestions (tracked changes).
- One custom element, `<doc-editor>`, with its own open shadow root, usable from any framework or none.
- Server-enforced edit permissions on parts of a document, per user and per group.
- A complete, attributable history with versions, comparison and restore.
- High-quality PDF output from a LaTeX pipeline, with a preview inside the editor.
- A backend that any team can replace, because the only contract is the protocol and its conformance kit.
- A backend design that grows from one process to a sharded, multi-region deployment without changing the protocol or the storage model.

## 3. Non-goals for version 1

- Offline-first or peer-to-peer editing. The client tolerates disconnections and resubmits pending work, but a long offline session is not a supported workflow.
- Editing inside content the model cannot represent: text boxes, shapes, charts, SmartArt, embedded objects. Such content from an imported Word file is preserved and written back unchanged, and can be moved or deleted only as a whole ([ADR 0017](../adr/0017-lossless-docx-preservation-layer.md)).
- Arbitrary customer LaTeX templates, and any user-authored raw LaTeX other than math.
- End-to-end encryption. It is incompatible with a server that validates and typesets documents.
- Spreadsheets, presentations, drawing tools, mail merge, macros.
- Native advanced or qualified electronic signatures, identity verification, and sending e-mail or text messages. The platform provides a simple electronic signature with evidence and a sealed PDF, and integrates the rest (12, section 8.3).
- Parity with desktop Word. The feature benchmark is Word for the web, and 13, section 2, lists what is built in, what comes through extensions and what is a non-goal.
- Imitating Microsoft 365's look. The project wants the same features, with its own visual design, icons and names.
- Native mobile applications. Mobile browsers get viewing and light editing late in the roadmap.

## 4. Requirements

| ID | Requirement | Specified in |
|---|---|---|
| R1 | Word-like editing: paginated view, named styles, numbering, tables, images, headers and footers, footnotes, table of contents, fields for page numbers, find and replace, keyboard shortcuts that match Word where the browser allows | 02, 03 |
| R2 | Delivered as one custom element with an open shadow root; no styles leak in or out except through documented custom properties and parts; works with any host framework; built with Svelte 5 | 02 |
| R3 | Region permissions: an owner marks regions of a document and grants roles on them to users or groups; everything else follows the document-level role; the server rejects edits that violate grants; changes to grants take effect for connected users without a reload | 03, 04, 07 |
| R4 | History: every accepted change is recorded with user, session, server time and the regions it touched; users can list versions, name them, compare any two, see who wrote a passage, restore a whole document or one region, and see what changed since their last visit | 08 |
| R5 | Export: PDF typeset by LaTeX, a downloadable LaTeX bundle, and DOCX; Word files imported into the editor round-trip without loss (A2, ADR 0017); export runs as an asynchronous job with progress and diagnostics that point back to document locations | 09 |
| R6 | Loose coupling: the component reaches the backend only through DEP; the backend never requires the component's code; a conformance kit lets third parties certify their own backend; the component ships with a local backend and a mock backend that need no server | 05 |
| R7 | Collaboration: several people edit the same document at the same time with presence indicators; all clients converge to the same document | 04 |
| R8 | Comments and suggestions: threaded comments anchored to ranges; a suggestion mode whose changes an editor accepts or rejects; both respect region permissions | 03, 07 |
| R9 | Scale: the design supports the three stages in section 9 without protocol or storage redesign | 06 |
| R10 | Security and tenancy: tenant isolation, short-lived scoped credentials, sandboxed typesetting, sanitised imports and pastes, an audit trail | 10 |
| R11 | Accessibility: the user interface targets WCAG 2.2 level AA; the editing surface is operable with a keyboard and a screen reader; exported PDFs can be tagged for accessibility | 02, 09 |
| R12 | Browser support: current desktop Chrome, Edge, Firefox and Safari, with the minimum versions in 02 | 02 |
| R13 | Fields, rules and workflow: typed fillable fields assigned to role placeholders; a `fill` permission that lets a person change only the values of their own fields; declarative rules for required, visible, enabled, validated and computed fields; a workflow that freezes the body, binds people to roles, orders them and tracks completion; a signing ceremony with evidence; a sealed final PDF with a certificate of completion | 12 |
| R14 | Feature parity: the commands, keyboard model, collaboration features, proofing and assistant ports, and extension model that give the editor the same features as Word for the web, measured capability by capability against a published parity profile. Parity is about what a user can do, not about how the product looks | 13 |
| R15 | All-round package: a reference host application, a host integration guide, administration and governance interfaces, a recovery journal so that a closed tab does not lose work | 13 |

## 5. Assumptions and the owner's decisions

These four choices were proposed on 2026-09-18. The project owner decided them on 2026-11-06:

| ID | Decision |
|---|---|
| A1 | Confirmed: offline-first editing is not required ([ADR 0001](../adr/0001-server-authoritative-sync.md) accepted) |
| A2 | Reversed: lossless round-trip of Word files **is** required. The model gains a preservation layer ([ADR 0017](../adr/0017-lossless-docx-preservation-layer.md)) |
| A3 | Confirmed: one house LaTeX class ([ADR 0007](../adr/0007-latex-export-pipeline.md) accepted) |
| A4 | Confirmed: LaTeX is an export pipeline, and the CDM document is the stored source of truth |

The text below is the original analysis, kept for its reasoning. Under A2 it now describes the alternative that was not chosen.

They are not independent. The export design (ADR 0007) rests on A3 and A4, and the document model (ADR 0004) rests on A2 and A4. A1 and A4 are one-way doors: reversing either after phase 1 means rewriting the sync engine, permissions and history, or the document model. The spikes of phase 0 produce no evidence about them, so they should be decided before phase 1 starts. A2 should be decided at the same time, because it sets the scope of the document model.

**A1. Offline-first editing is not required.**
The sync engine makes the server the authority on every edit (see [ADR 0001](../adr/0001-server-authoritative-sync.md)). What the design does offer is tolerance of disconnection: unconfirmed work is kept in a journal in the browser, survives a closed tab, and is resubmitted on return (13, section 9). If true offline-first editing becomes a hard requirement, the engine would have to become a CRDT, and the log, history, restore, comparison, attribution and the suggestion and fill rules would all have to be replaced. That is a rewrite, not a fallback.

**A2. DOCX is best-effort** (reversed on 2026-11-06).
The document model is built from Word's concepts but does not mirror the DOCX package (see [ADR 0004](../adr/0004-semantic-document-model.md)). If lossless round-trip is required, the model must retain the original package parts and unknown XML, and the layout engine must chase Word's layout behaviour. That adds a very large amount of work.

The owner decided that lossless round-trip is required. [ADR 0017](../adr/0017-lossless-docx-preservation-layer.md) keeps the original package and unknown XML through a preservation layer, and leaves the model semantic. Whether the page view must also reproduce Word's pagination for imported documents is added to the page-view gate (11 §5), because the PDF is still typeset by the house class.

**A3. One house LaTeX class.**
Controlling the class makes it possible to reconcile on-screen page breaks with the typeset result (see 09, section 7). With arbitrary templates, on-screen pages can only ever be approximate.

**A4. LaTeX is an export pipeline.**
The CDM document is the source of truth and LaTeX is generated from it. Storing LaTeX as the truth would limit the editor to what a visual layer over LaTeX source can express.

## 6. Actors

| Actor | Description |
|---|---|
| End user | A person using the editor inside a host application |
| Host page | The web page that embeds `<doc-editor>` |
| Host backend | The embedding application's server. It authenticates users, decides document-level roles and mints tokens |
| Document service | The backend specified here: gateway, rooms, control API, export service and workers |
| Tenant | An organisation whose data is isolated from other organisations |
| Operator | Whoever runs the document service: the vendor in hosted mode, the customer in self-hosted mode |

## 7. Glossary

| Term | Meaning |
|---|---|
| Authority | The component that validates, orders and applies commits for one document. There is exactly one per open document |
| Base | The sequence number a client's commit was made against |
| Body root | The part of the document body that is outside every region |
| Capability | One permitted kind of action: view, comment, suggest, edit, fill, structure, manage (07, section 1) |
| CDM | Canonical Document Model, the versioned JSON document format defined in 03 |
| Checkpoint | A full copy of a document at one sequence number, stored in object storage |
| Commit | The unit of the ordered log: one to many steps submitted together by one client and accepted or rejected as a whole. A control commit records a change of permission or workflow state and has no steps; a snapshot commit replaces the document with a checkpoint (04, section 3) |
| Incarnation | The identity of a document's log. It changes only if the log is ever rewound |
| Control plane | The REST part of DEP: documents, grants, history, comments, assets, exports |
| DEP | Document Editing Protocol, defined in 05 |
| Engine | The algorithm used on a sync channel. Version 1 defines `pm-steps/1` |
| Field | A typed blank in a document with a key and a value, assigned to a role placeholder (12) |
| Grant | A record giving a principal a role on a region. Document-level roles come from the host's token |
| Head | The sequence number of the latest accepted commit |
| Host | See host page and host backend in section 6 |
| Input bridge | A visually hidden editable element that receives keyboard and input-method events in the paginated view |
| Layout tree | The output of the layout engine: pages, fragments and lines with document offsets |
| Named version | A user-labelled pointer to a sequence number |
| Page section | A run of pages that share one page setup. It starts at a `section_break` node. This is what Word calls a section |
| Painter | The component that turns a layout tree into DOM inside the shadow root |
| Participant | A person bound to one or more role placeholders for one workflow (12) |
| Principal | What can hold a grant: a user, a group, everyone, or a role placeholder |
| Region | A block container in the document body with a stable identifier. It is the unit of edit permission. The word "section" is avoided for this concept |
| Role placeholder | A named role defined in a document, such as "Tenant". Fields and regions are assigned to role placeholders, and a workflow binds people to them |
| Room | The server process state that owns one open document and hosts its authority |
| Scope | The permission context of a position: the top level of the tree, the body root, a region, the definitions, a header or footer story, or the value of a form field (07, section 1) |
| Seq | Sequence number of a commit. It doubles as the document version |
| Step | One atomic document change in the `pm-steps/1` engine, using ProseMirror's step semantics |
| Story | A separate flow of content outside the body: a header or a footer |
| Workflow | The resource that freezes a document's body, binds people to role placeholders, orders them and tracks completion, ending in a sealed PDF (12) |

## 8. Prior art and positioning

Paginated, Word-style web editors exist. As of 2026-09-18 the research found SuperDoc and ONLYOFFICE (both AGPL), Syncfusion, Nutrient, Apryse and DevExpress (proprietary), and Eigenpal (an open core whose review and collaboration features are paid). None of them combines a permissive licence, delivery as a web component with Shadow DOM, per-user region permissions enforced by a server, attributable history and LaTeX output. That combination is this project's position.

Every product verified to have true pagination runs its own line-breaking and page-layout engine. Teams that built one took years. The roadmap is therefore arranged so that every hard requirement is proven end to end before the layout engine is started. Details and sources are in the [research summary](../research/2026-09-18-research-summary.md).

## 9. Quality targets

All figures here are targets to validate.

| Attribute | Target |
|---|---|
| Typing latency | Keystroke to paint within 16 ms at the median and 50 ms at the 95th percentile, for documents up to 100 pages on a mid-range laptop |
| Commit acknowledgement | Median 50 ms and 99th percentile 300 ms within one region of the world |
| Cold open of a room | 95th percentile 500 ms for a document whose CDM is under 1 MB |
| Export | A 20-page document reaches a preview PDF (one pass) within 10 seconds at the 95th percentile when the queue is empty. The final PDF (every pass until the page references settle) has its own, longer target, set from measurements on the reference machine (owner decision 235, 2026-11-26) |
| Availability | 99.9 percent monthly for editing in hosted mode |
| Durability | No acknowledged commit is lost while the primary database survives, because a commit is acknowledged only after it is stored. In hosted mode the log is replicated synchronously, giving a recovery point of zero for a single failure; self-hosted deployments state their own recovery point, and a log that is ever rewound gets a new incarnation that forces clients to reload (04, section 9) |
| Recovery time | Editing restored within 15 minutes of losing a node or a database primary in hosted mode |
| Initial bundle, time to interactive, memory, long documents | 13, section 9 |
| Typing latency measurement | The Event Timing API on a named reference machine with CPU throttling, not an unspecified laptop |
| Scale stage 1 | One node: about 2,000 connections and 500 open documents |
| Scale stage 2 | About 10,000 open documents and 50,000 connections |
| Scale stage 3 | More than a million stored documents and more than 100,000 connections, in several regions |

## 10. Open issues

- Project name, element name and protocol name are undecided. The licence is Apache-2.0, decided by the owner on 2026-11-06 for its patent grant (SPK-007). The legal note on the project's name, the licences inside the TeX Live image, fonts and e-signature claims is written ([legal note](../research/2026-11-06-legal-note.md)); counsel still reviews the signing claims before launch.
- Read restrictions per region (confidential sections) and per field value were a non-goal; the owner made them a version 1 requirement on 2026-11-06 (SPK-005). They affect content loading, sync, history, search and export. The proposed design is [ADR 0019](../adr/0019-read-restrictions-by-projection.md), tested by spike S12 (SPK-029).
- The first market was decided on 2026-11-06: the first release serves all three candidate markets (agreements and forms, controlled documents, academic and technical writing), so citations and a bibliography are in CDM 1 (03, section 13; SPK-006).
