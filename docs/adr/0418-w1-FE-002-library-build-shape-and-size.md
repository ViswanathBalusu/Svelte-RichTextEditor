# ADR 0418: Shape and size of the library build

**Status:** proposed, 2026-11-20, lane w1 (story FE-002). Items 1 to 4 are built. Item 5 is a measurement and a list of options; the choice is the owner's. Not reviewed by the project owner.

## Context

FE-002 asks for one ES module with lazily loaded chunks and a first interactive editor within the budget of 13 §9, which is 320 KB compressed since owner decision 32. ADR 0039 §2 defines what is counted (the entry, the editor chunk and their static imports; with the DEP client for an endpoint; gzip level 9) and §3 the stylesheet (a string, no file; owner decision 18). [ADR 0370](0370-int-first-editor-over-budget.md) records that the build has been over the budget since 2026-11-17.

Measured on this branch on 2026-11-20, before any change, with `node scripts/build.ts` in `packages/element` on the lane's Windows 11 machine (Node.js zlib, gzip level 9, on the files of the library build): 395.9 kB with a host backend and 416.8 kB with the DEP client.

Two causes were in the packaging, not in the features:

- Vite 8 minifies an ES library's names and syntax and keeps its whitespace (`codegen: false` in its library defaults), because it expects a consumer's bundler to minify the result. The budget was therefore counted on files with their indentation and line breaks.
- The element's entry imported `DEP1_WIRE_NOTIFICATION_TYPES` from `@docedit/protocol`. That constant lives in the module that builds `DEP1_WIRE`, so the bundler put the whole protocol definition (resources, messages, shapes, the 12 §10 extension; 123 kB before minification) in a chunk the entry loads, also for a host that passes its own backend and never uses the DEP client.

## Decisions (proposed)

1. **The library's chunks are minified with their whitespace removed** (`LIBRARY_MINIFY` in `packages/element/scripts/vite-configs.ts`). The distributable is what a host loads by URL, and it is what the budget measures. The `@__PURE__` annotations stay in the output: a build with the whitespace kept and a build with it removed both had 608 of them in their chunks (counted on 2026-11-20, before item 2). A host that bundles the module can therefore still drop what it does not use. Source maps are still written.
2. **The element repeats the notification type names** (`NOTIFICATION_TYPES` in `packages/element/src/notifications.ts`) instead of importing the protocol definition. `packages/element/test/pro-035-notifications.test.ts` fails when the list and the definition differ. The alternative, a generated names-only module in `@docedit/protocol`, is cleaner and belongs to the protocol's owner; the element would import it instead.
3. **The build fails when its shape is not the one 02 §2 asks for** (`structureOf` in `packages/element/scripts/bundle-report.ts`, written to `bundle-report.json` as `structure`): one entry named `doc-editor.js`; each pane of the shell in a lazy chunk of its own; the math editor (MathLive and the module that mounts it) and the PDF viewer's controller in lazy chunks; the viewer frame's page with a script and a worker file of its own; no stylesheet file of the component, and its CSS as a string in a chunk of the first interactive set; and nothing of the protocol definition in the first interactive set of a host backend.
4. **"A string in the editor chunk"** (owner decision 18) is read as a string in a script chunk the editor loads with its first document. The bundler puts it in `chunks/styles-<hash>.js`, a static import of the editor chunk, because the read view and the print frame use the same string.

## 5. What remains over the budget

After items 1 and 2, same method and machine, 2026-11-20: **333.8 kB with a host backend (13.8 kB over) and 374.9 kB with the DEP client (54.9 kB over)**. Whitespace removal alone gave 355.6 kB and 374.2 kB (measured without source-map comments). The build still fails on the size check, as it should.

Where the first interactive set of a host backend goes, from `bundle-report.json` (the gzip figure per package is an estimate: each chunk's gzip size split by the bundler's rendered module lengths):

| Part | Estimate |
|---|---|
| `@docedit/engine` | 96.9 kB |
| `@docedit/ui` (16.5 kB of it is the base string table, its own chunk) | 67.4 kB |
| ProseMirror (view, model, transform, state, commands, history and the small ones) | about 67 kB |
| `@docedit/model` | 32.4 kB |
| `@docedit/element` | 30.1 kB |
| Svelte | 22.2 kB |
| `@docedit/rules` | 13.4 kB |

Nothing more can be taken out by configuration. What is left needs one of the options of ADR 0370, which only the owner can choose:

- **Raise the budget again**, or **count the DEP client separately**. With the DEP client the set is 41.1 kB larger (the `dep-client` chunk), and that chunk carries the protocol definition with the members only the generators read (`spec`, `doc`, `gaps` and `owner` occur 179, 122, 145 and 89 times in the minified chunk, and the REST operations of the 12 §10 extension are in it). A run-time definition generated without them would shrink it; that is the protocol package's work.
- **Load on demand what only a pane uses.** The largest group that the engine reaches through static imports in `core.ts` but that serves the fields, roles, sources and rules panes: `@docedit/rules` (73.9 kB before minification), the CDM validator `model/src/validate` (51.7 kB) and the engine's `field-edit`, `role-edit`, `source-edit`, `rule-edit` and `field-rules` (21.3 kB). Together about 8 % of the set's rendered bytes, so roughly 25 kB of gzip. Rule evaluation also runs while a document with rules is filled, so the rules package would have to load with such a document, not with the pane. This changes synchronous members of `CoreApi` into asynchronous ones and touches the panes of other epics; it was not attempted inside FE-002.
- **Split the base string table** so that the strings of panes and dialogs load with them (16.5 kB today, the shell's work).

## Consequences

- FE-002 criterion 3 is unticked until the set is within the budget in both configurations, or the owner changes what is counted.
- A host that passes its own backend no longer downloads the protocol definition.
- A reader of the published chunks sees a few very long lines per file; the source maps next to them give the sources.
