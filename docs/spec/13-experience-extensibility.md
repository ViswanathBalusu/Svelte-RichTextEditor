# 13 Experience, extensibility and host integration

**Status:** draft 0.2, 2026-09-18. Informative. Added after the first review, in response to the product expectation that the editor should offer the same features as Microsoft 365 and be an all-round package. Revised after the owner clarified that the goal is the same features, not an imitation of that product.

## 1. Benchmark and stance

**Features, not imitation.** Microsoft 365 is a checklist of capabilities for this project, not a design to copy. Parity is judged by what a user can do (can they assign a task in a comment, find a command by typing, compare two versions), never by how a screen looks. The product has its own visual design, icons, fonts, layout and names, and nothing in this document prescribes Microsoft's arrangement of controls. Because nothing of Microsoft's design is used, the look-alike concern raised during the first review does not arise. What remains is ordinary trademark care: marketing may say "compatible with" a Microsoft format, and does not use Microsoft product or feature names as its own.

The feature yardstick is Word for the web, not desktop Word. Microsoft's own service description says Word for the web has no offline mode, cannot author captions, citations, content controls, watermarks or mail merge, prints through a generated PDF, and opens restricted-editing files read-only. This spec already goes beyond it in region permissions, attributable history with restore, fillable fields with rules, and typeset output.

Beyond the page itself, the features Microsoft 365 users rely on are these: a complete, keyboard-accessible command surface with a compact and a full layout; finding a command by typing; switching between editing, reviewing and viewing; seeing who else is in the document; comments with mentions and assigned tasks; catching up on what changed; sharing; proofing; an assistant; dark mode; and add-ins. Those capabilities are what this document specifies. How they are arranged and drawn is this product's own design work.

## 2. Parity profile

Every feature is in one of three tiers. The table is the contract against scope creep.

| Tier | Features |
|---|---|
| Built in | A tabbed toolbar with compact and full layouts, command search, access keys, context menu, format painter, mini toolbar, styles gallery and pane, navigation pane (headings, search results, page thumbnails once pages exist), rulers, zoom, status bar, modes (edit, review, view, fill), dark and high-contrast themes, fonts and paragraph formatting, multilevel lists, tables with styles and sorting, pictures with crop and alternative text, symbols, equations, headers and footers, page numbers, columns, breaks, footnotes, table of contents, numbered captions with cross-references, citations and bibliography, bookmarks, links, watermark, fields and forms (12), comments with mentions and tasks, suggestions with review tools, version history, catch-up, presence, autosave indicator, recovery journal, templates, accessibility checker, import and export (PDF, LaTeX, DOCX, HTML, Markdown) |
| Through ports and extensions | Spelling and grammar, text prediction, assistant (draft, rewrite, summarise, chat), translate, read aloud, dictation through the operating system, custom blocks, host-specific panels and commands |
| Non-goals | Creating or editing SmartArt, charts, shapes, text boxes and ink (those in imported Word files are preserved and shown with their fallback; ADR 0017), mail merge, macros, table formulas, researcher-style lookup, transcription, offline-first editing |

## 3. Shell

| Area | Contents |
|---|---|
| Header | Document title slot, save state, mode switcher, presence avatars, buttons for comments, catch-up and share. The host can hide it and draw its own |
| Toolbar | Commands grouped by task (for example formatting, inserting, page layout, references, review, view), with contextual groups for tables, pictures, headers and fields. A compact single-row layout and a full layout, both generated from the command registry. The grouping and appearance are this product's own |
| Panes | Navigation, styles, comments, review, history, permissions, fields, accessibility checker, assistant, PDF preview, recovered edits |
| Status bar | Page and word counts, language, classification label, connection and save state, zoom |
| Modes and views | Modes: `edit`, `review` (suggestions on), `view`, `fill` (12). Views: `web` (continuous layout), `read` (real pages, read-only), `print` (editable pages, phase 3). See 02, section 7 |

## 4. Command system

Everything the user can do is a command in one registry:

```json
{ "id": "format.bold", "label": "Bold", "icon": "bold", "group": "home.font",
  "keys": ["Mod-b"], "accessKey": "1", "enabled": "canEditSelection", "active": "isBold" }
```

The registry feeds both toolbar layouts, context menus, the mini toolbar, command search, access keys, the `exec()` method and extensions. `enabled` and `active` name queries on the document API, so a host toolbar can mirror the built-in one. Command search matches labels and synonyms and respects what the current permissions allow.

**Access keys.** With focus in the editor, pressing and releasing Alt on its own shows the access key of each visible command that declares one. A letter or digit then runs that command, and Escape leaves the mode and returns focus to the editing surface. Each key is also exposed as text on its control. A command the user's permissions do not allow runs nothing and its reason is announced. With focus in the host page the editor does not react. A key is one letter or digit, and two commands in the same toolbar group cannot share one (refused at registration). The gesture was chosen by the owner on 2026-11-15 (docs/owner-decisions-2026-11-15.md, decision 116; ADR 0231, option A). The built-in commands declare no access key yet. The gesture is not free in every supported browser. The browsers' published shortcut lists were read on 2026-11-20 (UX-013): Firefox's gives Alt on its own the meaning "Toggle Menu Bar activation (showing it temporarily when hidden)" on Windows and Linux, and Edge's gives it "Set focus on the Settings and more button" on Windows. Chrome's and Safari's lists do not name the key on its own. What each of those browsers does when the editor takes the key is not measured, so UX-012 criterion 3 stays open and is the owner's to settle.

Keyboard shortcuts follow the conventions users already know from word processors where a browser allows it, because shortcuts are a capability and not a look. A shortcut table (the conventional shortcut, this product's, and conflicts with each browser) is maintained with the registry. Where a browser reserves a shortcut, the table names the alternative.

## 5. Collaboration experience

- **Presence.** Name flags at carets and avatars in the header. Names and avatars come from a host callback, `resolveUsers(ids)`, so the document service keeps no profile data.
- **Comments.** Threads with replies, resolve and reopen, reactions, links to a comment, and mentions. A mention is a node in the comment body chosen through `searchPrincipals`; the service raises `dep.comment.mentioned` and the host sends the notification. A thread can be assigned to a person as a task. A thread targets a text range or a whole block (figure, table, equation) by identifier.
- **Review.** Markup views (all, simple, none, original), accept and reject one or all, filter by author, a review pane. A document setting `trackChanges: everyone` makes the authority apply the suggestion rule (P4) to every user until an owner switches it off.
- **Catch-up.** Changes and comment activity since the reader's last visit (08, section 10), including "for you" items: mentions and assigned tasks.
- **Sharing.** Whole-document sharing belongs to the host. The share button raises `de-share-request`; the host shows its own dialog. Region grants and workflow participants are managed in the editor.
- **Output restrictions.** Next to capabilities, a user's access can carry the restrictions `no-export`, `no-copy` and `no-print`, which the component and the control plane honour. They deter casual copying and are not a security boundary.

## 6. Assistance

### 6.1 Proofing port

An optional backend port for spelling and grammar. Results are decorations with suggestions; they never change the document by themselves. The port receives text only from scopes the user can view, with the language from the `lang` mark, and supports custom dictionaries: one list for each person and one shared list for the tenant that an administrator keeps (owner decision 34). The port has `addWord`, `listWords` and `removeWord`, each with the list it means; a port that lacks the last two leaves the editor without dictionary controls, and the port decides who may change the shared list. Autocorrect and automatic formatting are a table in the editing core. This also answers the loss of native spellcheck in the page view, and in the web view too, where a Word-style context menu hides the browser's own suggestions.

### 6.2 Assistant port

A provider-neutral port for drafting, rewriting, summarising and answering questions about the document.

- **Identity.** An assistant acts for a user under a delegated agent identity. Its commits carry `origin: "assistant"` and `author.agent`, so history always shows what a person wrote and what a model wrote for them.
- **Writes arrive as suggestions.** The agent identity is capped at `suggest` by the room, from a separate agent token (05 section 3.2.1; 07 section 4; ADR 0234 part A). An assistant's direct edit is refused by the server (owner decision 119). Rule P4 then applies to its commits as to any suggester, so an assistant cannot change text without a person accepting it.
- **Context.** Limited to scopes the user can view. The port exposes the selection, the surrounding blocks and the outline; hosts decide what else to attach.
- **Prompt injection.** Document text, comments and field values are untrusted input to a model. The component marks them as data in the prompt, requires the user's approval before any side effect, blocks model-generated links and images that were not in the source, and never lets model output reach the LaTeX pipeline except as ordinary escaped text. The link allow-list and asset-only images of 10 already help.

## 7. Extension model

### 7.1 Contributions

An extension is a manifest plus code. It can contribute commands, toolbar groups, context-menu items, side panels, status-bar items, keyboard shortcuts, import and export filters on the client, and custom blocks (7.3). It uses a range-based document API with events for blocks added, changed and deleted, selection changes, suggestions and comments.

### 7.2 Trust tiers

| Tier | How it runs | Use |
|---|---|---|
| 1. Host-registered | In the page, registered by the host through the element's `extensions` property | The host's own features. Same trust as the host page |
| 2. Sandboxed (phase 4) | In a sandboxed iframe, talking to the editor over message passing, with declared read and write levels | Third-party add-ins |

Extension hooks are asynchronous and never sit on the typing path. Extension panels are held to the same accessibility bar as built-in ones.

### 7.3 Custom content

The CDM reserves `extension_block` and `extension_inline`. Each carries an extension identifier, a JSON payload within a size limit, and a mandatory fallback (an image asset or plain text). Writers render the fallback, which keeps the rule that a construct exists only if every writer can express it. The authority validates the envelope, not the payload.

## 8. Theming, localisation, accessibility

- **Theming and white-label.** Design tokens as `--de-` custom properties, replaceable icons and strings, a dark mode that includes the page canvas as an option, and defined behaviour under `forced-colors`.
- **Localisation.** All interface strings are external. Layout uses logical CSS properties from the start so that right-to-left interfaces need no rework. Right-to-left and complex-script content follow the plan in 02, section 11.
- **Accessibility.** WCAG 2.2 level AA for the interface, the authoring-tool guidelines ATAG 2.0 (the editor must be accessible and must help authors produce accessible documents), an accessibility conformance report per release, and an accessibility checker pane for alternative text, heading order, table headers, link text and contrast, which feeds the tagged-PDF requirements of 09.

## 9. Performance and reliability budgets

| Budget | Target |
|---|---|
| Initial bundle | At most 320 KB compressed for the first interactive editor (owner decision 32, 2026-11-17; it was 300 KB); the PDF viewer, math editor, panes, proofing and assistant load on demand |
| Time to interactive | Under 2 seconds for a 20-page document on the reference machine |
| Typing latency | 00, section 9, measured with the Event Timing API on a named reference machine with CPU throttling |
| Long documents | The web view usable to 300 pages; the page view to 1,000 pages with virtualisation |
| Memory | Under 300 MB for a 100-page document |

**Recovery journal.** Unconfirmed commits and recovered edits are written to IndexedDB and survive a closed tab or a crash. On return, the component resubmits them with their original identifiers, which the deduplication rule of 04 makes safe. This is disconnection tolerance, not offline-first editing (assumption A1).

## 10. Governance and administration

| Capability | Where |
|---|---|
| Audit | `GET /audit` with filters, and a feed for security tools that polls `GET /audit` at a stated cadence (owner decision 59; no streaming route). The feed client is `AuditFeed` in `@docedit/protocol/client`: it asks for a window that starts before the newest event it has, delivers each event once by its identifier, and keeps a position a consumer saves to resume. Proposed settings: a poll every 5 s, a window of 60 s (`docs/adr/0432-w3-UX-082-audit-feed.md`) |
| Retention and legal hold | Policy per tenant and per document; hold API |
| Discovery export | A bundle of content, history, comments and evidence for a document or a tenant |
| Classification label | A field on the document resource, shown in the status bar, applied as a marking at export |
| Policy hook | A synchronous pre-export and pre-send hook the host can use for data-loss prevention |
| Administration API | Tenants, signing keys and allowed origins, quotas, fonts, retention, webhooks, usage figures. A console comes later and uses only this API |
| Listing and search | `GET /documents` and `GET /search` for service credentials, so a host can build its own catalogue. The editor itself never lists documents |
| Tenant export | Everything a tenant owns, in documented formats |

## 11. Host integration

### 11.1 What a host application must build

1. A token endpoint that authenticates its user, decides their role per document, and signs a short-lived token; and the registration of its public keys and allowed origins with the document service.
2. The page glue: `getToken`, `resolveUsers`, `searchPrincipals`, handlers for `de-share-request`, `de-auth-required` and `de-error`, and a call to `flush()` before navigation.
3. A webhook receiver that verifies signatures and deduplicates.
4. Its own document catalogue: titles, folders, sharing, keyed by the document identifier or by the `externalId` it set at creation.
5. Notifications: e-mail or chat messages for mentions, tasks, workflow invitations and reminders.

### 11.2 Reference host

A small reference application (SvelteKit and a compose file for the document service, PostgreSQL, object storage and one export worker) ships with the project. It covers token minting, a document list, sharing, webhooks to e-mail, a template gallery and "send for completion". It is the demo harness from the first phase and the starting point for adopters.

### 11.3 Service calls on behalf of a user

Service credentials name the acting user with the `DEP-Actor` header, so history attributes server-side integrations correctly.

## 12. Roadmap placement

| Phase | From this document |
|---|---|
| 1a | Reference host skeleton; header with presence and save state; command registry with the compact toolbar |
| 1b | Context menu, format painter, navigation pane (headings, search), dark mode, recovery journal, styles pane |
| 2 | Mentions, tasks and reactions; review tools; catch-up; proofing port; assistant port; extension tier 1; custom blocks; accessibility checker; command search and access keys; audit and administration API; output restrictions; HTML and Markdown |
| 3 | Page thumbnails, the project's own read-only painter for the read view, fields and panes in the page view |
| 4 | Sandboxed extensions; classification labels; discovery export; console; right-to-left content; mobile |

## 13. Open issues

- The product's own visual design and interaction design are not specified here and need a designer.
- Citations are built in since the owner's decision of 2026-11-06 (03, section 13). Which citation styles the house class offers, and how the editor renders them, is open (CDM-052).
- The exact document API offered to extensions, and how it is versioned.
- Sandboxed extensions are built, by the owner's decision of 2026-11-15 ([ADR 0393](../adr/0393-w3-UX-059-sandboxed-extensions.md)). No evidence of partners, tier 1 usage or review cost backs it; the security review of the sandbox is still to be done.
- Dictionaries and their licences for a built-in fallback spell checker.
