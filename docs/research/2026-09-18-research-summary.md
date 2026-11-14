# Research summary, 2026-09-18

This is a condensed record of nine research tracks run on 2026-09-18. The specification in `docs/spec` rests on it.

**How far to trust it.** Research agents gathered these findings from the linked primary sources on that day. Pages were read through a summarising fetcher, so wording is paraphrase unless quoted. Items the agents could not confirm are marked UNVERIFIED. Three claims were re-checked separately because the sync decision depends on them: the Yjs threat-model quotes, the existence and server-side rebasing of `prosemirror-collab-commit`, and the existence of .NET and Python ports of ProseMirror's model. Version numbers will age quickly.

## 1. Prior art: Word-like editors on the web

The claim that nothing like this exists is false as stated. Several products offer paginated, Word-style editing with DOCX round-trip.

| Product | Rendering | Licence | Notes |
|---|---|---|---|
| [SuperDoc](https://github.com/superdoc/docx-editor) | Own layout engine, DOM painter. Version 2 replaced ProseMirror with an OOXML-backed model | AGPL-3.0 or commercial | Tracked changes, comments, Yjs collaboration. Vue internals, no web component |
| [Eigenpal docx-editor](https://github.com/eigenpal/docx-editor) | DOM-free layout, HarfBuzz shaping, painted pages | Apache-2.0 core; review and collaboration in a paid tier at about USD 500 a month | Repository was deleted and re-created in mid 2026 |
| [ONLYOFFICE Docs](https://github.com/ONLYOFFICE/DocumentServer) | Canvas, own layout and font engines | AGPL-3.0 with extra terms; commercial edition | Embedded through an iframe and a server |
| [Collabora Online](https://www.collaboraoffice.com/) | LibreOffice on the server renders tiles | MPL-2.0 | Server product, not a library |
| [Syncfusion Document Editor](https://www.syncfusion.com/docx-editor-sdk/javascript-docx-editor) | Canvas, own layout | Proprietary; free community licence under revenue and head-count limits | Per-user editable regions; operational-transformation collaboration |
| [Nutrient Document Authoring](https://www.nutrient.io/sdk/document-authoring/) | WebAssembly layout engine | Proprietary | Comments and tracked changes since late 2025 |
| [Apryse DOCX Editor](https://docs.apryse.com/web/guides/docx-editor) | Client-side | Proprietary | Ships as a web component with Shadow DOM by default |
| [Docen](https://github.com/DemoMacro/docen) | Canvas over a viewless Tiptap model | MIT | Custom element with Shadow DOM; early (version 0.7), no review features |
| [canvas-editor](https://github.com/Hufe921/canvas-editor) | Canvas | MIT | Mature caret, input and pagination handling on canvas |
| [Tiptap Pages](https://tiptap.dev/docs/pages/getting-started/overview) | Layout overlay on an editable element | Paid | Blocks taller than a page can cause an endless layout loop |
| [CKEditor 5 pagination](https://ckeditor.com/docs/ckeditor5/latest/features/pagination/pagination.html) | Predicted break lines only | GPL or commercial | Blink browsers only; [Shadow DOM request open since 2016](https://github.com/ckeditor/ckeditor5/issues/3891) |

Svelte-specific editors (svelte-lexical, svelte-tiptap, Edra, Tipex, Typewriter, Carta) are wrappers without pagination.

**The gap** is a permissively licensed, framework-agnostic custom element with Shadow DOM that has true pagination and the full review and collaboration feature set. None of the products above combines that with per-user region permissions enforced by a server, attributable history and LaTeX output.

**Licence caution.** SuperDoc and ONLYOFFICE are AGPL; Fidus Writer and TeXlyre (section 8) are AGPL. They can be studied but no code may be copied.

## 2. Editing engine, Svelte and Shadow DOM

- **ProseMirror** (MIT) deliberately supports shadow roots. It uses `getComposedRanges` where available and falls back to a `beforeinput` technique elsewhere ([source](https://github.com/ProseMirror/prosemirror-view/blob/master/src/domobserver.ts)). Shadow-specific bugs still appear, for example a Chrome composition bug worked around in December 2025 and an open iOS Safari issue.
- **`Selection.getComposedRanges()`** shipped in Safari 17, Chrome and Edge 137 and Firefox 142 ([caniuse](https://caniuse.com/mdn-api_selection_getcomposedranges), [Lexical's notes](https://lexical.dev/docs/concepts/shadow-dom)). `ShadowRoot.getSelection()` is non-standard and Chromium-only. `selectionchange` fires on the document only, and `document.activeElement` is retargeted to the host.
- **Lexical** gained shadow-root support in June 2026, for open roots only. **Tiptap** has open shadow-root issues and sells the Word-like parts. **CKEditor 5** has no shadow-root support.
- **EditContext** ships in Chrome and Edge 121 and later, is being implemented in Firefox ([tracking bug](https://bugzilla.mozilla.org/show_bug.cgi?id=2046107)), and has no WebKit plan ([bug](https://bugs.webkit.org/show_bug.cgi?id=269922)). CodeMirror 6 and VS Code use it in production.
- **Svelte 5 custom elements** ([docs](https://svelte.dev/docs/svelte/custom-elements)): the wrapper creates the inner component a microtask after connect and destroys it a microtask after disconnect; context does not cross custom-element boundaries. `mount()` accepts a shadow root as its target, and injected CSS is placed in that root. `$state.raw` and `createSubscriber` keep engine state out of deep reactive proxies.
- **Shadow DOM details:** `@font-face` declared only inside a shadow root is ignored ([Chromium issue](https://issues.chromium.org/issues/41085401)); ARIA references do not cross shadow boundaries; cross-tree CSS anchor positioning is inconsistent; Playwright pierces open roots.

## 3. Pagination and layout

- Every product verified to have true pagination owns its line breaking and pagination. None delegates to CSS.
- Google Docs has run its own layout engine since 2010 and [moved to canvas rendering in 2021](https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html) for performance and cross-platform consistency. Its hidden input element is known to misplace input-method windows.
- SuperDoc's pipeline is document to flow blocks to a layout engine to a DOM painter ([docs](https://docs.superdoc.dev/resources/how-superdoc-works)): canvas `measureText` with caches, greedy line breaking, incremental relayout from the first dirty block, page virtualisation.
- CSS fragmentation exists only for multi-column layout and print ([Chromium](https://developer.chrome.com/docs/chromium/renderingng-fragmentation)).
- Measurement: canvas `measureText` uses the browser's shaper but has traps documented in the [pretext research notes](https://github.com/chenglou/pretext/blob/main/RESEARCH.md) (kerning lost across segment boundaries, emoji width differences, engine-specific line-fit tolerances). `Intl.Segmenter` has no line granularity, so Unicode line-breaking tables must be bundled. Enhanced `TextMetrics` is Chromium-only.
- Recommended architecture: own layout engine, DOM painter with one non-wrapping box per line, caret and hit testing from layout data, a hidden editable element at the caret for input.

## 4. DOCX and document model

- The editors that reach Word-level fidelity use an OOXML-shaped model and keep the package. Tiptap's conversion [documents its losses](https://tiptap.dev/docs/conversion/getting-started/feature-support-matrix); CKEditor's import drops headers and footers from the body and does not reflect original page divisions.
- Useful libraries: [`docx`](https://github.com/dolanmiu/docx) (writer, MIT), [mammoth](https://github.com/mwilliamson/mammoth.js) (lossy HTML, no sanitisation), Microsoft's [Open XML SDK](https://github.com/dotnet/Open-XML-SDK) (MIT, preserves unknown content), LibreOffice through Gotenberg as a format bridge that re-lays out documents.
- Formatting must be resolved as a cascade at layout time (document defaults, table style, numbering level, paragraph style chain, character style, direct formatting), never baked into content. Toggle properties need an explicit "off" value.
- Suggestions in ProseMirror: [`prosemirror-suggest-changes`](https://github.com/handlewithcarecollective/prosemirror-suggest-changes) (MIT) uses insertion, deletion and modification marks including block boundaries.
- Fonts: Carlito, Caladea and the Liberation families are metric-compatible with Calibri, Cambria, Arial, Times New Roman and Courier New. [Aptos](https://learn.microsoft.com/en-us/typography/font-list/aptos) is proprietary and had no open metric-compatible substitute as of March 2026.
- Security of parsing DOCX: decompression bombs, XML external entities, external relationships and remote templates ([MITRE T1221](https://attack.mitre.org/techniques/T1221/)), macros, embedded objects. mammoth had a file-read vulnerability through external image links (CVE-2025-11849).

## 5. Collaboration, backend and storage

- **Yjs** stable was 13.6.x; version 14, which adds attribution, was a release candidate. Its ProseMirror binding has an [open issue](https://github.com/yjs/y-prosemirror/issues/275) about destructively dropping content that violates the schema. The Yjs [threat model](https://github.com/yjs/yjs/blob/main/THREAT_MODEL.md) says: "Server-side filtering of updates is a common antipattern" and "Suggestion-only (untrusted) users should work on a separate Yjs document fork".
- **Loro** has rich text, time travel and shallow snapshots but a small server ecosystem. **Automerge 3** cut memory by more than ten times and keeps full history. No production rich-text library strictly implements Eg-walker.
- **Central authority:** [`prosemirror-collab-commit`](https://github.com/stepwisehq/prosemirror-collab-commit) rebases on the server. Ports of ProseMirror's model and transform exist for [.NET](https://github.com/stepwisehq/prosemirror-dotnet) and [Python](https://github.com/fellowapp/prosemirror-py); both are small projects.
- **Hosted and open backends:** Hocuspocus 4 (MIT) processes each document's messages sequentially; y-sweet appears unmaintained after Jamsocket joined Modal; Liveblocks caps connections per room at 10 to 100 depending on plan; Cloudflare Durable Objects fit the one-room-per-document model with a 128 MB memory cap.
- **How large products do it:** [Figma](https://www.figma.com/blog/making-multiplayer-more-reliable/) runs one process per open file, checkpoints to object storage every 30 to 60 seconds and batches a journal about every 500 ms; it [sharded PostgreSQL](https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/) rather than leave it. [Notion](https://www.notion.com/blog/the-great-re-shard) runs on sharded PostgreSQL. Microsoft's [Fluid relay](https://github.com/microsoft/FluidFramework/tree/main/server/routerlicious) assigns sequence numbers centrally and stores summaries in blob storage. The common pattern: one orderer per document, sticky routing, an append-only log with periodic snapshots, blobs in object storage, a relational database for metadata.
- **SQL or NoSQL:** PostgreSQL for everything relational and at first for the log; object storage for snapshots and assets; not MongoDB.

## 6. Region permissions

- Word's editable ranges and document protection are, by the file format's own specification, not a security feature.
- Syncfusion offers editable regions per user or group. CKEditor's restricted editing needs every connected user in the same mode. ONLYOFFICE has per-user protected ranges only in spreadsheets. Google Docs has document-level roles only. Notion and Coda locks are guardrails, not permissions.
- The Yjs author has stated that secure access to part of a Yjs document is [currently not possible](https://discuss.yjs.dev/t/generate-an-inverse-update/2765) and recommends separate documents.
- Cryptographic access control for CRDTs (Keyhive, p2panda) is research-grade and works per document, not per range.
- Every product found that enforces per-user ranges during co-editing does so on an authoritative server.

## 7. History and attribution

- Google Docs stores revisions with user, session and time and groups them for display; [Overleaf](https://github.com/overleaf/overleaf) stores history in chunks of a snapshot plus at most 2,000 changes or 5 MB and groups versions at read time; Figma keeps autosave checkpoints plus named versions; SharePoint thins versions with age.
- Yjs snapshots need garbage collection disabled; client identifiers are per session; attribution data inside the document is asserted by clients. Loro and Automerge have stronger history but also client-asserted metadata.
- [`prosemirror-changeset`](https://github.com/ProseMirror/prosemirror-changeset) builds attributed insert and delete spans from steps.
- Ink & Switch's [Upwelling](https://www.inkandswitch.com/upwelling/) and [Patchwork](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/04/) found that tracking everything by default, keeping history linear and showing inline differences with deletions on demand tested best.

## 8. LaTeX backend

- Overleaf's visual editor handles a subset of LaTeX and drops to source for the rest. [Fidus Writer](https://github.com/fiduswriter/fiduswriter-document-ts) exports LaTeX from a ProseMirror document with a recursive tree walk and a separate escaping module. MyST shows one model feeding several writers.
- Pandoc's model has no page layout, fonts, colours or revisions.
- LuaLaTeX cost, from a [LaTeX project issue](https://github.com/latex3/latex2e/issues/1877): about 1.4 seconds for a one-page document and about 23 seconds for 10,000 paragraphs; pdfLaTeX is several times faster but cannot load OpenType fonts by file.
- Tagged, accessible PDF is production-ready in TeX Live 2026; `tabularray` is [not compatible with tagging](https://github.com/latex3/tagging-project/issues/177), `longtable` is.
- Security: command blacklists fail ([Hacking with LaTeX](https://0day.work/hacking-with-latex/)); LuaTeX before 1.17 allowed shell execution with shell escape disabled ([analysis](https://www.maxchernoff.ca/p/luatex-vulnerabilities)); `--safer` disables OpenType font loading. Overleaf's compile service runs each compile in its own container.
- Pagination parity options: accept divergence with an authoritative preview; constrain the class so a simple line breaker matches; have the compile report real break positions through LuaTeX callbacks. Emulating TeX in the browser amounts to rewriting it. WebAssembly builds of TeX exist but are large.

## 9. Protocol design

- [WOPI](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/concepts) interoperates across vendors because of discovery, opaque scoped tokens and a public [validator](https://github.com/microsoft/wopi-validator-core). It cannot express real-time editing.
- [y-protocols](https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md) has no versioning, acknowledgements, errors or limits. The [Loro protocol](https://github.com/loro-dev/protocol/blob/main/protocol.md) adds typed rejection statuses and fragmentation. automerge-repo negotiates versions in its handshake and separates network from storage adapters.
- [LSP](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/) and [MCP](https://modelcontextprotocol.io/specification/versioning) show capability negotiation, disciplined versioning and conformance-gated change.
- Transport limits seen in the field: 128 KB messages on AWS API Gateway; idle timeouts of 100 seconds on Cloudflare's lower plans. WebTransport reached all major browsers only in 2026.
- Webhooks: CloudEvents 1.0 for the envelope, [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) for signing.

## 10. Items the research could not confirm

- The internal rendering of Word for the web, Apple Pages for iCloud and Zoho Writer.
- Whether Syncfusion's server re-checks editable regions for every operation.
- The input design of SuperDoc version 2.
- Whether Rust's Yrs supports Yjs version 14's attribution.
- How grammar-checking browser extensions behave inside shadow roots.
- Several pricing figures, which change often and should be re-checked before they are relied on.
