# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

No code exists yet. The stack comes from the owner's requirements and from the decision records in `docs/adr/`.

- **Owner requirements:** Svelte 5; one framework-agnostic custom element with its own open shadow root; the component reaches its backend only through a written, versioned protocol, so the backend can be replaced or re-implemented in another language.
- **Decided by the owner on 2026-11-06:**
  - a server-authoritative commit log with no offline-first editing (A1; ADR 0001 accepted);
  - one house LaTeX class, and LaTeX as an export pipeline with the CDM document as the stored source of truth (A3, A4; ADR 0007 accepted);
  - lossless round-trip of Word files (A2 reversed; ADR 0004 revised; the preservation layer of ADR 0017 is proposed).
- **Proposed, not yet confirmed** (the other ADRs have status "proposed"): a hand-written `HTMLElement` class that mounts Svelte with `mount()`; ProseMirror's model, transform and state as the editing core behind the project's own document API; a Vite library-mode ES module with lazy chunks; a SvelteKit reference host; a Node.js reference service; PostgreSQL plus object storage; sandboxed LuaLaTeX export workers.

## Users

**Primary: authors and owners.** People who write, structure and revise documents inside a host application, often for hours and alongside collaborators, and who decide what happens to a document: they mark regions and grant roles on them, add fields and rules, and send documents out for completion. When design trade-offs in the editor conflict, their experience wins (confirmed by the owner, 2026-11-06).

The editor also serves:

- **Collaborators with narrower rights:** editors, suggesters, commenters and viewers, for a whole document or for one region.
- **Fill and sign participants:** often outside the host's user base. They open one document in fill mode, see a read-only body with a guided bar (next required field, "n of m", finish), change only the fields assigned to their role, and sign.
- **Integrating developers:** teams that embed `<doc-editor>`, theme it, mint its tokens, receive its webhooks, and build the catalogue, sharing and notifications around it.
- **Operators and tenant administrators:** whoever runs the document service (the vendor when hosted, the customer when self-hosted), through the administration API. A console comes later.

The first release serves all three candidate markets: agreements and forms, controlled documents, and academic and technical writing (decided by the owner on 2026-11-06). Citations, cross-references, deep numbering, review and signing are therefore all first-release capabilities.

## Product Purpose

A document editor with the same capabilities as Word for the web, delivered as one web component that any web application can embed. Documents can carry fillable fields assigned to roles and governed by rules, in the manner of e-signature products, and end as a sealed PDF with evidence of who did what.

It is an all-round package: the component, a backend reached only through a published protocol (DEP) with a conformance kit, a reference host application, an integration guide, and administration interfaces.

Success means four things hold at once: owners can let specific people change only specific parts of a document, and the server enforces it; every accepted change is attributable and the history is tamper-evident; final output is typeset by LaTeX; and the backend grows from one node to very large deployments without a redesign. Requirements R1 to R15 are in `docs/spec/00-overview.md`.

## Positioning

Paginated, Word-style web editors already exist: SuperDoc and ONLYOFFICE (AGPL); Syncfusion, Nutrient, Apryse and DevExpress (proprietary); Eigenpal (open core with paid review and collaboration). As of the 2026-09-18 research, none combines all of:

- a permissive licence;
- delivery as one web component in its own Shadow DOM;
- edit rights per region and per field, enforced by the server;
- tamper-evident, attributable history;
- LaTeX-typeset PDF output;
- a published protocol any team can re-implement.

That combination is the position. Pagination is not a differentiator, because every competitor already has it.

## Operating Context

- The editor always lives inside someone else's application. The host authenticates people, decides their document-level role, mints short-lived tokens, and owns the document catalogue, whole-document sharing and notifications. The editor never lists documents; its share button asks the host to show its own dialog.
- Modes: `edit`, `review` (suggestions on), `view`, `fill`. Views: `web` (a continuous, reflowing layout; permanent, and the accessible and touch layout), `read` (real pages, read-only; first as the typeset PDF), `print` (editable pages; phase 3, only if phase 2 evidence supports it).
- Collaboration is live: presence at carets and in the header, threaded comments with mentions and assigned tasks, suggestions that an editor accepts or rejects, catch-up on what changed since the last visit, and version history with comparison and restore of a document or one region.
- Workflows: an owner freezes the body, binds people to role placeholders, orders them, and tracks completion. Participants consent, fill and sign. Completion produces a sealed PDF with a certificate of completion.
- Export runs as an asynchronous job with progress and diagnostics that point back to document locations: PDF typeset by LaTeX, a LaTeX bundle, DOCX, and later HTML and Markdown. A Word file imported into the editor round-trips without loss: unedited content and unknown XML are written back unchanged, and content the model cannot represent is preserved and shown with a fallback (ADR 0017).
- The reference host (SvelteKit plus a compose file) covers token minting, a document list, sharing, webhooks to e-mail, a template gallery and "send for completion". It is the demo harness from phase 1 and the starting point for adopters.
- Delivery is phased: 1a minimum demo; 1b first usable release; 2 review, history and workflow; 3 pages, gated on evidence; 4 scale and reach (`docs/spec/11-roadmap.md`).

## Capabilities and Constraints

- **Benchmark:** Word for the web, not desktop Word. The parity profile in `docs/spec/13-experience-extensibility.md` section 2 sorts every capability into built in, through ports and extensions, or non-goal, and is the contract against scope creep. Parity is judged by what a user can do, never by how a screen looks.
- **Shell inventory** (13, section 3): a header (title slot, save state, mode switcher, presence, comments, catch-up, share) that a host can hide and replace; a toolbar of commands grouped by task, with contextual groups, in a compact and a full layout; panes for navigation, styles, comments, review, history, permissions, fields, the accessibility checker, the assistant, PDF preview and recovered edits; a status bar with counts, language, classification label, connection and save state, and zoom.
- **One command registry** drives both toolbar layouts, context menus, the mini toolbar, command search, access keys, the embedding API and extensions, and respects the current permissions. Shortcuts follow word-processor conventions where a browser allows.
- **Permissions:** capabilities `view`, `comment`, `suggest`, `edit`, `fill`, `structure`, `manage`; roles viewer, commenter, suggester, filler, editor, owner. Version 1 restricts who may change a part of a document and, since 2026-11-06, can also hide confidential regions and sensitive field values from some readers (ADR 0019). Grant changes reach connected people without a reload.
- **Fields:** typed blanks assigned to role placeholders, never to people. Rules show, hide, require, enable, validate or compute fields.
- **Assistance:** spelling, grammar and AI assistance arrive through ports, not built-in services. An assistant's writes arrive as suggestions, and history always distinguishes what a person wrote from what a model wrote for them.
- **White-label:** hosts restyle the component only through `--de-` custom properties and the parts `header`, `toolbar`, `ruler`, `page`, `sidebar`, `statusbar` and `dialog`, and can replace icons and strings. Nothing else crosses the shadow boundary. Dark and high-contrast themes are built in; dark mode can include the page canvas.
- **Localisation:** every interface string is external, and the layout uses logical CSS properties so a right-to-left interface needs no rework.
- **Browsers:** desktop Chrome and Edge 137+, Firefox 142+, Safari 17+. Mobile browsers get viewing first and light editing in the web view later. No native apps.
- **Budgets** (targets, not measurements): keystroke to paint in 16 ms at the median and 50 ms at the 95th percentile for documents up to 100 pages; at most 300 KB compressed for the first interactive editor, with panes, the PDF viewer, the math editor, proofing and the assistant loaded on demand; interactive in under 2 seconds for a 20-page document.
- **Fonts:** only fonts whose licences allow bundling and server use (for example Noto Serif, Noto Sans, Noto Sans Mono, STIX Two). The editor and the LaTeX workers load the same files.
- **Non-goals for version 1:** offline-first editing; arbitrary customer LaTeX templates; end-to-end encryption; spreadsheets, presentations, drawing, and creating or editing SmartArt, charts and shapes (those in imported Word files are preserved, not edited); mail merge and macros; native advanced or qualified signatures, identity verification, and sending e-mail or text messages; parity with desktop Word; Microsoft 365's look.
- **Decided by the owner on 2026-11-06:**
  - Read restrictions: some regions and field values can be hidden from some people who can open the document (SPK-005; design proposed in ADR 0019, tested by spike S12).
  - Both the hosted service and the self-hosted distribution are designed for, neither first (SPK-008). Fields are fixed-width (SPK-012). Working names stay until renamed before publishing (SPK-007).
  - A1: no offline-first editing.
  - A2: lossless DOCX round-trip is required, and the lossless DOCX writer ships in phase 2 with import (ADR 0017).
  - A3: one house LaTeX class. A4: LaTeX is an export pipeline only.
  - The first release serves all three candidate markets (agreements and forms, controlled documents, academic and technical writing), so citations and a bibliography are in CDM 1.
  - The project licence is Apache-2.0.
  - The host alone invites and authenticates workflow participants.
- **Decided by the owner on 2026-11-15** (`docs/owner-decisions-2026-11-15.md`):
  - The production backend is written in Rust or C#, and Rust is preferred if nothing blocks it (SPK-009). The Node.js service stays as the reference service. A backend in another language reaches the authority, the rules and the model through the authority service (05, section 10), so ADR 0016 stands: the authority, the rules and the model stay in TypeScript whatever the backend language.
- **Undecided** (`docs/spec/11-roadmap.md` section 10): the project's names; whether the page view must reproduce Word's pagination for imported documents (at the page-view gate); jurisdictions and the sealing party; whether the first customers need the editable page view.

## Brand Commitments

- Every name is a working placeholder, chosen to be easy to find and replace: `<doc-editor>`, DEP, CDM, `@docedit/*`, the `de-` event prefix, the `--de-` property prefix, `docedit.cls`. The project name is undecided.
- The product has its own visual design, icons, fonts, layout of controls and names. Nothing of Microsoft 365's design is used, and Microsoft product or feature names are never used as the product's own. Marketing may say "compatible with" a Microsoft format.
- No visual identity exists yet: no logo, palette, typography or icon set. The spec leaves visual and interaction design to a designer (13, section 13).
- Signature language never says "qualified", "legally binding everywhere" or similar. The platform provides a simple electronic signature with evidence and a tamper-evident seal; whether a use is valid in a jurisdiction is a question for the operator and its customers (12, section 8.3).

## Evidence on Hand

- Specification draft 0.2, 2026-09-18: `docs/spec/00-overview.md` to `docs/spec/13-experience-extensibility.md`.
- Decision records: `docs/adr/0001` to `docs/adr/0017`. 0001 and 0007 were accepted on 2026-11-06, 0004 was revised that day, and the rest are proposed.
- Story backlog: `docs/stories`, a first draft of 2026-11-06, not yet reviewed by the owner.
- Research: `docs/research/2026-09-18-research-summary.md`, nine tracks with sources, including the competitor findings above.
- First independent review: `docs/review/2026-09-18-pitfall-review.md`, 91 pitfalls and their dispositions. Draft 0.2 has not had a second review.
- Absent, and never to be fabricated: source code, a running editor or screenshots, users, customers, testimonials, case studies, adoption figures, measured performance (every number in the spec is a target), a project name or logo, and a legal review of signing claims.

## Product Principles

1. **Capabilities, not imitation.** Parity with Word for the web is measured by what a person can do. The look, icons, layout and names are the product's own.
2. **Rights are enforced, not advisory.** The server is the authority on every change. People see what they may change before they try, and a rejected change is explained, never silently dropped.
3. **No fake pages.** The web layout reflows and never pretends to show pages. Real pages come from the typeset PDF and the read view.
4. **Work is never lost.** Save state is always visible (saved, saving, unsaved, read-only), and unconfirmed work survives a closed tab through the recovery journal.
5. **The host owns people; the editor owns the document.** Identity, catalogue, sharing and notifications belong to the host. Editing, rights on parts of a document, fields, history and output belong to the editor.

## Accessibility & Inclusion

- The interface targets WCAG 2.2 level AA, and authoring targets ATAG 2.0: the editor must be accessible and must help authors produce accessible documents. Each release ships an accessibility conformance report.
- Everything works from the keyboard with visible focus. Because Tab means indent, next cell or next field inside the editor, there are documented ways out: Escape leaves the editing surface, and Ctrl+F6 cycles the header, toolbar, page, panes and status bar.
- Every drag (rulers, table and image resizing, moving blocks) has a dialog or keyboard alternative; controls meet the target-size criterion; focus is never hidden behind sticky bars.
- The web view is the reflow layout for people who zoom.
- Live regions announce saving, rejected edits, and collaborators arriving and leaving.
- Never colour alone: roles carry a colour plus an icon, and fields of other roles are labelled with the role name.
- Signing never requires drawing: the typed signature is the default, the ceremony works from the keyboard, and one-time passcode fields accept paste.
- Defined behaviour under `forced-colors`, using system colours for the custom caret and selection too.
- An accessibility checker prompts for alternative text, heading order, table headers, link text and contrast, which feeds tagged, accessible PDF export.
