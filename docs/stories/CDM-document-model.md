# CDM Canonical Document Model

**Status:** first draft, 2026-11-06, from specification draft 0.2. Like the spec, every number below is a target or a limit to validate, not a measurement.

**Scope.** The stored and transferred form of a document ([03 Document model](../spec/03-document-model.md), all of it): the envelope and canonical form, every node and mark, the formatting cascade, the layout semantics that the editor and the writers share, the invariants and their validator, identifiers, writer support, the evolution rules (versions, features, `ext`, migrations), the published JSON Schema, and the ProseMirror schema generated from the same definition. All of it lives in `packages/model` (01 §6).

**Sources.** Spec 03 (normative); 12 §3 (read only to see what FRW owns); 11 §2 to §4 (phases and spikes); ADR [0004](../adr/0004-semantic-document-model.md), [0009](../adr/0009-regions-as-block-containers.md) and [0011](../adr/0011-fields-in-tree-and-fill-capability.md); the [pitfall review](../review/2026-09-18-pitfall-review.md) section 3.5 (M-1 to M-16) and section 6.

**What this epic leaves to others** (README §2.3):

- FE: how the editor renders and edits a node, the identifier plugin's wiring into editor state, the region guard, the clipboard pipeline, sub-editors, suggestion mode.
- EXP: how the LaTeX and DOCX writers emit a node, the math gate, the typed emitters.
- FRW: the attributes of `role_def`, `rule_def` and `form_field`, the field values, invariants I13 to I15. This epic owns only the slots 03 itself reserves (CDM-022) and the `formValue` kind name inside the `field` node.
- SYN and PRM: the authority algorithm that calls the validator; the permission outcome check; the P4 rules that enforce `suggest`. This epic owns the data definition and the invariants of suggestion marks.
- PRO: the published conformance kit and the wire codes. This epic supplies the schemas and fixtures that go into the kit.

**Phases.** The machine-readable schema artifacts are a phase 0 deliverable (root README, "What is not here yet"; spike S6). Phase 1a needs only paragraphs with styles, and regions (11 §3). "CDM version 1 with everything in 03" is phase 1b (11 §4), so the stories for nodes whose editing arrives later (suggestions, fields) still sit in 1b: they are the data definition, not the editing behaviour. Where nothing places a story, the Notes say "phase inferred".

**Conventions in this file.** The grammar, default and enumeration tables that 03 leaves open are settled by CDM-002 and CDM-003; stories refer to them as "per CDM-002". "The definition" means the single declarative CDM definition of CDM-006.

## Decisions and spikes before CDM 1 is frozen

### CDM-001 Decide the footnote content model

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Maintainer |

**Spec:** 03 §4.4, §13; 11 §2 (S1); review M-11, §6 item 3 · **Requirements:** R1 · **Depends on:** SPK-014

As a maintainer, I want the footnote content model settled before `cdm: 1` is frozen, so that multi-paragraph footnotes never need a new major version.

**Acceptance criteria**

- [x] Given the S1 results for footnote sub-editors, when they are in, then a decision record states which content expression `footnote` uses (`inline*`, as drafted, or `paragraph+` limited to one paragraph) and cites the S1 evidence on how an inline node with block content behaves in the editing core.
- [x] Given the decision, when it is recorded, then 03 §4.4 and §13 are updated, and the definition (CDM-006), the JSON Schema (CDM-007) and the ProseMirror schema (CDM-008) are regenerated from it in the same change.
- [x] Given the chosen expression, when a version 1 document is validated, then a footnote still holds exactly one paragraph of content, whichever expression is chosen (03 §4.4; see CDM-034).
- [x] Given this decision is not yet recorded, when schema artifacts are prepared for release, then they are published as a draft and not as the frozen `cdm: 1`.

**Evidence:** `packages/model/src/schema/artifacts.test.ts`, "names the cdm major version and its draft status": the JSON Schema's `$id` is `urn:docedit:cdm:1:draft` and its title "CDM version 1 (draft)", and the manifest of every generated artifact (`spec/cdm/cdm-1.manifest.json`) has status `draft`, from `CDM1.status` in the definition. Decision recorded as proposed in `docs/adr/0031-cdm-1-model-completion.md` section 3 with the S1 evidence (`docs/spikes/2026-11-06-s1-prosemirror-shadow-root.md` section 5): option B, `paragraph+` with one paragraph in version 1. 03 §4.4 and §13 are updated; `packages/model/src/definition/cdm1.ts` declares it and the JSON Schema, ProseMirror schema and types are regenerated (`spec/cdm/`). Tests: `src/validate/inline.test.ts`, "the footnote content model (CDM-001)" and "footnotes of one paragraph (CDM-034)" (two paragraphs are I1 `footnote_paragraphs`; inline content directly in a footnote is I1); `src/prosemirror/schema.test.ts`, "uses the footnote content model decided in CDM-001".

**Notes:** Open issue in 03 §13 and review §6 item 3. S1 owns the evidence; this story owns the recorded decision and its propagation. Second review (2026-11-06, SPK-027), SR-M16: the decision should weigh A2: imported footnotes of several paragraphs must be stored and written back, so the review recommends `paragraph+`, limited to one paragraph for editing, with longer imported footnotes preserved as a whole ([review](../review/2026-11-06-second-review.md)). Spike S1 gave the evidence, and ADR 0031 section 3 records option B, `paragraph+` with one paragraph in version 1, as proposed: the owner has not accepted the ADR yet. How an imported footnote of several paragraphs is kept (SR-M16) is the importer's question; lifting the limit later needs no new major version.

### CDM-002 Decide the attribute grammars, defaults and reference forms that 03 leaves open

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | M | must | Maintainer |

**Spec:** 03 §2, §4, §5, §8 (I4, I7, I9, I11), §9, §11.2; ADR 0004 (after the first review) · **Requirements:** R6, R10 · **Depends on:** none

As a maintainer, I want every attribute's type, range, length, pattern and default written down, so that the schema, the validator and the canonical form can be built and every implementation agrees on the bytes.

**Acceptance criteria**

- [x] Given every attribute in the node and mark tables of 03 §4 and §5, when the decision is recorded, then each has a row giving its type, range, length, pattern and default. The default is what the canonical form omits (03 §2); the grammar is what invariant I11 checks.
- [x] Given the enumerations 03 names without values (alignment in paragraphs, tables and numbering levels, `orientation`, `pageNumberFormat`, `footnoteFormat`, tab `leader`, `vAlign`, `highlight`, the structures of `borders` and `shading`, `lang`), when the decision is recorded, then each has its value set or structure.
- [x] Given integer attributes, when the decision is recorded, then each has a range inside the interoperable integer range of RFC 8785, and `#RRGGBB` has a fixed letter case, so that hashes agree across languages.
- [x] Given the lists 03 refers to without contents, when the decision is recorded, then the reserved built-in style identifiers ("`Normal`, `Heading1` to `Heading9`, `Caption`, `FootnoteText` and the like") and the published `bulletChar` list are written out.
- [x] Given references, when the decision is recorded, then it fixes the addressing form of `field.target` for each target kind (bookmark, heading, numbered paragraph, caption sequence, equation label, style), the form of an in-document `link.href`, whether `anchor.name` and equation `label` must be unique, and the format and copy rule of `listId`.
- [x] Given the extension points, when the decision is recorded, then it fixes the grammar of namespaced `ext` keys and a size bound for `ext`, the shape of `fmt.before`, the size limit of an `extension_inline` payload, and whether a payload may contain non-integer numbers.
- [x] Given identifiers, when the decision is recorded, then it states whether non-built-in definitions always use 16-character random identifiers (the example in 03 §12 uses `ps1`) and which half of a paragraph split in the middle keeps the identifier (03 §9 covers only splits at the start or end).
- [ ] Given the decision, when it is accepted, then 03 is updated and the definition (CDM-006) implements it; anything left undecided stays listed under Open questions.

**Evidence:** `docs/adr/0018-cdm-attribute-grammars.md` (status proposed) records the decisions; the values live once in `packages/model/src/definition/cdm1.ts`, and `spec/cdm/cdm-1.attributes.md` (generated) gives every attribute's type, range, length, pattern and default. Tests: `packages/model/src/schema/prose.test.ts` (every attribute named in the tables of 03 §4 and §5 is in the definition, and the reverse), `check-definition.test.ts` (generation fails for an attribute without a complete grammar or a default; every integer range lies inside the interoperable range of RFC 8785), `canonical-form.universal.test.ts` (defaults are omitted) and `validate.test.ts` (I11). Criterion 5 (references): ADR 0018, table rows "`field.target`", "`link.href`", "Uniqueness" and "`listId`", with the copy rule of `listId` from ADR 0032 section 2 (row "Copying a list", CDM-005); `packages/model/src/definition/reference-forms.test.ts` checks the target, href and listId grammars and the equation-label uniqueness (8 tests, passed 2026-11-13, Node.js). Existing tests cover the rest: `src/validate/inline.test.ts` (field targets, duplicate anchor names).

**Notes:** These are gaps found while writing this epic, not listed in 03 §13. The decision is a precondition for CDM-006, CDM-007 and CDM-010. See Open questions. Ticked on the strength of ADR 0018, which the project owner has not reviewed; the last criterion waits for acceptance and the update of 03. The fifth criterion was not met until CDM-005 recorded the copy rule of `listId` in ADR 0032 (proposed); it is now ticked on the same basis as the others, and the copy itself is not yet implemented or tested in the editing core (CDM-012). Checked again on 2026-11-15: ADR 0018 is still proposed and 03 does not yet cite it, so the last criterion stays unticked. It needs the owner's acceptance of ADR 0018 (and of the `listId` copy rule in ADR 0032); once that is given, 03 §2, §4, §5, §8, §9 and §11.2 are to be updated from the ADR and the open questions in its last section carried over. Nothing was built to work round this.

### CDM-003 Decide the canonical-form gaps

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Maintainer |

**Spec:** 03 §2; 07 §11 (approvals bind to the hash of a region's canonical content); 08 §3; 01 §8 · **Requirements:** R4, R7 · **Depends on:** CDM-002

As a maintainer, I want the remaining ambiguities of the canonical form closed, so that two implementations in different languages produce identical bytes for every document.

**Acceptance criteria**

- [x] Given the empty cases, when the decision is recorded, then it states whether an empty `content`, `marks` or `attrs` is omitted or written as `[]` or `{}` (the example in 03 §12 omits `content` on an empty paragraph).
- [x] Given the `requires` array, when the decision is recorded, then it states its order and uniqueness in the canonical form.
- [x] Given object-valued attributes (`width`, `numbering`, `levels`, `borders`, `grid`), when the decision is recorded, then it states whether defaults inside them are omitted.
- [x] Given that 07 §11 binds approvals to the hash of a region's canonical content, when the decision is recorded, then it defines the canonical form of a subtree or fragment, which 03 §2 gives only for the whole envelope.
- [x] Given that history and checkpoints store hashes for years, when the decision is recorded, then it states whether the canonical form carries its own version and where that version is stamped (commit metadata, checkpoints).
- [ ] Given the decision, when it is accepted, then 03 §2 is updated and CDM-010 and CDM-011 implement and fixture it.

**Evidence:** `docs/adr/0018-cdm-attribute-grammars.md` (status proposed), table "Canonical form". The rules are implemented in `packages/model/src/canonical/canonical-form.ts` (`canonicalNode` for subtrees, `CANONICAL_FORM_VERSION = 1`) and tested in `canonical-form.universal.test.ts`: empty `attrs`, `content` and `marks` omitted; `requires` sorted without duplicates; object-valued attributes kept whole; the hash of a region alone.

**Notes:** All gaps found while writing this epic. See Open questions. Ticked on the strength of ADR 0018, which the project owner has not reviewed; the last criterion waits for acceptance and the update of 03 §2. Stamping the version in commits and checkpoints is HIS's and BE's. Lane w1 (2026-11-15): blocked on the owner. ADR 0018 is still "proposed", so the condition "when it is accepted" of the last criterion has not happened and 03 §2 is left as it is; nothing new could be ticked. What the owner's acceptance unlocks: the edit of 03 §2 from the ADR's "Canonical form" table, then the tick once CDM-010 and CDM-011 are done.

### CDM-004 Decide whether citations and a bibliography enter CDM 1

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | should | Maintainer |

**Spec:** 03 §13; 11 §10 (item 6); PRODUCT.md (first market undecided) · **Requirements:** R1 · **Depends on:** SPK-006

As a maintainer, I want to know before the model is frozen whether the first market needs citations, so that they are either in version 1 or consciously left out.

**Acceptance criteria**

- [x] Given the first-market decision, when it is taken, then a decision record states whether citations and a bibliography are a version 1 requirement (03 §13: they map to `biblatex` if academic writing comes first).
- [x] Given the answer is yes, when it is recorded, then stories for the nodes, their invariants and their writer support are added to this epic before `cdm: 1` is frozen, and the writer-support table (CDM-046) gains rows for them.
- [ ] Given the answer is no, when it is recorded, then 03 §13 keeps them excluded and the record states that they can arrive only as a named feature in `requires` or in a later major version (03 §11).

**Notes:** No story for the citation nodes themselves is written, because the scope is undecided. If the answer is yes those stories would be phase 1b. Audit 2026-11-13: the third criterion is unticked because it covers the "no" branch, which was not taken (the Outcome below is yes and 03 §13 now includes citations), so nothing was done or tested for it; the owner may strike it as not applicable. Run 2026-11-15 (lane w1): checked again against 03 §13, 00 §155, 11 §10 item 6 and PRODUCT.md, which all record the yes answer. The criterion is conditional on a "no" that the owner did not give, so it cannot be met or tested and no decision record was written for it. It stays unticked until the owner strikes it or reverses the decision; ticking it or striking it is the owner's word, not a lane's.

**Outcome (2026-11-06):** yes. With all three markets in scope (SPK-006), citations and a bibliography are a version 1 requirement. 03 §13 is updated. CDM-052 defines the nodes, their invariants and the writer-support rows, and EXP-121, EXP-122, FE-140 and UX-103 build on it.

### CDM-005 Spike: settle the numbering and spacing semantics and write the fixtures

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | must | Maintainer |

**Spec:** 03 §7 ("to be completed with fixtures during phases 0 and 1"), §4.3; ADR 0004 (after the first review); review M-4, M-12 to M-14 · **Requirements:** R1, R5 · **Depends on:** CDM-002

As a maintainer, I want the layout semantics of 03 §7 pinned by fixtures that the editor and both writers can run, so that three engines do not disagree about numbers and gaps.

**Acceptance criteria**

- [x] Given the numbering inputs of 03 §7 (`numbering_def`, `numbering`, `listId`, `numberingRestart`, document order), when the spike ends, then a written recommendation fixes what 03 leaves implicit: the meaning of `restartAfter` and `numberingRestart`, skipped levels, templates that name a level not yet counted, which list instance a paragraph style's `numbering` joins, how `listId` behaves when a list is copied, and how footnote marks and `seq` captions are counted.
- [x] Given the spacing rules, when the spike ends, then the recommendation fixes whose `contextualSpacing` counts for a pair of paragraphs, what happens at the first and last paragraph of a cell, region, story and footnote, and whether a footer grows like a header.
- [x] Given each rule in 03 §7 (numbering, paragraph spacing, line spacing, header growth, tabs, field time zone), when the spike ends, then a fixture set in language-neutral JSON exists with input, expected labels or geometry, and at least one edge case per rule (a list across a region and a table, two lists on one definition, a restart, `legal`, `multiple` line spacing over mixed run sizes, a decimal tab with a leader).
- [ ] Given the fixtures, when the owners of the layout engine (FE) and the LaTeX class (EXP) review them, then each confirms the rule is implementable in their engine or lists the gap (for example per-line `multiple` spacing needs a callback in the class, 09 §3.1).
- [ ] Given the recommendation, when it is accepted, then 03 §7 is updated and the fixtures are added to `packages/model` for CDM-042 to CDM-045.

**Evidence:** `docs/adr/0032-layout-semantics.md` (status proposed) records the recommendation: §2 numbering (`restartAfter`, `numberingRestart`, skipped levels, templates that name uncounted levels, style numbering and its `listId`, the copy rule for `listId`, footnote marks, `seq` captions and numbered equations, and counter effects for hidden regions), §3 paragraph spacing (per-side `contextualSpacing`, container edges, regions), §6 footers growing like headers. Fixtures in `packages/model/fixtures/semantics/`, one file per rule, every case with an id and a one-line description: `numbering-lists.json`, `numbering-sequences.json`, `numbering-footnotes.json`, `numbering-references.json`, `numbering-projections.json`, `cascade.json`, `paragraph-spacing.json`, `line-spacing.json`, `tabs.json`, `header-growth.json`, `date-fields.json` and `whitespace.json`, with a list across a region and a table, two lists on one definition, restarts, `legal`, `multiple` over mixed run sizes and a decimal tab with a leader. `packages/model/src/cascade/semantics-fixtures.universal.test.ts` runs every file in Node.js, Chromium, Firefox and WebKit and validates every fixture document; `semantics-fixtures-list.test.ts` fails when a file is not run.

**Notes:** Time box: about one week (size M). The spec says the rules "are to be completed with fixtures during phases 0 and 1"; this spike starts that work in phase 0 and the algorithm stories finish it in 1b. The recommendation is ADR 0032 (proposed, 2026-11-06). Not met: (4) waits for the FE and EXP owners to review `packages/model/fixtures/semantics/`; each file has a `format` paragraph and each case a one-line description, and the documents are valid CDM documents. ADR 0361 (proposed, 2026-11-15) is a review record prepared for them: for each fixture file it says whether a test of `packages/layout` and of `packages/export-latex` runs it, and lists the gaps; `packages/model/test/semantics-fixture-consumers.test.ts` keeps the record in step with the test files. It found no rule that either engine cannot implement. The EXP owner has not confirmed the record, so (4) stays unticked. (5) waits for the owner's acceptance and the update of 03 §7; the fixtures are already in `packages/model`. Questions left to the owner in ADR 0032: whether numbering indents override style indents, as in Word, instead of the reverse order of 03 §6 (S7 question 2); and which numbers readers of a projection see (SR-C3). Both choices work with the code as it is.

## Definition and published artifacts

### CDM-006 Define the CDM once and generate everything else from it

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 03 §1 (principles 1, 2), §3 to §5, §11.2; 01 §6; ADR 0004 · **Requirements:** R6 · **Depends on:** CDM-002

As a maintainer, I want one declarative definition of every node, mark, attribute, content expression and feature, so that the TypeScript types, the JSON Schema and the ProseMirror schema cannot drift apart.

**Acceptance criteria**

- [x] Given the definition in `packages/model`, when the generators run, then they emit the TypeScript types, the JSON Schema (CDM-007), the ProseMirror schema (CDM-008) and the node and attribute tables used by documentation; no second hand-written copy of any of them exists.
- [x] Given an attribute with no type, range, length or pattern, or no default, when generation runs, then it fails and names the attribute (I11 needs a grammar for every attribute; the canonical form needs the default).
- [x] Given the node, mark and attribute names in the tables of 03 §3 to §5, when the prose check runs in CI, then a name present in the prose and missing from the definition, or the reverse, fails the build (the JSON Schema is "checked against the prose", root README).
- [x] Given the generated types, when a consumer reads a CDM document with only those types and a JSON parser, then it needs no ProseMirror import: the type entry point of the package has no dependency on ProseMirror (principle 2).
- [x] Given each node and mark, when the definition is read, then it is tagged as core or as belonging to a named feature (`fields`, `extensions`), and that tag drives `requires` (CDM-009, CDM-047).
- [x] Given the package's unit tests, when they run in Node.js, then they pass without a DOM, and the package imports no Node-only or browser-only API, because the authority (01 §6) runs the same code in rooms, workers and tests.

**Evidence:** `packages/model/src/definition/cdm1.ts` is the one definition; `scripts/generate.ts` writes the types, the JSON Schema, the ProseMirror schema, the attribute table and the manifest, and the engine builds its editing schema from it (`buildSchema`). Tests: `src/schema/artifacts.test.ts` (complete definition; artifacts byte-equal to a fresh generation), `src/schema/check-definition.test.ts` (an attribute without a grammar, a default, a length, a range inside the interoperable range, values, an anchored pattern or a size bound fails generation and is named), `src/schema/prose.test.ts` (the nodes, marks and attributes of the tables of 03 §3 to §5 against the definition, both ways, and the `block` group), `test/boundaries.test.ts` (the type entry points load no ProseMirror module; the package refuses Node.js and browser APIs), `src/validate/validate.test.ts` and `read.test.ts` (feature tags drive I1 and the reader). All run in Node.js without a DOM (`pnpm test`, which CI runs; CI has not run yet).

**Notes:** Phase 0 because the schema artifact is a phase 0 deliverable. Everything in 03 §4 and §5 is defined here in structure; the stories below add the invariants, resolvers and fixtures for each family. The prose check found one difference and allows it by name: the definition gives `preserved` to the inline atoms `image`, `equation`, `footnote` and `field`, which 03 §4.6 does not list and ADR 0017 leaves to spike S11 ("Inline atoms without identifiers"). Not decided here; see CDM-051.

### CDM-007 Publish the CDM JSON Schema

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 0 | M | must | Integrating developer |

**Spec:** 03 §2, §3 to §5, §8 (I1, I11), §12; root README; 05 §11; 11 §2 (S6); ADR 0008 · **Requirements:** R6, R10 · **Depends on:** CDM-006

As an integrating developer, I want a published JSON Schema for CDM documents, so that I can read, produce and validate documents in my own language without ProseMirror.

**Acceptance criteria**

- [x] Given the example of 03 §12, when it is validated against the schema, then it passes; and when `cdm` is missing, a node or mark type is unknown, the envelope carries an extra key (a title, an owner, a timestamp), or any number is not an integer, then validation fails.
- [x] Given an attribute with an enumeration, a range, a length bound or a pattern, when a value outside it is validated, then validation fails, with one negative case for each of the four kinds (I11).
- [x] Given the invariants that JSON Schema cannot express (I2 to I6, I8, parts of I7 and I10), when someone reads the artifact, then its description lists them and points to `model.validate()` (CDM-013); no document is called valid on the schema alone.
- [x] Given a document containing a node or mark that stands for a comment, when it is validated, then it fails: comments live outside the document (03 §4.4; ADR 0015).
- [x] Given a standard JSON Schema validator in a language other than JavaScript, when it validates the example and the negative cases, then it returns the same verdicts.
- [x] Given a release of the CDM, when CI runs, then the artifact under `spec/` is byte-equal to a fresh generation and names the `cdm` major version it describes.

**Evidence:** `packages/model/src/schema/artifacts.test.ts`: Ajv (draft 2020-12, strict) accepts the 03 §12 example and refuses a missing `cdm`, a comment node, a comment mark, an extra envelope member, a non-integer, and one value outside an enumeration, a range, a length and a pattern; Python's `jsonschema` gives the same verdicts (ran on 2026-11-06 with Python 3.11.9 and jsonschema 4.21.1); the description lists I1 in part, I2 to I6, I7 in part, I8 and I10 in part and points to `model.validate()`; `spec/cdm/cdm-1.schema.json` equals a fresh generation and its `$id` is `urn:docedit:cdm:1:draft`. `.github/workflows/ci.yml` also regenerates and diffs `spec/`.

**Notes:** Phase 0 deliverable (root README; spike S6, SPK-019). Published as a draft until CDM-001 and CDM-002 are recorded. Closed envelope inferred from 03 §2 ("metadata is not part of the CDM"). The Python check skips where Python or jsonschema is missing, so the CI runner needs both for it to run there; CI has not run yet.

### CDM-008 Generate the ProseMirror schema from the definition and publish it

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 03 §3, §4, §5, §9, §11.2; 02 §5.2; 04 §4; 11 §2 (S1) · **Requirements:** R1, R7 · **Depends on:** CDM-006, CDM-001

As a maintainer, I want the ProseMirror schema generated from the definition and published as a normative artifact, so that the editor, the authority and every other implementation apply steps against the same schema.

**Acceptance criteria**

- [x] Given the definition, when the generator runs, then the schema spec is emitted as JSON and published with a content hash; changing a node, mark, attribute, content expression or the order of the mark list changes the hash (applying a step depends on the schema, 04 §4; the mark order also feeds the canonical form, 03 §2).
- [x] Given any node type that declares an `id`, when ProseMirror creates it (including through `createAndFill`), then `id` defaults to null and nothing throws; invariant I2 catches nulls at the end of a commit (CDM-013).
- [x] Given `defs` and `story` nodes, when the schema is inspected, then they are isolating, not selectable and closed to the gap cursor; `region` is isolating (03 §3, §4.2).
- [ ] Given the suggestion marks, when the schema is inspected, then `ins`, `del` and `fmt` do not exclude other marks of the same type and are allowed as node marks on `paragraph`, `table_row` and `table` only, so `addNodeMark` and `removeNodeMark` steps (04 §4) apply there and nowhere else.
- [x] Given every node and mark, when the schema is inspected, then each declares `ext` with default `{}` (CDM-048).
- [x] Given the example of 03 §12 and the fixtures, when a document is read into ProseMirror and written back, then the JSON equals the input after canonicalisation.
- [x] Given the `footnote` node, when the schema is inspected, then its content expression is the one decided in CDM-001.
- [x] Given the 300 KB compressed target for the first interactive editor (13 §9), when the bundle report runs, then the size contributed by `packages/model` is listed separately.

**Evidence:** `spec/cdm/cdm-1.prosemirror.json` with its hash in `spec/cdm/cdm-1.manifest.json`. `packages/model/src/prosemirror/schema.test.ts`: the hash changes when a node or a mark is removed, an attribute is added, a default or a content expression changes, or the mark order changes; every node type that declares an `id` is created by `createAndFill` with a null `id`, and a stored null is I2 (`validate.test.ts`); `defs` and `story` are isolating, not selectable and closed to the gap cursor, `region` is isolating; every node and mark declares `ext` with default `{}`; the 03 §12 example and `fixtures/kitchen-sink.json` read and write back to the same canonical JSON. Criterion 7: the footnote is `paragraph+` as CDM-001 decided (`src/prosemirror/schema.test.ts`, "uses the footnote content model decided in CDM-001"; `src/validate/inline.test.ts`). Criterion 8: `packages/element/scripts/bundle-report.ts` (`packageShares`, `firstInteractiveByPackage`) splits the first interactive editor by package from the bundler's rendered module lengths, and `scripts/build.ts` passes those lengths in; the report prints one row per package and writes them to `dist/lib/bundle-report.json` (`packages/element/test/cdm-008-bundle-report.test.ts`). Measured 2026-11-15 on this machine by `pnpm --filter @docedit/element build` in the w1 worktree: `@docedit/model` 78,866 bytes rendered before minification, 6.4 % of the first interactive editor (host backend, 239.2 kB gzip in all), about 18.8 kB gzip as an estimate (each chunk's gzip size split by rendered length).

**Notes:** Phase 0 because spike S1 tests this schema (null-default identifiers, non-selectable definitions, the footnote model) and 04 §4 pins step semantics to it; phase inferred. Phase 1a uses the subset the demo needs. The body-scoped "select all" and the region guard are FE's. The engine definition file that pins this artifact is SYN-002. Bundle target is checked by FND-008. Not met: (4) ProseMirror allows node marks on every child of a node that permits them, so the schema cannot limit them to paragraphs, rows and tables; ADR 0018 (proposed) moves that limit to `model.validate()` (I1), and the authority refuses an `addNodeMark` step on a region (`packages/authority/test/room-scenarios.test.ts`), but the inspected schema meets the criterion only if the owner accepts that reading. Lane V-CDM-001-027 (2026-11-13) found no per-package figure in the bundle report. Lane w1 (2026-11-15) added it to the element's report for (8); the per-package gzip figure is an estimate, because a minified chunk cannot be split exactly by package. (4) stays open for the owner's reading of ADR 0018: nothing in the code can settle it.

## Envelope, canonical form and hashing

### CDM-009 Refuse a document the reader cannot fully understand

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | S | must | Integrating developer |

**Spec:** 03 §2, §11.1; 05 §5.2, §5.8; review M-5 · **Requirements:** R6, R7 · **Depends on:** CDM-006

As an integrating developer, I want a reader that refuses a document it cannot fully understand, so that nothing in a document is silently dropped or misread.

**Acceptance criteria**

- [x] Given an envelope whose `requires` lists a feature the reader does not know, when it is read, then reading fails with an error that has the code `unsupported_feature` and a message naming each missing feature, and no document is returned (a reader that lacks a feature MUST refuse the document with a clear message).
- [x] Given the same envelope, when it is read, then the ProseMirror parser is never called for it: `requires` is checked before parsing (a ProseMirror-based reader MUST check `requires` before parsing, because it throws on unknown node types and marks).
- [x] Given a `cdm` major version above the highest the reader supports, when it is read, then reading fails with the code `unsupported_cdm` and a message naming both versions.
- [x] Given a document that contains a node type or mark of a feature but whose `requires` omits that feature, when it is read, then reading reports an I1 violation instead of opening the document and dropping the content (the reader MUST NOT open it and drop what it does not understand).
- [x] Given an envelope with a title, owner, timestamp or any other top-level key, when it is read, then it is invalid: metadata belongs to the document resource in the control plane.
- [x] Given a valid document at a supported version, when it is read and written back, then the canonical form of the result equals the canonical form of the input.

**Evidence:** `packages/model/src/validate/read.ts` (`readDocument`, `writeDocument`, `supportedVersions`, exported from `@docedit/model/validate`) and `read.test.ts`: unknown features are refused with `unsupported_feature`, naming each, and no document; a spy on the schema shows `nodeFromJSON` is not called; `cdm: 2` is refused with `unsupported_cdm`, naming version 2 and version 1; a `form_field` without `fields` in `requires` is reported as I1; an envelope with `title`, `owner`, `createdAt` or any other member is refused; the 03 §12 example and `fixtures/kitchen-sink.json` read and write back to the same canonical form.

**Notes:** Phase inferred: the minimum demo stores `cdm` and `requires` from the start (06 §4.1 columns), and the first reader must already refuse unknown versions; the feature check has little to refuse until fields and extensions arrive in 1b (see CDM-047). `unsupported_feature` and `unsupported_cdm` are the DEP error codes (05 §5.8); the gateway maps them to a channel rejection (PRO-023). Closed envelope inferred from 03 §2. A document that fails validation is refused with the registry code `validation_failed` and its list of violations; that choice is the reader's, and PRO-023 maps it for each surface.

### CDM-010 Compute the canonical form and the document hash

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 03 §1 (principle 7), §2; 01 §8; 04 §13; 06 §2.2; 08 §3; ADR 0004 (after the first review) · **Requirements:** R4, R7 · **Depends on:** CDM-002, CDM-003, CDM-008

As a maintainer, I want one function that turns a document into its canonical bytes and its hash, so that checkpoints, divergence checks, approvals and exports agree across programming languages.

**Acceptance criteria**

- [x] Given an envelope, when it is canonicalised, then the output is the RFC 8785 serialisation of the envelope in UTF-8, and the document hash is the SHA-256 of those bytes.
- [x] Given an attribute whose value equals its schema default (including `ext` equal to `{}` and `id` equal to null), when the document is canonicalised, then the attribute is omitted, and the same document with the attribute written explicitly gives the same bytes.
- [x] Given text carrying several marks added in different orders, when it is canonicalised, then the marks are ordered by their position in the schema's mark list and then by the canonical serialisation of their attributes, including two `ins` marks from different users on the same text.
- [x] Given adjacent text nodes with equal marks, when the document is canonicalised, then they are merged; given unequal marks, they stay separate.
- [x] Given a number that is not an integer, or lies outside the integer range fixed in CDM-002, anywhere in the envelope (an attribute, `ext`, an extension payload), when the document is canonicalised, then canonicalisation fails with a typed error instead of writing a float.
- [x] Given two semantically equal documents reached through different histories (a property test with random edits, splits, joins and mark orders), when they are hashed, then the hashes are equal.
- [x] Given a document at the 16 MiB limit, when it is canonicalised and hashed in a worker, then the elapsed time and peak memory are recorded by the performance harness; the spec gives no target for this.

**Evidence:** `packages/model/src/canonical/canonical-form.ts` and `canonical-form.test.ts`: RFC 8785 bytes in UTF-8 hashed with SHA-256 (checked against `node:crypto`); defaults written out (`ext: {}`, null `id` and other nulls, settings defaults) give the same bytes; marks ordered by the schema list then their attributes, two `ins` marks of two users included; adjacent equal text merged, unequal kept apart; a float or an out-of-range integer in an attribute, `ext`, a payload or a mark is a `CanonicalizationError` naming its path; a fast-check property (200 runs, seed 20261106) gives equal hashes for random splits, joins, reversed mark orders and ProseMirror edits that cancel out. Criterion 7: the performance harness (FND-007) records it. `node packages/perf/scripts/model-costs.ts`, run on 2026-11-06 on the reference machine of ADR 0037 (Intel Core i9-10900KF, Windows 11, Node.js 22.18; other agents' work shared the machine), wrote `packages/perf/test-results/model/2026-11-06T17-31-33Z.json`: `pages-1000` with its body's blocks repeated to 16,612,548 canonical bytes (just under 16 MiB), canonicalised and hashed in a `worker_threads` worker in a fresh process: canonical form 2,130 ms, UTF-8 encoding 50 ms, SHA-256 71 ms; the worker's heap 80.8 MB after parsing and 289.0 MB after; the process's peak resident memory rose from 507.8 MB to 817.3 MB. The same on `pages-100` (582,181 bytes: 73, 1.5 and 7.2 ms), `pages-300` (1,700,893 bytes: 205, 3.5 and 8.0 ms) and `pages-1000` (5,661,305 bytes: 735, 16 and 20 ms). One run each.

**Notes:** Phase inferred: first needed by checkpoints (06 §2.2), the optional `sync.check` (SYN-043) and region approvals (PRM-046, PRM-047), which arrive with the stage 1 deployment in 1b; the 1a demo needs only the commit-log hash chain (08 §2). The WebAssembly assessment of 2026-11-06 (hot path 7) keeps this in TypeScript and off the event loop. The harness is FND-007; it recorded criterion 7 on 2026-11-06 (Evidence).

### CDM-011 Publish the canonical-form hash fixtures

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | must | Maintainer |

**Spec:** 03 §2 ("The conformance kit carries hash fixtures"), §1 (principle 7); 05 §11 · **Requirements:** R6 · **Depends on:** CDM-010, CDM-003, and the node and mark stories CDM-016 to CDM-040

As a maintainer, I want language-neutral hash fixtures covering the whole model, so that a second implementation can prove it computes the same canonical bytes.

**Acceptance criteria**

- [x] Given the definition, when the fixtures are listed, then at least one document uses every node type, mark and `field` kind of CDM 1, each with its canonical bytes and SHA-256 stored as files that need no TypeScript to read.
- [x] Given each canonical rule (default omission, mark order, text merging, `ext`, the empty cases of CDM-003), when the fixtures are listed, then each rule has input and expected-output pairs.
- [x] Given an independent implementation in a language other than TypeScript, kept in the kit's CI, when it canonicalises the fixture inputs, then its bytes equal the expected bytes.
- [x] Given a change that alters the expected output of an existing fixture, when CI runs, then it fails unless the release declares a canonical-form change (CDM-003).
- [x] Given the kit, when it is built, then the fixtures are exported in the kit's format.

**Evidence:** `packages/model/fixtures/canonical` (written by `scripts/canonical-fixtures.ts` through `pnpm generate`): `index.json` lists each input, its exact canonical bytes (`expected/*.jcs`) and their SHA-256; the `all-constructs` input uses every node type, mark and `field` kind of CDM 1 and validates; every rule of 03 §2 and CDM-003 has a case. `src/canonical/fixtures.test.ts` checks the bytes and hashes, the coverage, and that the stored `canonicalFormVersion` equals `CANONICAL_FORM_VERSION`; the generator refuses a changed output for an unchanged input under the same version. An independent Python implementation (`packages/model/conformance/canonical.py`, reading only `spec/cdm/cdm-1.prosemirror.json`) reproduces every byte (ran on 2026-11-06 with Python 3.11.9). On 2026-11-13 `python -I packages/model/conformance/canonical.py spec/cdm/cdm-1.prosemirror.json packages/model/fixtures/canonical/index.json` reported bytes and SHA-256 equal for all ten cases (exit 0), and `src/canonical/fixtures.test.ts` passed 5 of 5. The `conformance-kit` job of `.github/workflows/ci.yml` runs the same command; that job has not yet run in CI, which this entry does not observe. Criterion 5 (lane U-CDM-001-027, 2026-11-13): the kit ships a copy of the set in `packages/tck/fixtures/canonical/` (`index.json`, `inputs/`, `expected/`, `README.md`), written byte for byte by `packages/tck/scripts/canonical-copy.ts` through the kit's `generate` script, the same way the rules fixtures are shipped (PRO-123). `packages/tck/test/canonical-copy.test.ts` passed 4 of 4 (Node.js, `pnpm exec vitest run`): the copy is complete, every SHA-256 in the index matches the bytes on disk, the documented format holds, and the copy equals a fresh one. The kit's Containerfile copies `packages/tck/fixtures`, so the built image carries the set. The format is the spec default by precedent, recorded as proposed in `docs/adr/0352-lane-U-CDM-001-027.md`.

**Notes:** Phase 1b because it needs the complete model; the canonical function itself is CDM-010. (3) is met: the independent implementation exists (`packages/model/conformance/canonical.py`, run by `src/canonical/fixtures.test.ts` when Python is installed), but the kit does not yet exist; (3) is ticked on the local run and the presence of the `conformance-kit` CI job (first CI run not observed, 2026-11-13); (5) is ticked on the kit's copy of the set (lane U-CDM-001-027, 2026-11-13). The kit's format is not defined anywhere else; the lane took the precedent of the rules fixtures (PRO-123) as the spec default, and the owner of the kit (ADR 0042) may change it.

## Identifiers

### CDM-012 Keep node identity stable through split, join, copy and paste

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Author |

**Spec:** 03 §1 (principle 6), §8 (I2), §9; 07 §5.2 (P5); 02 §5.2; review M-16 · **Requirements:** R3, R4 · **Depends on:** CDM-008, CDM-013

As an author, I want blocks and regions to keep a stable identity when I split, join, copy and paste, so that permissions, history, diagnostics and block comments stay attached to the right content.

**Acceptance criteria**

- [x] Given the identifier generator, when it is called one million times in a test, then every result is a 16-character string over the URL-safe Base64 alphabet, drawn from a cryptographically secure random source, with no duplicate.
- [x] Given a transaction that creates nodes whose `id` is null (the schema default), when the identifier plugin runs, then every such node has a non-null `id` set in the same transaction, and no editor state exists in which a node type that declares an `id` has null.
- [x] Given a paragraph, when Enter is pressed at its start, then the new empty paragraph gets a fresh `id` and the paragraph that holds the content keeps its own; when Enter is pressed at its end, the paragraph that holds the content keeps its `id` and the new empty one gets a fresh `id`.
- [x] Given a paragraph split in the middle, when the split happens, then exactly one half keeps the original `id` and the other gets a fresh one, as decided in CDM-002.
- [x] Given content copied by pasting or duplicating, when it is inserted, then every node in the copy, regions included, gets a fresh `id`.
- [x] Given the result of a commit in which a node's non-null `id` differs from the `id` it had before (by an `attr` step or by replacement), when it is validated with the previous document, then I2 is reported ("a non-null `id` never changes").
- [x] Given the result of a commit in which two nodes share an `id`, or a node type that declares an `id` has none, when it is validated, then I2 is reported.

**Evidence:** `packages/model/src/conventions/ids.test.ts`: a million identifiers, each 16 characters of URL-safe Base64 from 12 bytes of `crypto.getRandomValues`, without a duplicate. I2: `packages/model/src/validate/validate.test.ts` ("I2: identifiers present and unique", "two regions with one identifier") and `packages/authority/test/invariants.test.ts` ("refuses a split that leaves two nodes with one identifier"). Engine side (2026-11-06): `packages/engine/src/ids.ts` (ADR 0018) and `packages/engine/src/core.test.ts` ('fills a null id in the same state update', 'Enter at the start…', 'Enter at the end…', 'a split in the middle keeps the id in the first half', 'every node of a copied region gets a fresh id, the region included', 'a pasted copy…'); random 16-character URL-safe Base64 ids also in Chromium, Firefox and WebKit (`packages/engine/src/sync.universal.test.ts`). Criterion 6 (lane w1, 2026-11-15): `packages/authority/src/invariants.ts` (`identityChange`, `sameNodeMarkup`) with `packages/authority/test/invariants.test.ts`: "refuses changing the identifier of its only holder (I2, P5)" (an `attr` step), "refuses changing the identifier by replacing the node around its content (I2; ADR 0362)" (the `replaceAround` step of `setNodeMarkup`, on a paragraph and on a region) and "accepts a replacement around the content that keeps the identifier, or that a later step removes"; the authority's Node.js suite, 1,006 tests, passed.

**Notes:** Review M-16 (identifier on the wrong half of a split). The plugin is listed as an editing-core building block in 02 §5.2 and wired by FE; this story owns the rules and a plugin implementation in `packages/model` that FE mounts. The rule for a split in the middle is open (see CDM-002). Foreign identifiers are stripped on paste by the clipboard (02 §5.2), which is FE's. Cross-check: the clipboard stories (FE-050, FE-051, FE-054) apply these rules to pasted content and depend on this story. The identifier plugin of criteria 2 to 5 is in `packages/engine/src/ids.ts` (FE's package, rules of ADR 0018); its tests are the evidence (2026-11-06). The editing core also refuses a local change of a non-null `id` before it is sent (`packages/engine/src/guard.ts`, P5), which does not settle criterion 6. Criterion 6 holds for attribute steps only (`packages/authority/test/invariants.test.ts`, "refuses changing the identifier of its only holder"): a change by replacement, such as the `replaceAround` that `setNodeMarkup` makes, reaches the authority as one node removed and another created, and 03 does not say how to tell that from a real deletion. Open question, not decided here. Lane w1 (2026-11-15): ADR 0362 (proposed) reads "by replacement" as the one replacement that is not ambiguous, a `replaceAround` step that replaces one node around its whole content (what `setNodeMarkup` makes); the authority now refuses it with I2 under the same outcome rules as an `attr` step, and criterion 6 is ticked on that reading. Any other replacement (a `replace` step, wrapping, lifting, a leaf) stays a removal and a creation. Whether those should also count is the owner's question, listed in ADR 0362; if the owner widens the reading, the criterion needs more work.

## Validation and invariants

### CDM-013 Build `model.validate()` and the invariant engine

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 03 §8 (I1 to I5, I7, I11, and the engine for the rest); 04 §4, §5 (step 6), §12; 06 §8; 12 §3.6 · **Requirements:** R7, R10 · **Depends on:** CDM-002, CDM-006, CDM-008

As a maintainer, I want one validator that checks the invariants on the result of any commit, so that the authority can reject a document that violates them whatever the step type.

**Acceptance criteria**

- [x] Given a document, when `validate` is called, then it returns the list of violations, each with the invariant identifier, the path and node `id`, and a stable code; the list is empty for a valid document. It runs I1 to I12 and any invariants other packages register (I13 to I15 from FRW).
- [x] Given the result of a commit made by any step type the authority accepts (`replace`, `replaceAround`, `addMark`, `removeMark`, `addNodeMark`, `removeNodeMark`, `attr`), when it is validated, then every invariant is checked on the resulting document, so that an `attr` or mark step cannot produce a document that a position-based check would miss.
- [x] Given a document, when I1 is checked, then a document that does not match the schema for its `cdm` version and its `requires` list is reported; and given the canonical size, the nesting depth or the number of regions beyond the limits of I7 (16 MiB, depth 12, 500 regions), the violation is reported.
- [x] Given a value that does not match the grammar declared for its attribute (type, range, length or pattern), when it is validated, then I11 is reported with the attribute's path.
- [x] Given a reference in the 1a subset (`style`, `basedOn`, `next`, `pageSetup`), when it names nothing, then I4 is reported; and given a definition that is still referenced, when a commit deletes it, then I4 is reported.
- [x] Given invariants that need more than the document (I2 "never changes" needs the previous document, I3 "ever removed" needs the retired region identifiers, I4 needs the attached assets, I8 needs the math gate), when the caller supplies that context, then these checks run; when it does not, the result lists them as not evaluated instead of passing them silently.
- [ ] Given a typical single-paragraph commit on a 100-page reference document, when it is validated, then the CPU cost is well under one millisecond (target, 04 §12), reported by the performance harness.
- [x] Given a hostile input (nesting beyond 12, a 16 MiB array), when it is validated, then validation returns I7 promptly without unbounded recursion or memory.

**Evidence:** `packages/model/src/validate/validate.test.ts`: I1 for the top-level structure, the schema and `requires`; I7 for 501 regions (500 pass), a canonical size over 16 MiB and nesting deeper than 12; I11 with the path of the attribute; I4 for `style`, `basedOn`, `next`, `body.pageSetup`, `section_break.pageSetup` and a deleted style still in use; 100,000 nested regions return I7 (the walk stops at depth 12 and the parser is not called) and a 16 MiB array in `ext` returns I11. Every step type: `packages/authority/test/room-scenarios.test.ts`, "checks the result of all seven step types" (a removal cannot break a valid document, so that case shows a commit ending in a removal is still validated in full). Criteria 1 and 6: `src/validate/types.ts`, `codes.ts`, `registry.ts`, `built-in.ts` and `validate.ts`; `src/validate/engine.test.ts`: every violation has the invariant, a stable code from `VIOLATION_CODES` (published as `spec/cdm/cdm-1.violations.json`), the JSON Pointer and the node id; `registerInvariant()` and `context.invariants` run other packages' checks, a throwing or undeclared check gives `check_failed`; FRW's I13 to I15 run through the same interface; I2 "never changes" runs with `identifierChanges`, I3 with retired identifiers, I4 with attached assets, I8 with the gate (and only on new LaTeX with `previous`), and each is listed in `notChecked` without its context. Criterion 8 (lane w1, 2026-11-15): `validate.ts` counts a lower bound of the canonical size before and during the walk (`nodesOverLimit` for nodes and text, `jsonSizeOver` for one attribute value, both without recursion and stopping at the limit) and returns I7 (`canonical_too_large`) there, with the checks it skipped listed in `notChecked`; a `requires` list longer than the feature list is reported once, and children that are not node objects at most 16 times per array. `validate.test.ts`, each with a 2 s bound on `validate()` alone: "I7: a 16 MiB array in `ext` is refused promptly…" (I7 only, at the attribute path), "I7: 16 MiB of nested arrays and of long keys…", "I7: two million empty paragraphs…", "I1: a 16 MiB array that is not content or not features…", "I7: returns promptly for hostile nesting…" (unchanged), and "the size bound never refuses a document below the limit". Whole test times in Node.js 22 on the lane's Windows machine, building the input included: 127 ms, 544 ms, 154 ms, 404 ms and 40 ms (`pnpm exec vitest run --project node packages/model/src/validate`, 244 tests passed).

**Notes:** Phase 1a: the minimum demo needs the authority to reject invalid commits (S3 runs against the real service in 1a), for paragraphs, styles and regions; the invariants for the other families are added by their stories. The target implies the validator checks changed subtrees using indexes; the spec does not say how. The authority calls this at step 6 and rejects with `invalid_op` (SYN-011). FRW registers I13 to I15 (FRW-001, FRW-002, FRW-005, FRW-015). The harness is FND-007. The codes, the registration point and the context for "a non-null `id` never changes" are recorded in ADR 0031 (proposed) section 1; I9, I12 and the `latex` and column limits of I7 are attribute grammars reported under their own invariants (section 2). Not met: (7) needs the harness of FND-007, and validation is not incremental yet: `validate()` checks the whole document. Unticked by audit (2026-11-13): criterion 8, because `validate()` on a 16 MiB array in `ext` took about 11.6 s in Node.js (`validate.test.ts`, "I11: returns for a 16 MiB array in `ext`…", which has no time bound and asserts I11, not I7); the grammar walk (about 4 s) and the canonical-size check (about 3 s) do the work item by item, so the input is not rejected promptly. The 100,000-deep nesting case (190 ms) and a 16 MiB string (170 ms) are prompt. Lane w1 (2026-11-15): criterion 8 is met and ticked again, see Evidence; the 16 MiB array in `ext` is now I7 and not I11, because the size is checked before the grammar. One case is left as it was: a `marks` array of millions of entries is still read entry by entry, because 03 does not say whether the canonical form keeps a malformed mark, so no lower bound is claimed for it. Criterion 7 stays open: `validate()` still checks the whole document on every commit, so its cost grows with the document and cannot be "well under one millisecond" for a commit on 100 pages; it needs a validator that checks only changed subtrees (the spec does not say how), and then a run of the FND-007 harness.

### CDM-014 Provide negative fixtures for every invariant and every step type

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 03 §8; 04 §4, §5; 05 §11; 10 (corrupting the document) · **Requirements:** R7, R10 · **Depends on:** CDM-013; SYN-011; PRO-110

As a maintainer, I want a fixture set that shows each invariant being violated and each limit at its boundary, so that every implementation of the authority rejects what 03 §8 says it must reject.

**Acceptance criteria**

- [x] Given each invariant I1 to I12, when the fixtures are listed, then each has at least one failing fixture.
- [x] Given each numeric limit, when the fixtures are listed, then each has a passing and a failing boundary: 500 and 501 regions, 63 and 64 table columns, nesting depth 12 and 13, `basedOn` depth 10 and 11, `latex` of 4,000 and 4,001 characters, canonical size at and above 16 MiB, an extension payload of 16 KiB and above.
- [x] Given a failing fixture, when it is read, then it is a base document plus the commit's steps in step JSON plus the expected invariant identifiers, with fixtures for each of the seven step types wherever that type can reach the invariant.
- [x] Given the authority applies a failing fixture, when step 6 runs, then the commit is rejected with `invalid_op` and nothing is stored.
- [x] Given each failing fixture, when `model.validate()` runs on its result, then it returns exactly the expected invariant identifiers.
- [x] Given FRW's I13 to I15, when their fixtures are added, then they use the same format without changing it.

**Evidence:** `packages/model/fixtures/invariants/cases/*.json` (48 fixtures, written by `scripts/invariant-fixtures.ts`): a base document, the steps in step JSON, the context and the exact invariants, for every invariant I1 to I15, both sides of every limit (500/501 regions, 63/64 columns, depth 12/13, basedOn 10/11, latex 4,000/4,001, canonical size at and past 16 MiB, payload 16 KiB and one byte more, 2,000/2,001 fields) and all seven step types. `src/validate/invariant-fixtures.test.ts` replays each with prosemirror-transform and checks that `validate()` returns exactly the expected invariants; I13 to I15 use the same format. Criterion 4 (lane V-CDM-001-027, 2026-11-13; UNTICKED by review, V group 2 round 1: the test is hollow. Every one of the 41 submissions uses the commit id `cdm014-<name>`, which is not a UUID version 7, so the Room refuses all of them at the id check with the reason "a commit needs a UUID version 7 id" before step 6 runs; no invariant is exercised. The test must use a valid UUID v7 id per fixture and also check that the reason names the expected invariants): `packages/authority/test/cdm-014.room-refusal.test.ts` submits each of the 41 failing fixtures to a Room (the fixture's base document and requires, the owner's connection, `Room.submit` at base 0) and checks for `sync.reject` with `invalid_op`, a null `write` (nothing for storage) and an unchanged document (Vitest in Node, 42 of 42 passed). **Fixed and re-ticked (V group 2 fixer, round 1, 2026-11-13):** each submission now carries a valid UUID version 7 id (checked with `isUuid7` in the test), and the test asserts that the reject reason does not mention the id and names at least one of the fixture's expected invariant identifiers, which only step 6 (`checkInvariants`) writes into a reason. The Room is given the fixture's context (retired region ids, attached assets, the math gate) and commit limits high enough that the canonical-size fixtures are not refused at step 1 with `too_large`. The 39 fixtures with steps go through `Room.submit` from the owner's channel at base 0; the 2 with no steps (`i7-depth-12`, `i7-depth-13`, a hostile stored document no step can make) go through `Room.snapshot` as an import over the valid example document, whose step 6 checks the whole content. `pnpm vitest run packages/authority/test/cdm-014.room-refusal.test.ts`: 42 of 42 passed (1 listing test and the 41 failing fixtures; the fixture set has 48 cases, 41 failing and 7 passing).

**Notes:** The authority's rejection is exercised by the authority's tests and the kit; this story supplies the fixtures and the format. Criterion (4) was found not met by review (V group 2 round 1): the lane's Room test was refused at the commit id check, not by the invariants; fixed in the same round, see the Evidence. "Nothing is stored" is shown by the Room returning no write (the storage contract the Room writes through) and, lane V-CDM-001-027 round 2, by a run against PostgreSQL: `services/document-service/test/postgres/cdm-014.room-refusal.pg.test.ts` (4 of 4 passed, PostgreSQL in Podman, Node project) refuses all failing fixtures with `invalid_op`, returns no write, and leaves the commit log empty; a valid control commit through the same path is stored (one row). `validate()` gives each its expected codes (`src/validate/invariant-fixtures.test.ts`). Lane U-CDM-001-027 (2026-11-13): `packages/authority/test/cdm-014.failing-fixtures.test.ts` replays all 48 fixtures through the authority's `applySteps` and `checkInvariants` (step 6): the 42 failing ones are refused with `invalid_op` or `field_invalid`, and the 6 passing sides of limits are accepted (Vitest in Node, 49 of 49 passed). That covers the rejection code only. "Nothing is stored" needs the Room (`Room.submit`, `test/room-commits.test.ts`), and a probe with the example document gave no write or acknowledgement without the fixtures' own permissions, so the storage half was left open by lane U (SYN-011, PRO-110); lane V-CDM-001-027 closes it with the in-memory storage harness (see Evidence).

### CDM-015 Fuzz the readers and the validator

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 03 §8 (I1, I7, I11); 06 §8; 10 (stalling or crashing a process that hosts many rooms); 11 §2 (S3) · **Requirements:** R10 · **Depends on:** CDM-009, CDM-013; SPK-016

As a maintainer, I want the readers and the validator fuzzed, so that a hostile document or commit cannot crash or stall a process that hosts many rooms.

**Acceptance criteria**

- [x] Given documents generated from the definition (random trees, boundary sizes, deep nesting, repeated marks, very long strings), when each is read and validated, then it ends with a result or a typed error within a time limit, never an uncaught exception and never unbounded memory.
- [x] Given hostile strings in every attribute grammar context (TeX specials, characters that break a CSS declaration, control and bidirectional override characters, URL tricks), when they are validated, then each is rejected by its grammar (I11) or accepted only where the grammar allows it.
- [x] Given keys such as `__proto__` and `constructor` in `ext` and in extension payloads, when they are read, then no prototype is modified, and the key is kept as data or rejected.
- [x] Given the example of 03 §12 and the fixtures as seeds, when CI runs a bounded fuzz on every change, then it finds no failure; any failing input is saved as a regression fixture in the CDM-014 format.

**Evidence:** `src/validate/fuzz.test.ts`: documents built from the definition (random nodes, attributes, marks, nesting to 40, 60 repeated marks, 100,000-character text) end in a result within 2 s for five fixed seeds (recorded on each test as `fuzzSeed`), from the 03 §12 example and the kitchen sink; hostile TeX, CSS, control, bidirectional and URL strings are refused wherever their grammar does not allow them; `__proto__` and `constructor` keys are refused as `ext` keys, kept as data in payloads and change no prototype, and values a JSON parser never makes (null prototypes, NaN) do not throw. A failing input is saved as a regression in the CDM-014 format (`fixtures/invariants/regressions`), which `invariant-fixtures.test.ts` replays.

**Evidence (lane w1, 2026-11-15, criterion 1):** `src/validate/fuzz-boundaries.test.ts` adds the boundary sizes the audit found missing. A fast-check property over three fixed seeds (25 cases each, from the 03 §12 example and the kitchen sink) builds documents with 499, 500, 501 or 2,000 regions, a table of 62, 63, 64 or 1,000 columns, a node depth of 11, 12, 13 or 5,000, up to 20,000 repeated marks, a string of up to 4 MiB, filler text that brings the document to 8 MiB, 14 MiB or 17 MiB, and an array of up to 8,388,608 integers in `ext`. Each is validated and read; the test asserts a result or a coded error, no exception, a time under 10 s for the two calls together, a heap growth under four times the input's JSON size plus 128 MiB, and that a document past a limit of I7 is never valid. A second test takes each limit alone: at the limit it is accepted and one over it is refused (`too_many_regions`, `limit_exceeded`, `nesting_too_deep`, `canonical_too_large`), and 14 MiB of text is accepted. Measured on 2026-11-15 on the development machine (Windows 11, Node.js 22.18.0, `pnpm exec vitest run --project node packages/model/src/validate/fuzz-boundaries.test.ts packages/model/src/validate/fuzz.test.ts`, both files at once): the slowest case took 2,360 ms, 2,108 ms and 2,577 ms for the three seeds, the largest heap growth was 24 MiB, 31 MiB and 25 MiB, and the largest input was 25 MiB, 35 MiB and 22 MiB of JSON. The heap figure is `process.memoryUsage().heapUsed` after the two calls less the figure before them, without a forced collection; it is not the peak during the call. A failing case is saved as a regression in the CDM-014 format, without its filler. The fix the test led to: `src/validate/grammar-check.ts` (`sizeBound`, `tooLarge`) counts a lower bound of the canonical size of a `json` or element-tree attribute and reports a value past its `maxBytes` once, without walking or canonicalising it; before it, 1,048,576 integers in `ext` (limit 16 KiB) grew the heap by 428 MiB.

**Notes (lane w1, 2026-11-15):** criterion 1 is ticked. The time limit of the boundary cases is 10 s, wider than the 2 s of the random trees, because a document just under 16 MiB is walked in full; the slowest measured case is in Evidence, and a tighter limit is for the performance harness (FND-007) to set. Regions may not nest, so no valid document reaches depth 12 through regions; the depth cases check that `nesting_too_deep` appears from depth 13 and not before. The memory bound is a heap growth measured after the call, not a peak.

**Notes:** Part of S3's "fuzzing finds no crash or stall". The emitter and math-gate fuzzing are EXP's (09 §14). Unticked by audit (2026-11-13): criterion 1, because `fuzz.test.ts` generates no boundary sizes (no 500 regions, no 63 columns, no array or document near 16 MiB; the longest input is a 100,000-character string), and a 16 MiB array in `ext` takes about 11.6 s in `validate()`, far over the test's own 2 s limit (see CDM-013 Notes). Memory is not measured anywhere in the test.

## Definition nodes and styles (03 §4.1)

### CDM-016 Give a paragraph a named style that inherits from another

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Author |

**Spec:** 03 §4.1 (`style_def`, built-in styles), §4.3 (`paragraph`, headings), §8 (I4, I5), §12; 11 §3 · **Requirements:** R1 · **Depends on:** CDM-006, CDM-008, CDM-013

As an author, I want to give a paragraph a named style that inherits from another style, so that changing the style restyles every paragraph that uses it.

**Acceptance criteria**

- [x] Given a `paragraph` whose `style` names a paragraph `style_def`, when the document is validated, then it passes; when `style` names nothing, then I4 is reported.
- [x] Given `basedOn` and `next` on a style, when the document is validated, then each must resolve (I4); a `basedOn` chain with a cycle is reported as I5; a chain of ten styles passes and a chain of eleven is reported as I5.
- [x] Given `outlineLevel`, when it is set, then 1 to 9 or null is accepted and 0, 10 or a non-integer is rejected; a paragraph is a heading when its style (through `basedOn`, since null means inherit) has an `outlineLevel`.
- [ ] Given a new document, when it is created, then it contains every built-in style with its reserved identifier (the list of CDM-002); every other definition has a random identifier and a human-readable `name`; a document missing a built-in style is reported as I1.
- [x] Given a style that a paragraph still references, when a commit deletes the definition, then I4 is reported.
- [x] Given a paragraph with `style` null, when it is read, then it is treated as having the style named by `settings.defaultParagraphStyle`.
- [x] Given the minimum demo, when it runs, then at least three paragraph styles are defined and applied.

**Evidence:** `packages/model/src/validate/validate.test.ts`: a paragraph style that exists passes and a missing one is I4, as are a missing `basedOn` and `next`; a cycle is I5, a chain of ten styles passes and one of eleven is I5; `outlineLevel` 1, 9 and null pass and 0, 10 and 1.5 are I11; deleting `Heading1` while a paragraph uses it is I4. `packages/model/src/cascade/styles.ts` (`styleTable`, `paragraphStyleOf`, `styleProperty`, `outlineLevelOf`, exported from `@docedit/model`) with `styles.test.ts`: style null means `settings.defaultParagraphStyle`; a style based on `Heading1` with no `outlineLevel` of its own is a level-1 heading; chains stop at ten styles and never loop. Criterion 7 (lane w1, 2026-11-15): `apps/reference-host/e2e/exit-check.spec.ts`, test "0. the owner creates a document of regions and three paragraph styles; it opens with its title", passed in Chromium against the demo stack (PostgreSQL and the S3 store in Podman, the document service and the reference host as local processes, no export worker): the new document shows a `Title` paragraph, two `Heading1` paragraphs and `Normal` paragraphs in the editor. Run on the lane's Windows machine with the stack as project `docedit-demo-w1` on ports 57521 to 57524 (`scripts/stack.ps1 up -NoExport`, then `DOCEDIT_DEMO_REUSE=1 pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/exit-check.spec.ts -g "0\. the owner creates"`: 1 passed); the stack was removed afterwards with its volumes.

**Notes:** Phase 1a (11 §3: "Paragraphs with three styles"). Character and table styles are CDM-017. "Present in every document" is not listed among I1 to I12; the I1 criterion applies the sentence in 03 §4.1. Not met: (4) ADR 0018 (proposed) reads "present in every document" as "available to every document", because the 03 §12 example defines only two built-in styles, so a document without a built-in style is not I1. `newDocument()` (`packages/model/src/structure/new-document.ts`) gives a new document every built-in style with its reserved identifier under either reading. The owner decides between the two readings. (7) needs the minimum demo (11 §3). Lane V-CDM-001-027 (2026-11-13): the demo's check is `apps/reference-host/e2e/exit-check.spec.ts` (test 0: three paragraph styles on screen). It needs the demo stack on 127.0.0.1:56490, which this lane did not start: its ports are fixed and outside the lane's 57520 to 57529 range. (7) stays open until that run is made. Lane w1 (2026-11-15): the run was made with the stack's ports and project name set through the environment (see Evidence), and (7) is ticked. (4) stays open: its first two parts hold (`newDocument()` gives every built-in style its reserved identifier, and other definitions get random identifiers and a `name`), but "a document missing a built-in style is reported as I1" contradicts the 03 §12 example, which defines two built-in styles only; the validator follows ADR 0018 (proposed) and does not report it. The owner chooses between the two readings; nothing was changed here.

### CDM-017 Define character and table styles, one attribute per property

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.1 (`style_def`, final paragraph), §4.5, §5 (`charStyle`), §8 (I4, I5) · **Requirements:** R1 · **Depends on:** CDM-016

As an author, I want character styles for runs and table styles for tables, so that I can restyle many places at once.

**Acceptance criteria**

- [x] Given a `style_def`, when `kind` is `paragraph`, `character` or `table`, then it is accepted; any other value is rejected (I11).
- [x] Given a `charStyle` mark, when its `style` names no definition, then I4 is reported; likewise a `table` whose `style` names no definition.
- [x] Given the table properties `borders`, `cellMargins`, `headerRowShading` and `bandedRows`, when they appear on anything but a table style, then they are rejected.
- [x] Given every formatting property is its own attribute on the style, when two commits change different properties of the same style concurrently, then after rebasing both changes are present; when they change the same property, the later commit wins.
- [x] Given a character or table style with `basedOn`, when its chain has a cycle or exceeds ten styles, then I5 is reported.
- [x] Given a style that is still referenced by a mark or a table, when a commit deletes it, then I4 is reported.

**Evidence:** `src/validate/definitions.test.ts`, "character and table styles (CDM-017)": the three kinds pass and any other is I11; a `charStyle` or table `style` naming nothing is I4; `cellMargins`, `headerRowShading`, `bandedRows` and inside borders on a paragraph or character style are I11 `table_property`; two concurrent `attr` steps on different properties of one style both survive rebasing through prosemirror-transform's mapping (the authority's rebase, 04 §4) and on one property the later wins; cycles and chains of eleven are I5 for both kinds; deleting a style a mark or a table uses is I4.

**Notes:** The concurrency criterion is exercised with the authority's rebase (SYN-010); each property change is an `attr` step. Whether a style of the wrong `kind` may be referenced (a paragraph named in `charStyle`) is not specified: see Open questions. Rights to change a style used inside a region are PRM's (PRM-012).

### CDM-018 Hold document-wide defaults in one settings node

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 03 §3, §4.1 (`settings`) · **Requirements:** R1 · **Depends on:** CDM-016

As an author, I want the language, text direction, default tab stop, hyphenation, default paragraph style and footnote numbering of the document in one place, so that I set them once.

**Acceptance criteria**

- [x] Given `defs`, when it is validated, then its children are one `settings`, then style, numbering, page-setup, role and rule definitions in that order (03 §4.1); no `settings`, or two, is reported as I1.
- [x] Given `dir`, `footnoteRestart` and `trackChanges`, when they are set, then `dir` accepts `ltr` and `rtl`, `footnoteRestart` accepts `continuous` and `perPageSection`, `trackChanges` accepts `off` and `everyone`, and any other value is rejected (I11).
- [x] Given `defaultParagraphStyle`, when it names no paragraph style, then the reference is reported (I4); `defaultTabStop` accepts only a positive integer in twentieths of a point; `hyphenation` accepts only a boolean.
- [x] Given `lang` and `footnoteFormat`, when they are set, then they follow the grammar fixed in CDM-002.

**Evidence:** `src/validate/definitions.test.ts`, "settings (CDM-018)": no settings, two, or definitions out of the order of 03 §4.1 are I1; `dir`, `footnoteRestart` and `trackChanges` take their values only; `defaultParagraphStyle` must name a paragraph style (I4, `wrong_reference_kind` for a character style); `defaultTabStop` takes only a positive integer and `hyphenation` a boolean; `lang` is BCP 47 and `footnoteFormat` one of its values.

**Notes:** `defaultParagraphStyle` is not in I4's list of references; the criterion applies the rule that every reference resolves. The behaviour of `trackChanges: everyone` is FE's (FE-041, FE-042) and PRM's; this story defines only the value.

### CDM-019 Define multi-level numbering

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.1 (`numbering_def`, last paragraph), §8 (I4), §13 (open issue on `levels`); review M-4 · **Requirements:** R1 · **Depends on:** CDM-016

As an author, I want to define multi-level numbering (decimal, letters, Roman numerals, bullets, legal style), so that lists and numbered headings follow my rules.

**Acceptance criteria**

- [x] Given a `numbering_def`, when `levels` holds one to nine level objects, then it passes; when it holds none or ten, it is rejected (I11).
- [x] Given a level, when `format` is `decimal`, `lowerLetter`, `upperLetter`, `lowerRoman`, `upperRoman`, `bullet` or `none`, then it is accepted; any other value is rejected.
- [x] Given a level's `text` template, when it contains only the placeholders `%1` to `%9` and the punctuation `.`, `(`, `)`, `-`, `§` and space, then it is accepted; when it contains any other character (including `%0`, `%` followed by a non-digit, letters, `\`, braces) it is rejected.
- [x] Given `bulletChar`, when it is one character from the published list (CDM-002), then it is accepted; otherwise it is rejected.
- [x] Given `start`, `restartAfter`, `legal`, `indentLeft`, `hanging`, `align` and `runProps`, when they are set, then each follows its grammar; lengths are integers in twentieths of a point.
- [x] Given a `numberingId` on a paragraph or a style, when it names no definition, then I4 is reported; when a commit deletes a definition that is still referenced, then I4 is reported.
- [x] Given two commits that edit the same definition's `levels` concurrently, when both are rebased, then the later commit wins as a whole; given edits to different definitions, they do not interact.

**Evidence:** `src/validate/definitions.test.ts`, "numbering definitions (CDM-019)": one and nine levels pass, none, ten or an absent `levels` fail; the seven formats; templates of `%1` to `%9` and `. ( ) - §` and space only; the published bullets only; the grammars of `start`, `restartAfter`, `legal`, the indents, `align` and `runProps` in twips; `numberingId` resolves from a paragraph and a style and a deleted definition in use is I4; two concurrent edits of one definition's `levels` resolve to the later as a whole, edits of two definitions do not interact.

**Notes:** Review M-4. `levels` is one attribute by design (03 §4.1); the open issue in 03 §13 (child nodes if concurrent edits prove common) is left open. The meaning of `restartAfter` is settled in CDM-005. Second review (2026-11-06, SPK-027), SR-M22: the `text` grammar refuses "Article %1", "Section %1.%2" and "Schedule %1", which agreements need and which A2 imports would otherwise drop; the review proposes widening it before `cdm: 1` ([review](../review/2026-11-06-second-review.md)).

### CDM-020 Define page setups and page sections

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.1 (`page_setup`), §4.2 (`body`, `section_break`), §8 (I3, I4), §10 · **Requirements:** R1, R5 · **Depends on:** CDM-016

As an author, I want sections with their own page size, orientation, margins, columns and header and footer choices, so that a document can mix portrait and landscape pages.

**Acceptance criteria**

- [x] Given `defs`, when it is validated, then it holds at least one `page_setup`, and the `body`'s `pageSetup` names one (I4).
- [x] Given a `page_setup`, when its lengths are set, then width, height, margins, `gutter`, `headerDistance`, `footerDistance` and `columnGap` are integers in twentieths of a point (A4 is 11906 by 16838) and `columns` is a positive integer; other values are rejected (I11).
- [x] Given `headerDefault`, `headerFirst`, `headerEven`, `footerDefault`, `footerFirst` and `footerEven`, when a slot is not null, then it names a story (I4).
- [x] Given `orientation`, `differentFirstPage`, `differentOddEven`, `pageNumberStart`, `pageNumberFormat` and `watermark`, when they are set, then each follows its grammar; `watermark` is a text or null.
- [x] Given a `section_break`, when it is validated, then `start` is `nextPage`, `continuous`, `evenPage` or `oddPage`, its `pageSetup` resolves (I4), and it is a direct child of `body`; inside a region, a table or a story it is reported as I3.
- [x] Given a page setup that a section or the body still references, when a commit deletes it, then I4 is reported.

**Evidence:** `src/validate/definitions.test.ts`, "page setups and sections (CDM-020)": a page setup is needed and the body names one; lengths are integer twips and `columns` 1 to 16; header and footer slots name stories of the right kind (I4); orientation, the first and even page flags, page numbering and the watermark follow their grammars; a section break takes the four `start` values, resolves its page setup and is I3 inside a region, a table cell or a story; deleting a page setup in use is I4.

**Notes:** Which section a break's `pageSetup` describes (the one after it or the one before it) is not stated: see Open questions. `watermark` and several page attributes have no row in the writer-support table of 03 §10: see CDM-046. Section breaks inside regions are excluded in version 1 (03 §13). Who may change a page setup is PRM's.

### CDM-021 Define headers and footers as stories

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §3, §4.1 (`story`), §8 (I2, I4, I10) · **Requirements:** R1 · **Depends on:** CDM-020

As an author, I want headers and footers that hold paragraphs, page numbers and the like and that I edit in their own panel, so that they cannot be disturbed from the body.

**Acceptance criteria**

- [x] Given a `story`, when it is validated, then `kind` is `header` or `footer`, its content is one or more blocks, and it has a unique non-null `id` (I2).
- [x] Given a story, when a table appears inside it, then I10 is reported.
- [x] Given a story referenced from a page setup slot, when a commit deletes the story, then I4 is reported.
- [x] Given a `field` of kind `page` or `pageCount`, when it appears in a story, then it is accepted.

**Evidence:** `src/validate/definitions.test.ts`, "headers and footers (CDM-021)": `kind` header or footer, one or more blocks, a unique identifier (I2); a table in a story is I10 `table_in_story_or_footnote`; deleting a story a page setup names is I4; page and page-count fields are accepted in a story.

**Notes:** `story` content is `block+` in 03, which would admit a table; I10 forbids it, so the rule is a validator rule (see Open questions). The schema flags that make stories isolating, not selectable and closed to the gap cursor are CDM-008; body-scoped select-all and joins are FE's. Whether a header slot may name a story of kind `footer` is not stated. `form_field` is not allowed in stories (12 §3.2); FRW owns that rule. Second review (2026-11-06, SPK-027): I10 now names form fields in stories and footnotes (E11). SR-K5: whether tables are allowed in headers and footers is an owner decision; the review recommends allowing them (controlled documents, imported Word headers), which would change the second criterion ([review](../review/2026-11-06-second-review.md)).

### CDM-022 Reserve the nodes for fields and extensions

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | must | Maintainer |

**Spec:** 03 §3, §4.1 (`defs`, `role_def`, `rule_def`), §4.4 (`form_field`, `extension_inline`), §11.1; 12 §3; ADR 0011; review M-1 · **Requirements:** R13 · **Depends on:** CDM-006

As a maintainer, I want the slots for role, rule, form-field and extension nodes to exist in CDM 1, so that fillable fields and extensions can be added later without a new major version.

**Acceptance criteria**

- [x] Given the definition, when `defs` is generated, then its content expression has positions for `role_def*` and `rule_def*`, and `form_field` is an inline atom wherever the body allows inline content, table cells included.
- [x] Given the attributes of `role_def`, `rule_def` and `form_field`, when the definition is built, then they come from FRW's definition module and are imported into the single definition; this epic defines none of them.
- [x] Given a document that contains a `role_def`, `rule_def`, `form_field` or the `formValue` kind, when its `requires` omits `fields`, then I1 is reported; given an extension node and `requires` without `extensions`, I1 is reported.
- [x] Given a reader that does not support `fields`, when it reads a document that requires it, then it refuses (CDM-009), tested with a fixture that contains a `form_field`.
- [x] Given FRW's invariants I13 to I15, when `validate` runs, then it runs them through the registration point of CDM-013.

**Evidence:** `src/definition/fields.ts` is FRW's definition module, imported by `cdm1.ts`, which declares none of the attributes of `role_def`, `rule_def` and `form_field`. `src/fields/fields.test.ts`, "the slots CDM 1 reserves for fields and extensions (CDM-022)": `role_def*` and `rule_def*` in `defs`, form fields in body paragraphs and table cells; a role, a rule, a form field or a `formValue` field without `fields`, and an extension without `extensions`, are I1 (`valueFeatures` on the `field` kind); a reader without `fields` refuses a document with a form field (`unsupported_feature`); I13 to I15 run through the registration point (`src/validate/engine.test.ts`).

**Notes:** Review M-1. The mapping of node types to the features `fields` and `extensions` is inferred: 03 §11.1 names the two features but does not list their members (see Open questions). 12 §3.2 forbids `form_field` in headers, footers and footnotes, but no invariant I1 to I15 says so.

### CDM-023 Map pasted definitions onto existing ones

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | should | Author |

**Spec:** 03 §4.1 (paragraph after the table); review M-16 · **Requirements:** R1 · **Depends on:** CDM-016, CDM-019, FE-050, FE-051

As an author, I want pasting content that carries style or numbering definitions not to create duplicates, so that my styles pane stays clean.

**Acceptance criteria**

- [x] Given pasted content that brings a definition whose identifier already exists in the target document, when the content is inserted, then the pasted nodes refer to the existing definition and no second definition with that identifier is inserted.
- [x] Given a built-in identifier such as `Heading1` whose definition differs in the source, when the content is inserted, then the target document's definition is kept and the pasted paragraphs take its look.
- [x] Given the merged result, when it is validated, then no `style`, `basedOn`, `next` or `numberingId` reference is left unresolved (I4) and identifiers are unique (I2).

**Evidence:** `src/structure/paste.ts` (`mapPastedDefinitions`) and `src/structure/structure.test.ts`: a brought definition whose identifier the target has is dropped and the pasted nodes keep referring to the target's; a built-in such as `Heading1` keeps the target's look; after inserting the result no style, `basedOn`, `next`, `numberingId` or character-style reference is unresolved and identifiers are unique (`validate()` passes). The editing core calls it: `buildFragment` in `packages/engine/src/content.ts`, which every paste (`pasteFromClipboard`) and every `insertContent` goes through, passes the fragment's definitions and content to `mapPastedDefinitions` and has no mapping of its own left. `packages/engine/test/cdm-023-pasted-definitions.test.ts` (Node.js, 3 tests) pastes through the clipboard path: a differing `Quote` style and a differing `Num1` numbering definition leave the target's `defs` unchanged and the pasted paragraph refers to them; a differing built-in `Heading1` keeps the target's definition; unresolved `style`, `basedOn`, `next`, `numberingId` and character-style references are dropped, block identifiers are fresh, and `validate()` finds nothing the paste added. `structure.test.ts` also covers a pasted `numbering_def` whose identifier exists and one brought twice.

**Notes:** Review M-16 (style identifier collisions). The editing core performs the mapping at paste (FE); this story supplies the mapping function and its tests. What happens to a brought definition with a new identifier, or for a user who lacks `structure` (07 §7), is not specified. Evidence audit (2026-11-13): criteria unticked because `mapPastedDefinitions` is exported from `@docedit/model` but nothing in the product calls it (the engine's paste in `packages/engine/src/clipboard.ts` and `cdm-fragment.ts` has its own mapping, covered under FE-051), so the Evidence line "The clipboard calls it" is untrue and `structure.test.ts` exercises a function only that test uses; also no test covers a pasted `numbering_def` whose identifier exists. Tick again once the clipboard uses this function (or the function is removed and the criteria are met by FE-051). Lane w1 (2026-11-15): the engine's `buildFragment` now calls `mapPastedDefinitions` and its own mapping is removed, so the three criteria are ticked again on the tests named in Evidence. Two things changed with it. The function takes a `types` option; the engine passes `style_def` and `numbering_def`, the two types a fragment carries, so references to sources and roles are left as they are (a fragment cannot bring a `source_def` or `role_def`; whether it should is open, and FRW tests insert fields whose role the document does not define). And a reference to a style or numbering definition that resolves nowhere is now dropped at paste (ADR 0031, proposed), where the engine used to keep it. The engine fixture `styledDocument` itself fails I11 (`Quote` and `Emphasis` are reserved identifiers without `builtIn`), so the engine test compares the validator's findings with that baseline rather than with none.

## Body containers (03 §4.2)

### CDM-024 Make regions real containers with a stable identity

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Owner |

**Spec:** 03 §3, §4.2 (`region`), §8 (I2, I3, I7); ADR 0009 · **Requirements:** R3 · **Depends on:** CDM-008, CDM-013; FE-036, FE-038

As an owner, I want regions to be real containers with a stable identity, so that I can grant roles on them and the server can tell exactly which content belongs to which region.

**Acceptance criteria**

- [x] Given a document, when its top level is validated, then `doc` holds `defs`, then zero or more `story` nodes, then exactly one `body`, and `body` holds one or more blocks, regions or section breaks (03 §3, §4.2).
- [x] Given a `region`, when it is validated, then its attributes are `id`, `title` and `policy` (`inherit` or `restricted`), its content is one or more blocks, and no attribute for grants, states or leases exists: those live in the document service (ADR 0009).
- [x] Given a region, when it is anywhere but a direct child of `body` (inside another region, a table cell, a story), then I3 is reported.
- [x] Given a region inside a region, when the document is validated, then I3 is reported (regions do not nest).
- [x] Given 500 regions, when the document is validated, then it passes; given 501, then I7 is reported.
- [x] Given a region identifier that was removed from the document at any earlier time, when a commit creates a region with that identifier and the retired identifiers are supplied, then I3 is reported; given two regions with one identifier, I2 is reported.
- [x] Given a region with a non-null `id`, when a commit changes the `id`, then I2 is reported.
- [x] Given a `section_break` inside a region, when the document is validated, then I3 is reported.

**Evidence:** `packages/model/src/validate/validate.test.ts`, "document structure and regions (CDM-024)": `defs` after `body`, two bodies, a story after the body, no body and an empty body are I1; the region's attributes in the definition are `id`, `title`, `policy`, plus `preserved` (03 §4.6) and `ext` (03 §4); `grants`, `state` or `lease` on a region is I1, an unknown policy is I11, an empty region is I1; a region inside a region, a table cell or a story, and a section break inside a region, are I3 (`validate.ts` now checks placement itself instead of leaving it to the schema's I1); 500 regions pass and 501 are I7; a retired identifier is I3 and two regions with one identifier are I2. A commit that changes a region's `id`: `packages/authority/test/invariants.test.ts` and `room-scenarios.test.ts` (refused with `invalid_op`, not stored).

**Notes:** Phase 1a (11 §3: "regions"). ADR 0009 (after the first review: identifiers never reused). The region is isolating in the schema (CDM-008). The rule that the editing core keeps a body paragraph after every region (03 §4.2) is FE's FE-036, FE-038; it is not an invariant. Grants, approval states and leases are PRM's. The `id` change is caught for attribute steps; a replacement that drops the region and creates another is a deletion and a creation (see CDM-012). Second review (2026-11-06, SPK-027), SR-M6: ADR 0019 proposes a third policy value, `confidential`, and a projection-only `hidden_region` atom; neither is in 03 §4.2 yet, so the second criterion changes if ADR 0019 is accepted ([review](../review/2026-11-06-second-review.md)).

## Blocks (03 §4.3)

### CDM-025 Hold run and paragraph formatting as integer-valued properties

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §1 (principles 5, 7), §2 (units), §4.1 (`style_def`), §4.3 (`paragraph`), §4.5 · **Requirements:** R1 · **Depends on:** CDM-016

As an author, I want font, size, colour, alignment, indents, spacing, tabs, borders and shading as properties of styles and of single paragraphs, so that formatting is reproducible in every output.

**Acceptance criteria**

- [x] Given the run properties (`fontFamily`, `fontSize`, `bold`, `italic`, `underline`, `strike`, `smallCaps`, `allCaps`, `vertAlign`, `color`, `highlight`, `lang`, `hidden`) and the paragraph properties of 03 §4.5, when a style is defined, then each is its own attribute on `style_def`; the paragraph properties are also attributes of `paragraph` for direct formatting.
- [x] Given a length, a font size or a spacing, when it is stored, then it is an integer in twentieths of a point (11 pt is 220, 10.5 pt is 210); a fractional number such as 10.5 is rejected (I11).
- [x] Given `lineSpacing`, when `lineRule` is `multiple`, then it is an integer in thousandths (1150 is 1.15 lines); when `lineRule` is `exact` or `atLeast`, it is a length; `lineRule` accepts only these three values.
- [x] Given a colour, when it is stored, then it is `#RRGGBB`; names, `rgb()` and three-digit forms are rejected.
- [x] Given `tabs`, when entries are set, then each has a position, an alignment (`left`, `center`, `right`, `decimal`) and a leader from the value set of CDM-002.
- [x] Given an attribute set to null, when the document is canonicalised, then it is omitted ("not set here; inherit").
- [x] Given `keepNext`, `keepLines`, `pageBreakBefore`, `widowControl` and `contextualSpacing`, when they are set, then each accepts only a boolean.

**Evidence:** `src/validate/blocks.test.ts`, "formatting properties (CDM-025)": every run and paragraph property is its own attribute of `style_def`, the paragraph ones also of `paragraph`; lengths are integer twips and 10.5 is refused; `lineSpacing` reads as thousandths under `multiple` and as a length otherwise, `lineRule` has three values; colours are `#RRGGBB` only; tab stops have a position, an alignment and a leader of the published values; null attributes are omitted from the canonical form; the five keep and spacing flags take booleans only.

**Notes:** Principle 7: quantities are integers and decimal values entered by users are strings; the interface converts a user's "10.5" before it reaches the model. Table properties are CDM-017 and CDM-028.

### CDM-026 Put list items in a list instance

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 03 §4.3 (paragraph, list bullets), §8 (I4); review M-4 · **Requirements:** R1 · **Depends on:** CDM-019

As an author, I want each list item to belong to a specific list, so that two lists on one definition number independently and a restart does not depend on a neighbouring paragraph surviving.

**Acceptance criteria**

- [x] Given a paragraph, when `numbering` is set, then it is `{ numberingId, level, listId }` with `level` inside the definition's levels, or null; `numberingId` must resolve (I4).
- [x] Given `numberingRestart`, when it is set, then it is an integer or null.
- [x] Given a paragraph style, when it carries `numbering`, then its `numberingId` resolves (I4); this is how headings are numbered.
- [x] Given two paragraphs with the same `numberingId` and different `listId`, when the document is read, then they belong to two lists (their labels are CDM-042).
- [x] Given the first paragraph of a list is deleted, when the others are read, then they keep their `listId`.
- [x] Given the schema, when it is inspected, then no list container node exists: lists are paragraphs with a `numbering` attribute.

**Evidence:** `src/validate/blocks.test.ts`, "lists (CDM-026)": `numbering` is `{ numberingId, level, listId }` or null, with a level the definition has (I4 `numbering_level_missing`) and a definition that exists (I4); `numberingRestart` is an integer or null; a style's numbering resolves; `listInstances()` (`src/structure/lists.ts`) puts two lists on one definition apart and keeps a list together when its first paragraph is deleted; no list container node exists.

**Notes:** Review M-4. The format and copy rule of `listId`, and which `listId` a paragraph numbered by its style has, are open (CDM-002, CDM-005).

### CDM-027 Build tables with rows, cells and spans

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Author |

**Spec:** 03 §4.3 (`table`, `table_row`, `table_cell`, bullets), §8 (I2, I6, I7, I10); review M-6 · **Requirements:** R1 · **Depends on:** CDM-008, CDM-013

As an author, I want tables with merged cells, so that I can lay out data and forms.

**Acceptance criteria**

- [x] Given a `table`, when it is validated, then it contains one or more `table_row`, each containing one or more `table_cell`, each containing one or more paragraphs, figures or equation blocks; a `toc`, an extension block, a region or a section break inside a cell is rejected; the table, rows and cells have unique non-null `id`s (I2).
- [x] Given `colspan` and `rowspan`, when they are set, then each is a positive integer.
- [x] Given a row, when its column spans (counting positions covered by row spans from earlier rows) do not add up to the length of `grid`, or when a row span runs past the last row, then I6 is reported.
- [x] Given a `grid` of 63 columns, when the table is validated, then it passes; given 64, I7 is reported.
- [x] Given a table inside a table cell, when it is validated, then it is rejected (tables cannot contain tables in version 1); given a table inside a story or a footnote, I10 is reported.
- [x] Given a figure with `placement: float` inside a cell, or a page or column `break` inside a cell, when the document is validated, then I10 is reported.
- [x] Given `headerRows`, when it is set, then it is an integer from 0 to the number of rows.
- [x] Given a table caption, when it is modelled, then it is an ordinary paragraph in the `Caption` style that contains a `seq` field (03 §4.3); no dedicated caption node exists for tables.

**Evidence:** `src/validate/blocks.test.ts`, "tables with rows, cells and spans (CDM-027)": rows of cells of paragraphs, figures and equations with identifiers, a toc, an extension block, a region or a section break in a cell refused; positive spans; spans covering the grid with row spans (I6); 63 columns pass and 64 are I7 `limit_exceeded`; a table in a cell refused, in a story or footnote I10; a floating figure or a page or column break in a cell I10; `headerRows` 0 to the number of rows (I6 `header_rows`); a table caption is a Caption paragraph with a `seq` field and tables have no caption node.

**Notes:** Review M-6 (I10). I6 as written counts "the column spans" of a row; with row spans a covered position has no cell, so the criterion counts covered positions. See Open questions. "Kept with the table" (03 §4.3) is layout (keep rules) and is not defined as data. Suggesting whole rows and tables is CDM-040.

### CDM-028 Describe table width, grid, borders, shading and row heights

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.3 (`table`, `table_row`, `table_cell`), §4.5 (table properties), §6; 09 §3.2 · **Requirements:** R1, R5 · **Depends on:** CDM-027, CDM-017

As an author, I want to set a table's width, column widths, borders, cell margins, shading and row heights, so that tables look as I intend in the editor and in the PDF.

**Acceptance criteria**

- [x] Given a table, when it is validated, then `grid` is present with one integer width per column (the editor always computes and stores it, 09 §3.2; automatic widths do not exist in LaTeX).
- [x] Given `width` and `align`, when they are set, then `width` is `{ type, value }` with `type` in `auto`, `pct`, `fixed` and `value` an integer in the unit fixed by CDM-002, and `align` follows the value set of CDM-002.
- [x] Given a row, when it is set, then `height` is an integer, `heightRule` is `auto`, `atLeast` or `exact`, and `cantSplit` is a boolean.
- [x] Given a cell, when it is set, then `vAlign`, `shading`, `borders` and `margins` follow their grammars (CDM-002).
- [x] Given a table whose `style` names no table style, when it is validated, then I4 is reported; a direct `borders` or `cellMargins` on the table overrides the table style in the cascade (CDM-041).

**Evidence:** Criteria 1 to 4: `src/validate/blocks.test.ts`, "table width, grid, borders, shading and row heights (CDM-028)": `grid` is required with integer widths; `width` is `{ type, value }` with `auto`, `pct` or `fixed` and an integer; `align` by its values; row `height`, `heightRule` and `cantSplit`; cell `vAlign`, `shading`, `borders` and `margins`; a table style that names nothing or a paragraph style is I4. Criterion 5: `src/validate/blocks.test.ts`, "reports a table style that names no table style (I4)", for the I4 half; `src/cascade/table-format.test.ts`, "table borders and cell margins in the cascade (CDM-028)", for the override: `resolveTableFormat()` in `src/cascade/table-format.ts` gives a direct table `borders` or `cellMargins` the whole-value override of the table style's chain, and a missing table style is the cascade's `style_missing` error. `resolveTableFormat()`, `TableFormat` and `TableFormatLayer` are exported from `src/index.ts`, and the test imports the resolver through that entry point. The layout engine and the writers switching to it is CDM-041 criterion 7.

**Notes:** Writers' limits for tables (three LaTeX writers, 09 §3.2) are EXP's and are recorded in CDM-046. The table-level cascade is a separate resolver from the paragraph cascade of CDM-041 (`resolve.ts` covers paragraphs and runs only); it reuses `styleChain()` and is not yet called by the layout engine or the writers, so FE and EXP still need to switch to it. Lane model-2 (round 2) added it; criterion 7 of CDM-041 (the shared fixtures) stays unticked.

### CDM-029 Add images and figures by asset reference

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.3 (`figure`, `caption`), §4.4 (`image`), §8 (I4, I10), §10; 01 §8; 06 §4.4 · **Requirements:** R1, R5, R11 · **Depends on:** CDM-027

As an author, I want inline images and block figures with captions that refer to uploaded assets, so that documents stay small and images can be checked and replaced.

**Acceptance criteria**

- [x] Given an `image` or a `figure`, when `asset` is set, then it is an asset identifier (a UUID version 7 in canonical text form); embedded data, such as a `data:` URI or a base64 string, is rejected (I11).
- [x] Given an `asset`, when the caller supplies the assets attached to the document and the asset is not among them, then I4 is reported.
- [x] Given `width`, `height`, `align` and `alt`, when they are set, then `width` and `height` are positive integers in twentieths of a point, `align` follows the value set of CDM-002, and `alt` is a string within the length bound of CDM-002 and may be empty.
- [x] Given a `figure`, when it is validated, then its content is an optional `caption` of inline content; a footnote or a page or column break inside a caption is reported as I10.
- [x] Given `placement`, when it is `here` or `float`, then it is accepted; any other value (for example a text-wrap mode) is rejected, because floating figures with text wrap are not in version 1.
- [x] Given a figure with `placement: float` inside a table cell, when the document is validated, then I10 is reported.

**Evidence:** `src/validate/blocks.test.ts`, "images and figures (CDM-029)": `asset` is a UUID version 7, embedded data and URLs refused (I11); an unattached asset is I4; width, height, align and alt by their grammars, alt may be empty; a caption of inline content, a footnote in it I10 `footnote_in_caption`, a page break I10; placement `here` or `float` only; a floating figure in a cell I10.

**Notes:** `caption` has no `id` although principle 6 says every block-level node carries one (see Open questions). Prompting for missing alternative text is UX's accessibility checker (UX-066, UX-067) and the export job's diagnostics (09 §13). Asset attachment comes from BE-044.

### CDM-030 Store equations as LaTeX behind a gate

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.3 (`equation_block`), §4.4 (`equation`), §8 (I7, I8); 09 §6; review M-9 · **Requirements:** R1, R5, R10 · **Depends on:** CDM-013, CDM-036; EXP-049, EXP-050

As an author, I want inline and display equations stored as LaTeX, so that they render on screen and typeset in the PDF, and no equation can break the build.

**Acceptance criteria**

- [x] Given an `equation_block`, when it is validated, then it is an atom with `id`, `latex`, `numbered` (a boolean) and `label`; given an `equation`, it is an inline atom with `latex`.
- [x] Given a `latex` attribute of 4,000 characters, when it is validated, then it passes; given 4,001, I7 is reported.
- [x] Given a commit that sets or changes a `latex` attribute, when the result is validated, then the math gate of 09 is called on that value, and a rejection is reported as I8 with the gate's reason.
- [x] Given a commit that touches no `latex` attribute, when it is validated, then the gate is not called.
- [x] Given `numbered` equation blocks, when labels are computed, then they are counted in the `Equation` sequence by the shared algorithm (CDM-042); `label` can be the target of a `ref` field (CDM-036).
- [x] Given a table cell, when it holds an equation block, then it is accepted.

**Evidence:** `src/validate/blocks.test.ts`, "equations (CDM-030)": the block atom's and inline atom's attributes; 4,000 characters pass and 4,001 are I7; with `previous`, the gate is called once on the changed value and its refusal is I8 with the reason, and a commit that touches no `latex` never calls it; a `ref` to `eq:<label>` resolves and an equation sits in a table cell. `src/structure/labels-use.test.ts`: numbered equation blocks count in the `Equation` sequence of the shared algorithm (`computeLabels`, CDM-042) and a `ref` prints the number.

**Notes:** Review M-9. The gate itself is EXP's; the validator calls it at commit time ("when the commit that sets it is processed", 09 §6.3) and the converter calls it again. When no gate is supplied, the I8 check is reported as not evaluated (CDM-013).

### CDM-031 Add a table of contents that generates its own entries

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 03 §4.3 (`toc`); 02 §5.1 (`outline`) · **Requirements:** R1 · **Depends on:** CDM-016

As an author, I want a table of contents, list of figures or list of tables whose entries update themselves, so that I never retype it.

**Acceptance criteria**

- [x] Given a `toc`, when it is validated, then it is an atom with `id`, `minLevel`, `maxLevel` and `of`; the levels are integers from 1 to 9 and `minLevel` does not exceed `maxLevel`.
- [x] Given `of`, when it is set, then it is `headings` or the name of a caption sequence (for a list of figures or tables).
- [x] Given a `toc` and a changed heading, when the document is read, then the `toc` node is unchanged: it stores no entries, and entries are generated at layout and export time from the headings and their computed labels (CDM-042).
- [x] Given a table cell, when it contains a `toc`, then it is rejected.

**Evidence:** `src/validate/blocks.test.ts`, "tables of contents (CDM-031)": an atom with `id`, `minLevel`, `maxLevel` and `of`; levels 1 to 9 and `minLevel` above `maxLevel` is I11 `toc_levels`; `of` is `headings` or a sequence name; the node stores no entries, so a changed heading leaves its canonical form unchanged; a toc in a cell is refused.

**Notes:** The generation of entries is FE's layout and EXP's converter, from this epic's labels.

### CDM-032 Carry custom content with a mandatory fallback

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 03 §4.3 (`extension_block`), §4.4 (`extension_inline`), §8 (I12), §10; 13 §7.3 · **Requirements:** R14 · **Depends on:** CDM-006, CDM-013

As an integrating developer, I want custom block and inline content that always carries a fallback, so that every writer can render something even when it does not know my extension.

**Acceptance criteria**

- [x] Given an `extension_block`, when it is validated, then it is an atom with `id`, `extension`, `payload` and at least one of `fallbackAsset` or `fallbackText`; with neither, it is rejected.
- [x] Given a `payload`, when its canonical JSON is 16 KiB or less, then it passes; when it is larger, I12 is reported.
- [x] Given an `extension_inline`, when it is validated, then it is an atom with `extension`, `payload` and a `fallbackText`; without a `fallbackText` it is rejected.
- [x] Given the authority validates an extension node, when it runs I12, then it checks the envelope (the identifier grammar, a payload that is JSON within the limit, the fallback) and never interprets the payload.
- [x] Given a `fallbackAsset`, when it names an asset that is not attached to the document, then I4 is reported.
- [x] Given a document that contains an extension node, when its `requires` omits `extensions`, then I1 is reported.

**Evidence:** `src/validate/blocks.test.ts`, "extension nodes (CDM-032)": a block needs a fallback picture or text (I12 `extension_fallback`); a payload of 16 KiB passes and one byte more is I12; an inline extension needs a fallback text; the envelope (name, payload JSON, fallback) is checked as I12 and the payload never interpreted; an unattached fallback picture is I4; without `extensions` in `requires` it is I1.

**Notes:** The 16 KiB limit is stated for the block only; the inline payload limit and whether payloads may hold non-integer numbers are open (CDM-002). Writers render the fallback (03 §10, CDM-046); the extension runtime and contributions are UX's.

## Inline nodes (03 §4.4)

### CDM-033 Add line, page and column breaks and tabs

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 03 §4.4 (`break`, `tab`), §8 (I10); review M-6 · **Requirements:** R1 · **Depends on:** CDM-013

As an author, I want line, page and column breaks and tab characters, so that I control where lines and pages end.

**Acceptance criteria**

- [x] Given a `break`, when `kind` is `line`, `page` or `column`, then it is accepted; any other value is rejected.
- [x] Given a page or column `break` inside a table cell, a caption or a footnote, when the document is validated, then I10 is reported; a line break in those places is accepted.
- [x] Given a `tab`, when it is validated, then it has no attributes other than `ext`.

**Evidence:** `src/validate/inline.test.ts`, "line, page and column breaks and tabs (CDM-033)": the three kinds and no other; page and column breaks in a cell, a caption or a footnote are I10 and a line break there passes; a tab has only `ext`.

**Notes:** Review M-6. Tab stop positions are CDM-044.

### CDM-034 Add footnotes of one paragraph

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.1 (`settings`), §4.4 (`footnote`), §8 (I10), §13; review M-6, M-11 · **Requirements:** R1 · **Depends on:** CDM-001, CDM-013

As an author, I want footnotes, so that I can add notes at the foot of a page.

**Acceptance criteria**

- [x] Given a `footnote`, when it is validated, then it is an atom with a unique non-null `id` and content as decided in CDM-001, holding exactly one paragraph of content in version 1.
- [x] Given a footnote that contains more than one paragraph of content, when the document is validated, then it is rejected.
- [x] Given a footnote inside a footnote or inside a caption, when the document is validated, then I10 is reported.
- [x] Given a page or column break, or a table, inside a footnote, when the document is validated, then I10 is reported.
- [x] Given `settings.footnoteFormat` and `settings.footnoteRestart`, when footnote marks are numbered, then the format and the restart rule come from those two attributes (the counting rule is settled in CDM-005).

**Evidence:** `src/validate/inline.test.ts`, "footnotes of one paragraph (CDM-034)": more than one paragraph is refused (I1 `footnote_paragraphs`); a footnote in a footnote (I10 `footnote_in_footnote`, now checked by `validate()`) or in a caption (I10); page and column breaks and tables in a footnote are I10. `src/structure/labels-use.test.ts`: footnote marks follow `settings.footnoteFormat` in the shared algorithm (`computeLabels`), which also restarts them under `footnoteRestart: perPageSection` (CDM-042). Criterion 1: the content is `paragraph+` as CDM-001 decided, exactly one paragraph in version 1, and a footnote has a unique non-null identifier (`src/validate/inline.test.ts`).

**Notes:** Review M-11 (footnote model open). Whether a footnote may sit in a story is not stated. The `FootnoteText` style is one of the built-ins (CDM-016).

### CDM-035 Insert page, date and title fields

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.4 (`field`), §7 (Fields); 09 §3.1 · **Requirements:** R1, R5 · **Depends on:** CDM-013, CDM-002

As an author, I want page numbers, page counts, dates and the document title as fields, so that headers, footers and text stay correct as the document changes.

**Acceptance criteria**

- [x] Given a `field`, when it is validated, then it is an atom with `kind`, `format`, `target`, `name` and `cached`; `kind` accepts `page`, `pageCount`, `date`, `title`, `ref`, `styleRef`, `seq` and `formValue`, and any other value is rejected.
- [x] Given `format` and `cached`, when they are set, then they are strings within the bounds of CDM-002 (I11).
- [x] Given a field whose `cached` text is stale, when the model computes the field, then the result ignores `cached`; `cached` serves only consumers that cannot compute it.
- [x] Given a `date` field, when the model evaluates it, then it requires the time zone of the workflow or of the export job as an explicit argument and has no default; the client's time zone is never used.
- [x] Given `page` and `pageCount`, when labels are computed, then the model does not compute them: only the typesetter and the layout know page numbers.
- [x] Given a field, when it appears in the body, a region, a table cell, a caption or a story, then it is accepted.

**Evidence:** `src/validate/inline.test.ts`, "page, date and title fields (CDM-035)": an atom with `kind`, `format`, `target`, `name` and `cached`, eight kinds and no other; `format` and `cached` by their grammars; `fieldText()` (`src/structure/field-text.ts`) ignores a stale `cached`; a date needs the instant and the time zone of the workflow or export job, has no default and gives different dates in two zones (through `dateFieldText`, CDM-005); page and page count are never computed; fields pass in the body, a region, a cell, a caption and a story.

**Notes:** 03 §7 says "`dateSigned` and `date` fields", but `dateSigned` is a `form_field` kind (12 §3.3) written by the server; its zone rule is FRW's. A `title` field has no data source inside the CDM, because the title is control-plane metadata (03 §2): see Open questions. The `formValue` kind is FRW's (FRW-006); this story only names it in the enumeration.

### CDM-036 Insert cross-references, caption sequences and bookmarks

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §4.3 (table captions), §4.4 (`field` kinds `ref`, `styleRef`, `seq`; `anchor`), §7 (Numbering), §8 (I4); review M-11 · **Requirements:** R1 · **Depends on:** CDM-035, CDM-002

As an author, I want bookmarks, cross-references to headings, numbered items, captions and equations, and numbered captions, so that references stay correct when the document changes.

**Acceptance criteria**

- [x] Given an `anchor`, when it is validated, then it is a zero-width atom with `id` and `name`, and `name` follows the grammar and uniqueness rule of CDM-002.
- [x] Given a `field` of kind `ref`, when it is validated, then its `target` is a bookmark, a heading, a numbered paragraph, a caption sequence or an equation label, in the addressing form of CDM-002, and it must resolve (I4).
- [x] Given `seq` fields with a `name` (`Figure`, `Table`, `Equation`), when labels are computed, then captions are numbered per name in document order across regions and tables (CDM-042).
- [x] Given a `ref` to a numbered paragraph, a caption or an equation, when it is evaluated, then it yields the same computed label that item carries, as literal text.
- [x] Given a `styleRef` field, when it is validated, then its `target` is checked as the addressing form of CDM-002 requires.
- [x] Given a table caption (a `Caption` paragraph containing a `seq` field) and a figure caption, when the `seq` field is evaluated, then both are counted in their own sequence by `name`.

**Evidence:** `src/validate/inline.test.ts`, "cross-references, sequences and bookmarks (CDM-036)": an anchor is a zero-width atom with a unique name of its grammar; a `ref` resolves to a bookmark, a heading, a numbered paragraph, a caption or an equation label and a plain paragraph is not a target (I4); targets in the wrong form are I11; `styleRef` takes `style:<id>`. `src/structure/labels-use.test.ts`: captions are numbered per name across a region and a table, figure and table captions apart, and a `ref` prints the label its target carries (`computeLabels`, `referenceText`).

**Notes:** Review M-11 (captions with sequences). I4 requires every `field.target` to resolve; deleting a referenced heading or bookmark would then make the commit invalid, and the spec does not say how the editor handles that: see Open questions. The semantics of `styleRef` are not described in 03. Bookmarks are stripped on paste by the clipboard (02 §5.2), which is FE's. Second review (2026-11-06, SPK-027): SR-M31 proposes allowing a dangling `field.target`, shown as a broken reference, instead of refusing the deletion; SR-C3: under ADR 0019, `cached` text and computed labels of references into hidden content must be redacted in projections ([review](../review/2026-11-06-second-review.md)).

## Marks (03 §5)

### CDM-037 Format characters with marks

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §5; §6 (step 8); §8 (I4, I11); §2 (mark order) · **Requirements:** R1 · **Depends on:** CDM-017, CDM-025

As an author, I want to make text bold, italic, underlined, coloured, in another font or size, or in a character style, so that I can format runs.

**Acceptance criteria**

- [x] Given `bold`, `italic`, `strike`, `smallCaps`, `allCaps` and `hidden`, when they are set, then each carries `value` as a boolean; `underline` carries `style` (`single`, `double`, `dotted`, `none`); `vertAlign` carries `value` (`super`, `sub`, `baseline`); anything else is rejected.
- [x] Given a toggle mark with `value: false` on text whose style switches the property on, when the formatting is resolved, then the property is off; given no mark, it inherits (CDM-041).
- [x] Given `color`, `highlight`, `fontFamily`, `fontSize` and `lang`, when they are set, then each `value` follows its grammar: `color` is `#RRGGBB`, `fontSize` is an integer in twentieths of a point, and a `fontFamily` that the grammar of CDM-002 does not accept (for example one containing `;`, `{`, `}` or `url(`) is rejected as I11.
- [x] Given a `charStyle` mark, when its `style` names no character style, then I4 is reported.
- [x] Given two marks of the same type other than the suggestion marks, when the second is added to the same text, then it replaces the first (they exclude each other).
- [x] Given the schema, when the mark list is inspected, then its order is the published canonical mark order of CDM-008 and CDM-010.

**Evidence:** `src/validate/marks.test.ts`, "character formatting with marks (CDM-037)": toggles take a boolean, `underline` its four styles, `vertAlign` its three values; colour, highlight, font family (`;`, braces and `url(` refused), font size and language by their grammars (I11); a `charStyle` that names nothing or a paragraph style is I4; a second mark of a type replaces the first except the suggestion marks; the mark list order of the definition is the published and canonical order. A toggle with `value: false` turns a style's property off, and no mark inherits: the cascade of CDM-041 (`resolveRun`, `src/cascade/resolve.ts`).

**Notes:** Phase 1b; the editor surfaces these marks at its own pace. The exclusion rule is the ProseMirror default; 03 §5 states only the exception for suggestion marks.

### CDM-038 Restrict link targets to safe schemes

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 03 §5 (`link`), §8 (I9); 09 §4; 10 (dangerous links) · **Requirements:** R10 · **Depends on:** CDM-013, CDM-002

As an author, I want links that can only point to web pages, e-mail addresses and places in the document, so that a document can never carry a script or file link.

**Acceptance criteria**

- [x] Given a `link` mark, when it is validated, then it carries `href` and `title`, each within the length bounds of CDM-002.
- [x] Given an `href` with scheme `http`, `https` or `mailto`, or an in-document target in the form fixed by CDM-002, when it is validated, then it passes.
- [x] Given an `href` with another scheme (`javascript:`, `data:`, `file:`, `run:`), when it is validated, then I9 is reported.
- [x] Given obfuscated forms of a disallowed scheme (mixed case, leading whitespace, an embedded tab or newline), when they are validated, then they are rejected as the plain form is.
- [x] Given an `addMark` step that adds a link with a disallowed scheme, when the result is validated, then I9 is reported.

**Evidence:** `src/validate/marks.test.ts`, "link schemes (CDM-038)": `href` and `title` within their bounds; http, https, mailto and `#` targets pass; `javascript:`, `data:`, `file:`, `run:`, `ftp:` and `//` are I9; mixed case, leading space, an embedded tab or newline and an entity are refused like the plain form; an `addMark` step that adds a `javascript:` link gives I9 on the result.

**Notes:** Opening links with `noopener` and `noreferrer` is FE's and SEC's. The URL emitter in the LaTeX converter applies the same allow-list again (09 §4).

### CDM-039 Define suggestion marks that coexist

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Suggester |

**Spec:** 03 §5 (`ins`, `del`, `fmt` and the rules after the table), §8 (I11) · **Requirements:** R8 · **Depends on:** CDM-008, CDM-037

As a suggester, I want my suggested insertions, deletions and formatting changes to sit beside other people's on the same text, so that one person's suggestion never replaces another's.

**Acceptance criteria**

- [x] Given `ins`, `del` and `fmt` marks, when they are validated, then each carries `id` and `user`, and `fmt` also carries `before`.
- [x] Given one user's `ins` mark on a text range, when another user adds an `ins` mark to the same range, then both marks are present afterwards; adding one never removes the other.
- [x] Given a `del` mark, when the document is read, then the text is still in the document until the suggestion is accepted.
- [x] Given a suggestion mark, when it carries a time attribute of any kind, then it is rejected: marks carry no time, and the time of a suggestion is the server time of the commit that introduced its `id`.
- [x] Given a document in which one suggestion `id` appears with two different `user` values, when it is validated, then a violation is reported (an `id` belongs to the user who first used it).
- [x] Given `user` and `fmt.before`, when they are set, then `user` follows the identity grammar of CDM-002, and `before` records the previous marks or attributes in the shape of CDM-002, passing the same grammars and a size bound.

**Evidence:** `src/validate/marks.test.ts`, "suggestion marks that coexist (CDM-039)": `ins`, `del` and `fmt` carry `id` and `user`, `fmt` also `before`; a second user's insertion on the same text keeps the first (addMark step); deleted text stays in the document and its canonical form, and `suggestionsOf()` reads it as a deletion; a time attribute is refused; one identifier with two users is I2 `suggestion_user`; `user` by its grammar and `before` by the shape of CDM-002 and the grammars of the marks it records, within 4 KiB.

**Notes:** Phase 1b: 11 §4 puts "everything in 03" in the CDM at 1b, while suggestion mode and enforcement are phase 2. The check that `user` equals the submitting user and that an `id` is not taken over by someone else is the authority's (P4, PRM-014). Accept and reject, and the time index, are FE and HIS. The one-user-per-`id` criterion is derived from 03 §5, not listed as an invariant. Second review (2026-11-06, SPK-027), SR-M14: imported tracked changes carry author labels (07 §15), which the `user` check refuses; the review proposes an exception for commits with origin `import`, and keeping the revision dates and author strings in the source map, since marks carry no time ([review](../review/2026-11-06-second-review.md)).

### CDM-040 Suggest changes to whole paragraphs, rows and tables

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Suggester |

**Spec:** 03 §5 (last bullet), §13 (last bullet); 04 §4; 07 §17; review M-11 · **Requirements:** R8 · **Depends on:** CDM-039, CDM-027

As a suggester, I want to suggest a new or removed paragraph, a paragraph style change, or a new or removed table row or table, so that structural suggestions work as well as text suggestions.

**Acceptance criteria**

- [x] Given `ins`, `del` or `fmt` as a node mark, when it is on a `paragraph`, a `table_row` or a `table`, then it is accepted; on any other node (`table_cell`, a column, `figure`, `region`, `story`, `equation_block`, `toc`, `extension_block`) it is rejected.
- [x] Given an `ins` or `del` node mark on a block, when the document is read, then it denotes a suggested new or removed block; given `fmt`, it denotes a change of paragraph style, alignment or list level, with `before` recording the previous values.
- [x] Given a `fmt` node mark whose `before` names an attribute that is not a paragraph style, alignment or list level, when it is validated, then it is rejected.
- [x] Given `addNodeMark` and `removeNodeMark` steps, when their results are validated, then the invariants are checked on the result as for every step type (CDM-013).
- [x] Given a table cell or a column, when a block-level suggestion is attached, then it is rejected, because block-level suggestions for them are not defined.

**Evidence:** `src/validate/marks.test.ts`, "suggested changes to whole paragraphs, rows and tables (CDM-040)": node marks pass on a paragraph, a row and a table and are I1 on a cell, a region, a figure, an equation and a toc; `suggestionsOf()` reads `ins` and `del` node marks as new and removed blocks and `fmt` with its previous values; a block `fmt` that records anything but style, alignment or list level is I11 `fmt_before`; the results of `addNodeMark` and `removeNodeMark` steps are validated in full; no column node exists and a cell refuses block suggestions.

**Notes:** Review M-11 (formatting suggestions on blocks). Open: block-level suggestions for table cells and columns (03 §13), and the precise P4 rules beyond paragraphs and whole rows (07 §17, review §6 item 6). The view draws block suggestions as decorations, never as wrapper elements (FE).

## Formatting cascade and layout semantics (03 §6, §7)

### CDM-041 Resolve formatting through the cascade

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Author |

**Spec:** 03 §1 (principle 5), §6; ADR 0004 · **Requirements:** R1, R5 · **Depends on:** CDM-016, CDM-017, CDM-019, CDM-025, CDM-037

As an author, I want formatting to come from styles in a fixed order, so that changing a style restyles every paragraph that uses it, and the editor, the PDF and the DOCX agree.

**Acceptance criteria**

- [x] Given a paragraph, when its properties are resolved, then the layers apply in this order, later overriding earlier: the defaults from `settings` and the default paragraph style; the table style, for content inside a table; the paragraph style chain from the root of the `basedOn` chain to the style itself; the numbering level's paragraph properties, for numbered paragraphs (Word's order, owner decision 9 of 2026-11-15); the direct paragraph attributes. There is a test with conflicting values for each adjacent pair of layers (writers and the layout engine MUST resolve in this order).
- [x] Given a run, when its properties are resolved, then after the paragraph's resolution the layers continue with the run properties of the resolved paragraph style, then the character style chain, then the direct marks.
- [x] Given a toggle mark with `value: false` on text whose style switches the property on, when it is resolved, then the property is off; given a mark with `value: true` on text whose style has it off, then it is on.
- [x] Given an attribute that is null ("not set here; inherit"), when the layers are resolved, then it is skipped and the value comes from an earlier layer.
- [x] Given a change to a style definition's attribute, when a paragraph that uses the style (directly or through `basedOn`) is resolved again, then it shows the new value although no paragraph node changed; no function of the package writes resolved values into content.
- [x] Given a `basedOn` chain that is cyclic or longer than ten styles (which I5 normally prevents), when it is resolved, then the resolver returns a typed error and terminates.
- [x] Given the shared fixtures, when the layout engine and the LaTeX and DOCX writers import the resolver and run them, then their resolved values equal the fixture values.

**Evidence:** `packages/model/src/cascade/resolve.ts` (`resolveParagraph`, `resolveRun`, `resolveLabelRun`, base values `BASE_PARAGRAPH` and `BASE_RUN`) on top of `styles.ts` (`styleTable` now also collects numbering definitions and settings; `styleChain` returns typed errors). `packages/model/fixtures/semantics/cascade.json`, run by `src/cascade/semantics-fixtures.universal.test.ts`: conflicting values for each adjacent pair of layers (default style and table style, table style and numbering level, numbering level and paragraph style, paragraph style and direct attributes), the chain from its root to the style, runs through character style chains and marks, toggles off and on, null as inherit, and the errors `style_cycle`, `style_chain_too_long` and `style_missing`. `src/cascade/resolve.property.test.ts` (fast-check: the last layer that sets a value wins, a style counts once, toggles). `src/cascade/resolve.universal.test.ts`: a changed style shows on the next resolution with no paragraph changed; resolving a deeply frozen document leaves it unchanged; a broken character style chain is a typed error. Criterion 7, in part (lane w1, 2026-11-15): `packages/layout/src/flow.ts` now imports `resolveParagraph`, `resolveRun` and `resolveLabelRun` and has no cascade of its own; `packages/layout/src/cdm-041-cascade-fixtures.test.ts` (Node.js, 28 tests) runs the 27 cases of `cascade.json` through `toFlow` and compares the flow paragraph, its text run and its label with the fixture values. `packages/export-latex/src/cdm-041-converter-fixtures.test.ts` (Node.js, 28 tests) converts the 27 cases and reads the setters written to `main.tex` and `styles.tex`. Owner decision 9 of 2026-11-15 ([docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md); lane w6, 2026-11-17): the numbering level now comes after the paragraph style chain (03 §6 items 3 and 4 swapped; `resolveParagraph` applies the level after `l.high`; ADR 0032 row and open question 1). `cascade.json` has 28 cases: `numbering-level-over-paragraph-style` (was `paragraph-style-over-numbering-level`) and the new `direct-over-numbering-level`; `resolve.property.test.ts` checks the new order. Criterion 7, DOCX side: `packages/export-docx/test/cdm-041-word-cascade.test.ts` (Node.js, needs Microsoft Word; `pnpm exec vitest run --project node packages/export-docx/test/cdm-041-word-cascade.test.ts`) writes each of the 25 cases without a typed error with `writeDocx`, opens all of them in one Word instance through `tools/word-cascade/read-word-paragraphs.ps1` (Word COM, read-only), and compares Word's own resolved paragraph format and character font with the fixture values: it passes for every compared property (about 16 s on this machine, Microsoft Word installed on Windows 11, 2026-11-17). Not compared: `contextualSpacing` (Word's object model cannot read it from a paragraph; the fixture expects only `false`), `borders`, `shading` (expected only as null), the numbering label's run (`labelRun`; Word has no property for it, and the LaTeX side compares it) and the three typed-error cases (the writer warns and keeps direct formatting).

**Notes:** A fixed order is normative (03 §6, a MUST). Both `numbering` on the paragraph and `numbering` on its style can exist; which wins is not stated (see Open questions). The base values used when neither `settings` nor the default style sets a property are not stated. The engines are FE-076, FE-077 and EXP-002, EXP-042; the DOCX writer is in 09 §11. Proposed in ADR 0032: the base values; a style counts once, at the first layer that reaches it, so a table style overrides `Normal` in tables (S7 question 1); a paragraph's own `numbering` replaces its style's whole; `tabs`, `borders` and `shading` are whole values. 03 §6's order for numbering and style indents is kept; whether Word's order (the level after the style) should replace it is the owner's question (S7 question 2). Criterion 7 is met on the strength of the notes that follow: the layout, the LaTeX converter and, since lane w6, Word itself on the DOCX writer's output. (Older note: (7) waited for the layout engine to import the resolver; `packages/layout/src/flow.ts` is still a spike stand-in and does not import `@docedit/model`'s cascade. Lane V-CDM-028-053 (round 9) added `packages/export-latex/src/cdm-041-cascade-fixtures.test.ts` and `packages/export-docx/src/cdm-041-cascade-fixtures.test.ts`: each runs the 27 cases of `cascade.json` through `resolveParagraph`, `resolveRun` and `resolveLabelRun` from `@docedit/model`, the functions the writer calls (Node.js, `pnpm vitest run --project node`, 27 passed in each). Those tests do not run the writers' own converter output, so the criterion stays open. Lane w1 (2026-11-15), criterion 7: two of the three sides now run the fixtures on their own output. Layout: the spike cascade in `flow.ts` (`paraValue`, `runValue`, the local `Numbering` class) is removed and the model's resolver is called instead; a broken chain does not stop the layout (the table style, then the paragraph's own style, is left out, and a default paragraph style that is not defined counts as one that sets nothing). Three values changed with it, all to the model's: `widowControl` is on when no layer sets it (the spike had off), a numbering level without `indentLeft` no longer forces a left indent of zero, and `exact` or `atLeast` without a `lineSpacing` takes the base value 1000 twips (the spike had 240). `pnpm exec vitest run --project node packages/layout` passed afterwards with the digests of `layout.universal.test.ts` unchanged (49 files passed, 5 skipped; 410 tests passed, 12 skipped). The flow does not carry `dir`, `borders`, `shading`, `contextualSpacing` (it is applied to the gaps), `smallCaps`, `highlight` or the run `lang`; the test lists them and fails if a fixture expects any other property it does not compare. LaTeX: the converter test compares every expected property that a setter or a run wrapper carries, and lists those that none carries (`spaceBefore`, `spaceAfter`, `contextualSpacing`, `keepNext` and `pageBreakBefore`, which `blocks.ts` applies between blocks; `borders` and `dir`, which the class does not set yet; the run `lang`). Still open, so (7) stays unticked: the DOCX writer. It writes styles and direct properties and leaves the cascade to Word, so its resolved values are what Word computes from the file. Checking them needs Word's order (ECMA-376 Part 1 §17.7.2) applied to the written parts, or Word itself; neither is built, and the order question (S7 question 2, ADR 0032) is the owner's. The properties the flow and the setters do not carry are also not compared on those two sides.) Lane w6 (2026-11-17): owner decision 9 applied (see Evidence). Running Word on the DOCX writer's output found three writer gaps, now fixed in `packages/export-docx/src/writer.ts`: (a) Word lets the paragraph style chain, `Normal` included, override a table style, while the model lets the table style win (ADR 0032, S7 question 1); the writer now writes the resolved value as a direct paragraph or run property where a table style gives it and the paragraph's style chain also sets it (`tableShadowed`). (b) Word adds a paragraph's tab stops to its styles' stops while the model replaces them; the writer now writes `clear` stops for the inherited stops the paragraph does not keep, and one stop per position. (c) `w:ind` from a numbering level was already written as a direct value; its comment now follows the decided order. The DOCX writer therefore writes direct formatting in these cases, which is the cost of agreeing with the model's order in Word. One question stays for the owner: tab stops of a style that is based on another style merge in Word and replace each other in the model; no fixture covers it, so nothing was changed.

### CDM-042 Compute list, heading, caption and cross-reference labels once

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Author |

**Spec:** 03 §4.1 (`numbering_def`), §4.3, §4.4 (`seq`, `ref`), §7 (Numbering); 09 §3.1; ADR 0004 (after the first review); review M-4 · **Requirements:** R1, R5 · **Depends on:** CDM-005, CDM-019, CDM-026, CDM-036

As an author, I want list numbers, heading numbers, caption numbers and cross-reference labels to be identical in the editor, the PDF and the DOCX, so that the document reads the same everywhere.

**Acceptance criteria**

- [x] Given a document, when labels are computed, then one function returns a label for every numbered paragraph, `seq` caption and numbered equation block, computed from `numbering_def`, `numbering`, `listId`, `numberingRestart` and document order, across regions and table cells; no other code path computes list labels.
- [x] Given a level `format` of `decimal`, `lowerLetter`, `upperLetter`, `lowerRoman`, `upperRoman`, `bullet` (the level's `bulletChar`) or `none`, and a `text` template, when labels are computed, then each placeholder `%1` to `%9` is replaced by the counter of that level in that level's format, `start` sets the first value, and `legal: true` shows all higher levels as decimals.
- [x] Given two lists that use one definition with different `listId` values, when labels are computed, then they number independently; given the first paragraph of a list is deleted, the remaining paragraphs are numbered as one list.
- [x] Given the fixtures of CDM-005, when labels are computed for restarts, skipped levels, and lists interrupted by tables or regions, then the labels equal the expected values.
- [x] Given a `ref` to a numbered paragraph, a caption or an equation, when it is evaluated, then it prints the label that item carries, as literal text.
- [ ] Given the LaTeX converter and the DOCX writer, when they emit a label, then they print the function's output as literal text and use no counters of their own; page numbers are the one exception and are not computed here.
- [x] Given a 100-page reference document, when one paragraph is edited, then recomputing the affected labels fits the typing budget (target: keystroke to paint 16 ms at the median and 50 ms at the 95th percentile, of which this is a part), as reported by the performance harness.

**Evidence:** `packages/model/src/numbering/labels.ts` (`computeLabels`, `referenceText`, `counterEffects`) and `format.ts`. `packages/model/fixtures/semantics/numbering-lists.json` (every format, templates, `start`, `legal`, restarts, `restartAfter`, skipped levels, two lists on one definition, a first item deleted, lists across a table and a region, headings numbered by styles), `numbering-sequences.json`, `numbering-footnotes.json`, `numbering-references.json` and `numbering-projections.json`, run by `src/cascade/semantics-fixtures.universal.test.ts` in Node.js and three browsers. `src/numbering/labels.property.test.ts` (fast-check: labels stable under unrelated edits, list instances independent, a list without restarts numbers 1, 2, 3 whatever was deleted, a projection with the effects shows the full document's labels). `src/numbering/labels.universal.test.ts`: a ProseMirror document gives the same labels as its JSON. `src/numbering/corpus.test.ts`: on the corpus documents of 1 to 300 pages every numbered paragraph is labelled, every `seq` number equals the corpus's own count, and every reference resolves. Criterion 7 (lane w6, 2026-11-17): `packages/perf/scripts/model-costs.ts` now also measures `computeLabels` after one paragraph was edited (a word typed at a different paragraph for each of 60 samples on `pages-100`, 20 on `pages-300` and `pages-1000`; the whole-document computation, with the unedited document's style table and again with a table built for each edit); `pnpm exec node scripts/model-costs.ts` from `packages/perf`, Node.js 22.18.0 on the reference machine of ADR 0037 (Intel Core i9-10900KF, profile rate 1, owner decision 22), 2026-11-17, result in `test-results/model/2026-11-18T00-40-33Z.json`. `pages-100`: median 1.17 ms, 95th percentile 2.24 ms (with a style table built for each edit: median 1.54 ms, 95th percentile 2.82 ms); `pages-300`: median 3.1 ms, 95th percentile 4.9 ms; `pages-1000`: median 30 ms, 95th percentile 43 ms. Against the keystroke budget of 16 ms and 50 ms for the whole path to paint, the labels take about 7 % of the median and 4 % of the 95th percentile on 100 pages. It is a Node.js measurement of the function, not of the web view's keystroke path (FE-119 and FE-120 measure that). Criterion 1, no other code path (lane w1, 2026-11-15): `packages/layout/src/cdm-042-label-source.test.ts` and `packages/export-latex/src/cdm-042-label-source.test.ts` (Node.js, 1 and 3 tests) replace `computeLabels` with a version that returns marked labels and run a document with a two-level list, a list item in a table cell and a heading numbered through its style. The layout's flow, the LaTeX converter and the HTML writer print the marked label for every numbered paragraph, the Markdown writer for every one outside a table, and none prints a real label (`(iv)`, `(v.a)`, `Part IV`), which a second counting path would.

**Notes:** Review M-4. The algorithm is exposed to FE and EXP through the package. Footnote marks are not named in 03 §7 (see CDM-005). The converter is EXP-002, EXP-042; the harness is FND-007. The counting rules are in ADR 0032 (proposed). Not met: (1) `computeLabels` returns every label and is tested, but the spikes in `packages/layout/src/flow.ts` and `packages/export-latex/src/numbering.ts` still compute list labels of their own until FE-077 and EXP-002 switch to it. (6) waits for the converter and the DOCX writer. Lane U-CDM-028-053 (round 6): the LaTeX converter, the HTML and Markdown writers, the layout and the DOCX writer take list labels from `computeLabels`, so the layout's own list numbering is gone; but the DOCX writer writes Word's native numbering (`writer-styles.ts`, `w:numFmt` and `w:lvlText`; `writer.ts`, `w:numPr`), so Word counts the list labels itself and criterion (6) is not met. The choice is open in `docs/adr/0353-lane-U-CDM-028-053.md` (round 6, item 1). Lane V-CDM-028-053 (round 8) did not change the DOCX writer: criterion (6) asks for literal text, which would replace Word's native lists, and that choice is the owner's (recorded in `docs/adr/0353-lane-V-CDM-028-053.md`), so (6) stays unticked. (1) is not ticked either: no test shows that no other code path computes list labels (a source scan would be a proxy). (7) needs the reference machine of 13 §9 and was not run on it; the harness of FND-007 is the owner's. Lane w1 (2026-11-15): (1) is ticked on a behaviour test, not a source scan (see Evidence). What it covers: the code paths that print a list label, which are the layout's flow (the painter and the web view draw from it), the LaTeX converter and the HTML and Markdown writers. The layout's local cascade and `Numbering` class went with CDM-041, so the level's indents and label format also come from the model. The DOCX writer prints no label: it writes Word's numbering definitions and Word counts, which is criterion (6) and stays open for the owner. Found and fixed on the way: the HTML writer dropped the label of a numbered paragraph in a table cell (`cellHtml` in `packages/export-latex/src/html-writer.ts`); it now prints the label of `computeLabels` there too. The Markdown writer still prints no label inside a table cell, by its own rule for cells. (6) and (7) stay unticked for the reasons above. Measured meanwhile (ADR 0032, Measurements; Intel Core i9-10900KF, Node.js 22.18.0, 2026-11-06): `computeLabels` takes 1.4 to 2.4 ms on `pages-100` and 4.6 to 5.8 ms on `pages-300` for a JSON document, 1.5 to 3.3 ms and 5.0 to 9.2 ms for a ProseMirror document. Read restrictions (SR-C3, ADR 0019): a `hidden_region` contributes the counter effect `counterEffects` computes from the full document, so a projection can show the full document's numbers or its own. The owner decided on 2026-11-15 (decision 11, [docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)): the full document's numbers, gaps may show; ADR 0032 and ADR 0019 now say so, and `computeLabels` with the effects already does it (`numbering-projections.json`). Lane w6 (2026-11-17): (7) is ticked on the measurement in Evidence (the earlier note that it was not run on the reference machine no longer holds). (6) stays unticked: the LaTeX converter prints literal labels, but the DOCX writer still writes Word's native numbering and Word counts, and whether to replace it with literal text is the owner's choice, which none of the 25 decisions of 2026-11-15 covers (ADR 0353, round 6, item 1).

### CDM-043 Compute paragraph gaps and line heights once

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 03 §7 (Paragraph spacing, Line spacing); 09 §3.1; review M-14 · **Requirements:** R1, R5 · **Depends on:** CDM-005, CDM-025

As an author, I want the space between paragraphs and between lines to be the same in the editor and the PDF, so that pages break where I expect.

**Acceptance criteria**

- [x] Given two paragraphs where the first has `spaceAfter` 160 and the second has `spaceBefore` 240, when the gap is computed, then it is 240, the larger of the two.
- [x] Given two paragraphs of the same style with `contextualSpacing`, when the gap is computed, then it is zero as settled in CDM-005; given different styles, the larger-of rule applies.
- [x] Given `lineSpacing` under `multiple`, when a line is measured, then the multiple applies to the height of the tallest run on that line, not to a paragraph-wide value.
- [x] Given `lineRule` `exact` or `atLeast`, when a line is measured, then the value is a length in twentieths of a point.
- [ ] Given the fixtures of CDM-005, when the editor's layout and the LaTeX class run them, then both produce the expected gaps and line heights.

**Evidence:** `packages/model/src/spacing/gaps.ts` (`paragraphGap`, `flowGaps`) and `lines.ts` (`lineHeight`). `packages/model/fixtures/semantics/paragraph-spacing.json` (160 and 240 give 240; contextual spacing per side for the same and for different styles; container edges; regions, section breaks, tables, figures, cells, stories and footnotes) and `line-spacing.json` (`multiple` per line on the tallest run over mixed run sizes, rounding, inline pictures, empty lines, `exact`, `atLeast`), run by `src/cascade/semantics-fixtures.universal.test.ts`; `src/spacing/spacing.property.test.ts` and `spacing.universal.test.ts`.

**Notes:** Review M-14 (vertical spacing). The functions and fixtures live in `packages/model`; the LaTeX class implements the per-line rule in a callback (09 §3.1), which is EXP's. Proposed in ADR 0032: contextual spacing is per side, as ECMA-376 defines `contextualSpacing`; containers keep the spacing at their edges; regions and section breaks are transparent. Open there: dropping `spaceBefore` at the top of a page, and where the extra space of a `multiple` line goes. Not met: (5) is run for the six two-paragraph body pairs of `paragraph-spacing.json` in both engines (lane U-CDM-028-053, round 7: `packages/layout/src/cdm-043-fixtures.test.ts` on the layout flow and `packages/export-latex/src/cdm-043-fixtures.test.ts` on the `\DEgap` written to main.tex; Node.js, `pnpm exec vitest run` on each, 14 tests passed). Still open for (5): the container flows (`flows`), the footnote pair, the table and container-edge pairs, and the line-height cases of `line-spacing.json` on the LaTeX side; (5) stays unticked until these run. Lane U-CDM-028-053 (round 2), layout side: `applyContextualSpacing` in `packages/layout/src/flow.ts` now leaves two adjacent paragraphs with a gap of the larger of `spaceAfter` and `spaceBefore`; the layout had added them (8 pt and 12 pt gave 20 pt, not 12 pt). `packages/layout/src/cdm-043-gap.test.ts` (Node.js, `pnpm exec vitest run packages/layout/src/cdm-043-gap.test.ts`, 4 tests) checks the pair cases. Round 2 fix: the layout's contextual spacing is now per side, as ADR 0032 and `paragraphGap` define it (S7's "either" rule is gone); `packages/layout/src/cdm-043-contextual.test.ts` (Node.js, 9 tests) compares the flow with `paragraphGap` for both, upper only, lower only and different styles, and a run of three. The gap change moved the Eigenpal baseline of `form-fields` in `packages/layout/src/layout.universal.test.ts` (fixed stub `e6541fe8` to `0d7c9238`, table stub `135b3a45` to `0ca761af`); the new digests were recorded on 2026-11-13 with `pnpm exec vitest run packages/layout/src/layout.universal.test.ts` and are the same in Node.js 22, Chromium, Firefox and WebKit. `pnpm exec vitest run packages/layout` then passed in full (43 files passed, 1 skipped; 386 tests passed, 7 skipped, the skips being browser-only tests under Node.js and the opt-in benchmark). Round 3 (lane U-CDM-028-053), layout side: the gap rule now runs once over the whole body, so it crosses section breaks (transparent, ADR 0032), and it runs over paragraphs in table cells and stories (`spaceBlocks` in `packages/layout/src/flow.ts`; `paragraphBlocks` records contextual paragraphs in `ctx.contextual`). `packages/layout/src/cdm-043-containers.test.ts` (Node.js, `pnpm exec vitest run packages/layout/src/cdm-043-containers.test.ts`, 4 tests) checks a cell, a story, a continuous break and a next-page break. `pnpm exec vitest run --project browser packages/layout/src/layout.universal.test.ts` passed in Chromium, Firefox and WebKit with the same digests. Open: at a page break the lower paragraph keeps its `spaceBefore`, as ADR 0032 leaves open (recorded in `docs/adr/0353-lane-U-CDM-028-053.md`). Lane U-CDM-028-053 (round 5), layout side of the line heights: `packages/layout/src/cdm-043-line-heights.test.ts` (Node.js, `pnpm exec vitest run packages/layout/src/cdm-043-line-heights.test.ts`, every case of `line-spacing.json` through `breakParagraph`) finds the heights within half a twip. The layout does not round `multiple` heights to whole twips (the `rounding` case gives 290.95 for 291); rounding would move the digests of `layout.universal.test.ts`, so the choice is recorded for the layout's owner in `docs/adr/0353-lane-U-CDM-028-053.md`. Still not run: the LaTeX converter over `line-spacing.json` and `paragraph-spacing.json` (the converter already calls `paragraphGap`), and the layout over `paragraph-spacing.json`. TeX Live is installed (`E:\texlive\2025`), so a compile harness is the next step. Criterion (5) stays unticked until both engines run. Lane V-CDM-028-053 (round 8), LaTeX side, compiled: `packages/export-latex/src/cdm-043-gap-compile.test.ts` (Node.js, local `lualatex` through `test/cdm-local-tex.ts`, six body pairs of `paragraph-spacing.json`, about six minutes). Each pair is compiled with the fixture's spacing and again with no spacing; the gap is the difference of the distances between the two paragraphs' blocks in `main.layout` (`blocks`), and it must equal the expected gap within one twip. All six pass (the measured gaps are the fixture's 240, 300, 0, 240, 120 and 160 twips within one twip). Still not run on the LaTeX side: the `line-spacing.json` cases, the container flows, the footnote pair and the table and container-edge pairs. Criterion (5) stays unticked. Lane w1 (2026-11-15), layout side: `packages/layout/src/cdm-043-flows.test.ts` (Node.js, `pnpm exec vitest run --project node packages/layout/src/cdm-043-flows.test.ts`, 8 tests) runs the seven `flows` of `paragraph-spacing.json` through `toFlow` and compares every gap of every container the fixture lists: the body across a region and a section break, table cells with and without a table style, a figure and an equation, a footnote and a header story, the leading and trailing gaps included. One flow failed first: the caption of a figure kept its style's space after, so a figure followed by an equation had a gap of 160 twips where the fixture has 0 (a figure has no spacing of its own, ADR 0032). `blockOf` in `packages/layout/src/flow.ts` now gives a figure's caption no space after; the space before the caption stays, since it lies inside the figure. `pnpm exec vitest run --project node packages/layout` passed afterwards with the digests unchanged (52 files passed, 5 skipped; 447 tests passed, 12 skipped). With the pair, contextual and line-height tests of the earlier rounds, the layout side runs every fixture case except the `consecutive-footnotes` pair. (5) stays unticked for the LaTeX side: the class has not run the `line-spacing.json` cases (they need a compile with runs of the fixture's natural heights), the flows, or the footnote, table and container-edge pairs; and the layout's unrounded `multiple` heights (290.95 for 291) are still an open choice in `docs/adr/0353-lane-U-CDM-028-053.md`. Lane w6 (2026-11-17), blocked, nothing new ticked: what remains of (5) is a compile of the class on the fixture cases it has not run (the `line-spacing.json` cases, the `flows`, the footnote pair, the table and container-edge pairs), and those compiles need the local font copy `services/export-worker/out/fonts-local/` that `packages/export-latex/test/cdm-local-tex.ts` reads. That directory does not exist in this worktree (it is build output and git ignores it), it is made from the export worker's Podman image through `fontManifestFromImage`, and the image is not built on this machine (`podman images` lists no export worker image; building it needs the font downloads and a long build, and the sandbox cannot start under this host's Podman machine, ADR 0353). The existing compile tests of this story therefore skip here, and I wrote no new ones that could not run. TeX Live (`E:\texlive\2025`) is present, but a compile with fonts of my own choosing would not be the class run on its own font set. The layout side still lacks the `consecutive-footnotes` pair (two footnotes on a page; the layout test reads one footnote at a time). No owner decision of 2026-11-15 concerns this story. Next step for whoever has the image: build it, run `fontManifestFromImage` to fill `out/fonts-local`, and extend `cdm-043-gap-compile.test.ts` to the `flows` and the footnote pair, and add a `line-spacing.json` compile.
### CDM-044 Resolve tab stops the same way everywhere

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 03 §4.5 (`tabs`), §7 (Tabs), §10; 09 §3.1 · **Requirements:** R1, R5 · **Depends on:** CDM-025, CDM-005

As an author, I want left, centre, right and decimal tab stops with leaders, so that I can align columns of text.

**Acceptance criteria**

- [x] Given tab stops of kinds `left`, `center`, `right` and `decimal`, when a tab is resolved, then the stop's position is measured from the left margin.
- [x] Given a paragraph without a stop beyond the current position, when a tab is resolved, then the next multiple of `settings.defaultTabStop` is used.
- [x] Given a stop with a leader, when a tab is resolved, then the result carries the leader kind.
- [x] Given the fixtures of CDM-005, when the layout engine and the LaTeX class run them, then they agree on stop positions; decimal tabs inside justified text may differ in the LaTeX output and are reported as approximate (CDM-046).

**Evidence:** `packages/model/src/spacing/tabs.ts` (`nextTabStop`, `placeTab`, `decimalIndex`). `packages/model/fixtures/semantics/tabs.json` (stops measured from the left margin, not from the indent; the next multiple of `defaultTabStop`; explicit stops clearing default stops; the hanging-indent stop; left, right, centre and decimal stops; leaders), run by `src/cascade/semantics-fixtures.universal.test.ts`; `src/spacing/spacing.property.test.ts` (fast-check: a tab goes to the nearest candidate strictly to the right). Criterion 4, LaTeX side (lane V-CDM-028-053): `packages/export-latex/src/cdm-044-tabs.test.ts`, run with `DOCEDIT_LUALATEX` and `DOCEDIT_PDFTOTEXT` set to the TeX Live 2025 binaries, `pnpm exec vitest run packages/export-latex/src/cdm-044-tabs.test.ts` (Node.js, locally through `packages/export-latex/test/cdm-local-tex.ts`, because the sandbox cannot start on this host): all 15 cases of `tabs.json` in one document, read with `pdftotext -bbox`; left, default and hanging segments start at their stop, right segments end at it, centre segments are centred on it, and decimal integer parts end at it, each within 1.5 pt. Layout side: `packages/layout/src/cdm-044-tabs.test.ts` (16 tests passed).

**Notes:** The class implements tab stops itself (09 §3.1); that is EXP's. Proposed in ADR 0032: explicit stops clear the default stops to their left; a hanging indent is a stop; a list label is followed by a tab. Open there: the decimal separator, right-to-left paragraphs, and a level suffix other than a tab (a definition change). (4) is met (lane V-CDM-028-053): both engines run `fixtures/semantics/tabs.json`, see Evidence. Leaders are not read on the LaTeX side (every LaTeX case uses `leader: none`). Lane U-CDM-028-053 (round 5), layout side: `packages/layout/src/cdm-044-tabs.test.ts` (Node.js, `pnpm exec vitest run packages/layout/src/cdm-044-tabs.test.ts`) runs every case of `tabs.json` through `breakParagraph` and checks where each segment after a tab ends. The centre rule now rounds the half-width down to whole twips in `placeAfterTab` (`packages/layout/src/lines.ts`), as the model's `placeTab` does; before, the 1001-twip case started half a twip late. Not run: the LaTeX class (TeX Live is installed). The layout returns no leader or alignment, so the test checks segment ends only. Gap found and not fixed: the layout has no hanging-indent stop. With a hanging indent that is not a multiple of `defaultTabStop` (for example a left indent of 500 twips and a tab from 100), the layout uses the default stop (720) where the model uses the hanging stop (500). No fixture case shows it; it is recorded in `docs/adr/0353-lane-U-CDM-028-053.md`.

### CDM-045 Push the body down when a header grows

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | should | Author |

**Spec:** 03 §7 (Header growth), §4.1 (`page_setup`); 09 §3.1; review M-12 · **Requirements:** R1, R5 · **Depends on:** CDM-021, CDM-005

As an author, I want a tall header to push the body down instead of overlapping it, so that nothing is hidden.

**Acceptance criteria**

- [x] Given a header whose height is within the space the page setup gives it, when the body start is computed, then the body starts at the top margin.
- [x] Given a header taller than the space the page setup gives it, when the body start is computed, then the body starts below the header.
- [ ] Given the fixtures of CDM-005, when the layout engine and the LaTeX class run them, then both place the body start identically.

**Evidence:** `packages/model/src/spacing/page.ts` (`bodyFrame`, `headerFor`, `footerFor`). `packages/model/fixtures/semantics/header-growth.json` (a header within its space, exactly filling it, one twip over, a tall header, a growing footer, a Letter page, no room left; which story a page shows), run by `src/cascade/semantics-fixtures.universal.test.ts`; `src/spacing/spacing.property.test.ts`.

**Notes:** Review M-12 (header mapping). 03 §7 states the rule for headers only; whether footers behave alike is decided in CDM-005. Proposed in ADR 0032: footers grow upwards as headers grow downwards, and a null header or footer slot means none, with no fallback. Not met: (3) is open as a whole (lane V-CDM-028-053, round 1). The LaTeX side now runs locally: `packages/export-latex/src/cdm-045-header-growth.test.ts` (`DOCEDIT_LUALATEX` set to TeX Live's `lualatex`; the sandbox cannot start on this host, see ADR 0353). Each frame with a `top` places the body start at the fixture's `top` relative to a no-header reference, within one twip, for the seven frames with room for the body. The no-room frame (`nothing-left-for-the-body`) differs: the fixture puts its body on page 1 with height 0, and TeX sets the first body line on page 2 at the same top; the test accepts that for now, and the layout side does not run no-room frames. Which placement is intended is open (ADR 0353, for the owner). The body's end (`bottom`) is not measured. Lane U-CDM-028-053 (round 5), layout side: `packages/layout/src/cdm-045-header-growth.test.ts` (Node.js, `pnpm exec vitest run packages/layout/src/cdm-045-header-growth.test.ts`, 7 frames) runs `paginate` with a header and a footer story and checks where the first body line starts: the larger of `marginTop` and `headerDistance` plus the header, with one twip over pushing by one twip, the tall header and the Letter page. Not checked: the body end, because the layout does not expose it, and the `slots` cases. Round 7, LaTeX side: the class was run. `packages/export-latex/src/cdm-045-header-growth.test.ts` compiles each frame with a `top` (8 frames, footers included) with `lualatex` on this machine through `packages/export-latex/test/cdm-local-tex.ts`, not the Podman sandbox, and compares the body start in `main.layout` with a document without a header. A review run failed on `tall-header` (2.88 twips off, tolerance 1 twip); the change that removed the gap was not identified. Two later runs on 2026-11-13 (`pnpm vitest run --project node packages/export-latex/src/cdm-045-header-growth.test.ts`) measured 768.0 twips for `tall-header` (fixture 2208 − 1440 = 768) and passed all 8 frames. With no room for the body (`nothing-left-for-the-body`) the class ships page 1 with an empty body and sets the first line on page 2, at the frame's top (9708). ADR 0032 leaves this to pagination, so the test reads that frame on the first page with a body start. (3) stays unticked: the layout side does not run that frame, and neither side runs the body end or the `slots` cases. Lane w1 (2026-11-15), layout side: `packages/layout/src/cdm-045-slots-bottom.test.ts` (Node.js, `pnpm exec vitest run --project node packages/layout/src/cdm-045-slots-bottom.test.ts`, 11 tests) runs the two parts the layout had not run. The body end: for the five frames that state a `bottom` and leave room (`header-fits`, `tall-header`, `footer-grows-upwards`, `letter-page-with-both`, `no-header`) the page is filled with lines of 10 twips, and the last line `paginate` keeps on the first page ends at the fixture's `bottom` to within one line, with the fixture's `height` in lines. The `slots`: all five cases, read from the story fragment each page carries in its header and footer, with the first page odd or even through `pageNumberStart`. So the layout side now runs every part of `header-growth.json` except the no-room frame. (3) stays unticked for two reasons: the LaTeX class has not run the body end or the `slots` cases (both need compiles that read the footer's place and which story a page prints), and where the body goes when no room is left is still the owner's question (ADR 0353), so the two sides cannot be called identical on that frame.

## Writer support (03 §10)

### CDM-046 Publish writer support as data

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | should | Integrating developer |

**Spec:** 03 §1 (principle 4), §10; ADR 0004; 09 §3.2 · **Requirements:** R5, R14 · **Depends on:** CDM-006

As an integrating developer, I want a table that says which constructs each writer supports, so that I know in advance what the PDF and the DOCX will do with my content.

**Acceptance criteria**

- [x] Given the definition, when CI runs, then every node type, mark, `field` kind and page-setup feature has an entry in the support table (supported, partial, fallback, not applicable), and a missing entry fails the build.
- [x] Given the entries, when CI runs, then no construct in the model has "no" for the LaTeX writer or the DOCX writer, because a construct enters the model only when LaTeX can typeset it and DOCX can approximate it (principle 4).
- [x] Given the limits named in 03 §10 (tables inside multi-column sections, headers and footnotes cannot span pages; orientation and margin changes force a page break in LaTeX; a `continuous` break that changes margins is unsupported; decimal tabs in justified text are approximate; unsupported math falls back to an image in DOCX), when the table is read, then each appears as a note on its row.
- [x] Given the table, when the documentation is generated, then the published page is generated from the same data.

**Evidence:** `src/definition/writer-support.ts` (data) and `src/definition/definition.test.ts`, "writer support as data (CDM-046)": every node type, mark, `field` kind and page-setup feature has an entry and a missing one fails (`writerSupportProblems`, also run by `pnpm generate`); every page-setup attribute is in one feature; no entry says "no"; the limits of 03 §10 are notes on their rows; `spec/cdm/cdm-1.writer-support.md` and `.json` are generated from the same data.

**Notes:** `watermark`, `gutter`, `pageNumberStart`, `pageNumberFormat`, `hyphenation` and the character effects such as `smallCaps` and `hidden` have no row in 03 §10: see Open questions. The preflight that reads the table in the converter is EXP's (EXP-002, EXP-042).

## Evolution (03 §11)

### CDM-047 Add a feature to a document only when every client has it

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Operator |

**Spec:** 03 §11.1; 05 §1 (rule 4), §5.2; review M-5 · **Requirements:** R6, R9 · **Depends on:** CDM-006, CDM-009, CDM-022; PRO-023; PRO-006, PRO-021

As an operator, I want a document to gain an optional feature only when every connected client can handle it, so that no client is handed content it would drop or fail on.

**Acceptance criteria**

- [x] Given the feature registry, when it is listed, then it names `fields` and `extensions` with the node types and marks of each, and a registered name that equals a protocol feature name fails a check (protocol and CDM features share one namespace, 05 §1).
- [x] Given a commit whose result adds a feature to `requires`, when the room evaluates it, then it is accepted only if every attached client announced that feature; otherwise it is rejected and `requires` is unchanged.
- [x] Given a client that connects to a document whose `requires` lists a feature the client did not announce, when it opens the channel, then it is refused with `unsupported_feature`.
- [x] Given a commit that adds node types of a feature without adding the feature to `requires`, when the result is validated, then I1 is reported.
- [x] Given the package, when a component asks which features it supports and which `cdm` versions, then it returns the lists that `hello` and `ch.open` announce.

**Evidence:** Criteria 2 and 3 (lane U-CDM-028-053, Node.js, `pnpm exec vitest run` on both files, 74 tests passed): `packages/authority/test/features.test.ts`, "features per channel (03 §11.1; CDM-047)": a feature-adding commit is accepted only when every attached client announced the feature, and is otherwise refused with `requires` unchanged (the room opts in with `RoomInit.requiresGrowth`, off by default); a channel whose client lacks a required feature is refused with `unsupported_feature`. `services/document-service/test/data-plane/session-1b.test.ts` refuses `ch.open` with `unsupported_feature` for an unannounced or missing feature. Criteria 1, 4 and 5: `src/definition/features.ts` and `src/definition/definition.test.ts`, "the feature registry (CDM-047)": `featureRegistry()` names `fields`, `extensions` and `preserve` with their nodes, marks, attributes and values; `namespaceProblems()` checks the names against the published protocol registry (`spec/dep/dep-1.registry.json`) and fails a CDM feature named after a protocol feature of another epic; a feature node without the feature in `requires` is I1. Criterion 5: `packages/model/src/definition/supported.test.ts` ("what the package supports (CDM-047, CDM-050)"): `supportedFeatures()` returns the registry's feature names once each, `mayOpen()` names the features a client lacks, and `supportedVersions()` returns `min` and `max`; the engine's `hello` and `ch.open` take their feature lists from `supportedFeatures()` and `mayOpen()` (`packages/engine/src/core.ts`); the engine announces its `cdm` from its own `CDM_VERSION` constant (1), not from `supportedVersions()`, so that one value is not yet shared.

**Notes:** Review M-5. Pure decision functions live in the model package; the room and gateway call them (SYN-011 for commits, PRO-023 for channels). The rejection code of a refused feature-adding commit is not named in the spec: see Open questions. Criteria (2) and (3) are now met: the room calls `mayAddFeatures()` and `mayOpen()` (`packages/authority/src/room/room.ts`) and the document service calls `mayOpen()` (`services/document-service/src/data-plane/session.ts`). Growth of `requires` stays off unless the host sets `RoomInit.requiresGrowth`; the spec does not name the rejection code of a refused feature-adding commit, and the room uses `conflict` with action `drop` (see Open questions). (5) is ticked for the package's functions; the engine's `hello` and `ch.open` call them (`packages/engine/src/core.ts`).

### CDM-048 Extend nodes and marks additively through `ext`

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 03 §4 (opening paragraph), §11.2; 04 §4; review M-5 · **Requirements:** R6 · **Depends on:** CDM-008, CDM-002

As an integrating developer, I want to attach my own additive data to nodes and marks without a new major version, so that older readers keep it instead of dropping it.

**Acceptance criteria**

- [x] Given every node and mark, when the JSON Schema and the ProseMirror schema are inspected, then each declares `ext` with default `{}`.
- [x] Given a node or mark with non-empty `ext`, when it is read, written, canonicalised and round-tripped through ProseMirror, then `ext` comes back unchanged, so no reader drops it.
- [x] Given an `ext` key, when it has no namespace in the form fixed by CDM-002, then it is rejected (I11).
- [x] Given an `ext` equal to `{}`, when the document is canonicalised, then it is omitted; given a non-empty `ext`, it is part of the canonical form and of the hash.
- [ ] Given two releases within one `cdm` major version, when CI compares their generated schemas, then it fails if a node or mark gained or lost a top-level attribute: new optional attributes enter inside `ext`, and an attribute moves out of `ext` only at the next major version.
- [x] Given `ext` exceeds the size bound of CDM-002, when it is validated, then it is rejected.

**Evidence:** Criteria 1 to 4 and 6: `src/definition/definition.test.ts`, "additive attributes in ext (CDM-048)": every node and mark declares `ext` with default `{}` in the JSON Schema and the ProseMirror schema; a non-empty `ext` on a node and a mark survives reading, writing, canonicalising and ProseMirror; a key without a namespace is I11; `ext: {}` is omitted and a non-empty one changes the hash; an `ext` above 4 KiB is I11.

**Notes:** Review M-5 (ProseMirror silently drops undeclared attributes). An `attr` step replaces an attribute as a whole, so two extensions writing different keys of one node's `ext` concurrently overwrite each other; this is at odds with the one-attribute-per-property principle of 03 §4.1 and is listed under Open questions. Not met: (5) no release of CDM 1 exists to compare against, and the comparison in CI is not built. Lane model-2 (round 1) built the comparison itself: `attributeShapeChanges()` in `packages/model/src/definition/evolution.ts` lists the top-level attributes a node or mark gained or lost (`ext` excluded), tested in `packages/model/src/definition/evolution.test.ts`. No CI job calls it yet, so (5) stays unticked. Lane w1 (2026-11-15): still blocked. The criterion needs two things that do not exist here: a released CDM 1 schema to compare against (no release has been made, and choosing a baseline is the owner's), and a job in hosted CI (`.github/` is root configuration). No stand-in baseline was added.

### CDM-049 Write migrations as pure functions with fixtures

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | should | Operator |

**Spec:** 03 §11.3; 04 §3.2; 06 §13; review PD-7 · **Requirements:** R9 · **Depends on:** CDM-007, CDM-010; SYN-005

As an operator, I want each schema migration to be a pure, tested function, so that a version change is predictable and never happens by surprise.

**Acceptance criteria**

- [ ] Given a migration from version n to n+1, when it runs twice on one document, then the two results have equal canonical bytes (pure and deterministic: no clock, no randomness, no I/O).
- [ ] Given each migration, when CI runs, then it ships before and after fixtures; the result validates at n+1 and its canonical hash equals the fixture.
- [ ] Given an attribute moved out of `ext` at the major bump, when the migration runs, then the value is moved and nothing is left behind in `ext`.
- [ ] Given the migration's output, when it is stored, then it is written as a snapshot commit with origin `migration` and a checkpoint on each side; the function returns the new document and the version stamps, and the writing is the service's.
- [x] Given a document at version n opened by a component that supports only n+1, when it is read, then it is refused with `unsupported_cdm` and no migration function runs: no read, parse or validate path starts a migration.

**Evidence:** Criterion 5: `packages/model/src/migrate/migrations.test.ts`, "migrations are pure functions run by one framework (CDM-049)": a reader of version 2 refuses a version 1 document with `unsupported_cdm`, and the version 1 reader refuses a version 2 document the same way; `readDocument()` in `src/validate/read.ts` has no path to the migration framework. Criterion 3's helper `moveExtKey()` (`src/migrate/migrations.ts`) is tested there too, on a test-only attribute; the criterion itself is not met (see Notes).

**Notes:** Framework: `src/migrate/migrations.ts` (`migrate()`, `chainProblem()`, `moveExtKey()`), tested with test-only migrations (`migrations.test.ts`: chain, equal canonical bytes on a second run, input never changed, refusals). Not met: (1) and (3) are properties of real migrations, and no version 2 exists, so no migration has been written; the framework's purity is tested, not any migration's. (2) needs a before and after fixture per real migration. (4) is the service's: it writes the snapshot commit with origin `migration` and the checkpoints; this package only returns the envelope and steps. Phase inferred. The roadmap does not place migrations; risk 6 lists operator-gated migrations as a mitigation, but no major version bump is planned, so the framework is needed before the first change that would increment `cdm`. Enabling a version for a tenant is BE-094.

### CDM-050 Support two CDM versions side by side and keep older packages

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | should | Operator |

**Spec:** 03 §11.3; 08 §3; 04 §5 (step 8); 06 §13; review PD-7 · **Requirements:** R9 · **Depends on:** CDM-049; SYN-014; HIS-005, HIS-045; FND-012

As an operator, I want versions n and n-1 of the model to run side by side and older packages to stay published, so that hosts that pin old components keep working and old history stays readable.

**Acceptance criteria**

- [ ] Given the model package for versions n and n-1, when both are loaded in one process, then one validates a version n-1 document and the other a version n document without interference.
- [ ] Given the package, when a commit is stamped, then it exposes the `cdm` version and an engine and package version identifier for the stamp.
- [ ] Given a checkpoint written before a migration, when history is read, then the older package loads and validates it; given a checkpoint after the migration, the newer package does.
- [ ] Given a release, when the release process runs, then published model packages are never unpublished or overwritten.
- [x] Given the package, when a service asks which `cdm` range it supports, then it returns `min` and `max`, so an operator can check every service node and embedded component before enabling version n+1 for a tenant.
- [ ] Given a release, when its notes are written, then they state the window during which n and n-1 are supported.

**Evidence:** Criterion 5: `packages/model/src/validate/read.test.ts` ("supportedVersions()" returns `{ min: 1, max: 1 }`) and `packages/model/src/definition/supported.test.ts` (`supportedVersions(CDM1)` returns `min` and `max` equal to `CDM1.cdm`). The check across service nodes and components is the operator's, not the package's; the package only reports its range. Criteria 1 to 4 and 6 need version n-1 and a migration, which do not exist yet (CDM-049), or a release process (FND-012).

**Notes:** Phase inferred (see CDM-049). The length of the support window is "a published window" in 03 §11.3 and has no number in the spec. Criterion 2 is not met in this package: the model stamps no commits and has no commit type; the room stamps `cdm`, the engine version and the scopes (SYN-014, `packages/authority`). Round 1 of lane CDM-043-053 found no model code to tick it against. Lane V-CDM-028-053 (round 8): the room stamps `cdm: 1` as a constant and `engine: 'pm-steps/1'` (`packages/authority/src/room/room.ts`, the stamp of each commit), and no package version identifier is stamped anywhere; the packages have no version constant to stamp. (2) stays unticked until the owner decides what the package version identifier is (ADR 0353-lane-V-CDM-028-053). Criteria (1), (3), (4) and (6) need a version n-1 or a release process that does not exist (CDM-049, FND-012).

### CDM-051 Define the preservation feature: preserved atoms, the preserved mark and the preserved attribute

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 03 §4.6, §11.1, §8 (I1, I4, I11); ADR 0017; 00 §5 (A2, decided 2026-11-06) · **Requirements:** R5, R10 · **Depends on:** CDM-006

As a maintainer, I want the model to carry what an imported Word file contains beyond the model's own concepts, so that Word files round-trip without loss as the owner decided.

**Acceptance criteria**

- [x] Given the definition (CDM-006), when it is generated, then it declares `preserved_block` (a block atom, allowed wherever blocks are and in table cells), `preserved_inline` (an inline atom) and the mark `preserved`, all tagged with the feature `preserve`, and a core attribute `preserved` (default null) on the block and definition nodes that ADR 0017 names.
- [x] Given a `preserved` attribute or `props` value, when it is validated, then it must be a JSON element tree (element names with a registered short prefix for the OOXML namespaces and in Clark notation for any other, attribute values and text as strings, depth at most 12, at most 16 KiB of canonical JSON and 32 KiB on `style_def`) or a reference to a `preserved_def`, as 03 §4.6 states after spike S11, and anything else fails I11; no XML text is accepted.
- [x] Given a document with a preserved node or mark or a non-null `preserved` attribute, when `preserve` is missing from `requires`, then it fails I1, and a reader that lacks the feature refuses it (CDM-009).
- [x] Given `fragment` and `fallbackAsset`, when the document is validated with its asset context, then each must be an asset attached to the document (I4).
- [x] Given a preserved atom or a `preserved` attribute, when a commit changes it, then the change needs `edit` in its scope like any other change (the outcome check, 07 §5.1), and no step type is exempt.
- [x] Given the JSON Schema (CDM-007) and the ProseMirror schema (CDM-008), when they are regenerated, then both include the feature, and a round trip of a document with preserved content through ProseMirror returns the same canonical JSON.

**Evidence:** `packages/model/src/schema/check-definition.test.ts`, "declares the preservation feature of ADR 0017" (the two atoms and the mark carry `preserve`; the block atom is in the `block`, `story_block` and `cell_block` groups; every block-level and Word-derived definition node has `preserved`, null by default, an element tree of depth 12 and 16 KiB). `src/validate/validate.test.ts`, "preserved content (CDM-051)": XML text, unregistered prefixes, a Clark name of a registered namespace, number attributes, extra members, a reference with other members and more than 16 KiB are I11, for the attribute and for `props`, and "the depth limit is exact" shows 12 levels pass and 13 fail for both; `src/validate/preserve.test.ts`, "shared trees in preserved_def": 32 KiB on a style and 16 KiB elsewhere, a reference to a missing tree is I4, a shared tree that refers to another is I11; the atoms, the mark and the attribute without `preserve` are I1; an unattached `fragment` or `fallbackAsset` is I4. `src/validate/read.test.ts`: a reader without `preserve` refuses the kitchen-sink fixture. `packages/authority/test/scopes.test.ts`, "preserved content is protected like any other content": changing the atom's attributes, deleting or replacing it, or changing a `preserved` attribute in a restricted region is refused for an editor without a grant and allowed with one. `src/prosemirror/schema.test.ts`: both generated schemas include the feature, and `fixtures/kitchen-sink.json` round-trips through ProseMirror to the same canonical JSON.

**Notes:** new with the owner's decision on A2 (2026-11-06). The grammar limits are targets that spike S11 (SPK-028) confirms or changes before `cdm: 1` is frozen; until then the feature is published as draft, like the footnote model (CDM-001). Second review (2026-11-06, SPK-027): SR-C2, the fifth criterion lets any editor write preserved data, which then reaches the DOCX writer; the review proposes that only import creates preserved values, marks and atoms (clients keep, copy within the document or delete them) and that writers apply a per-position allow-list. SR-M10: inline atoms (equations, pictures, fields) need a `preserved` attribute too. SR-M12: original lexical values and a precedence table for preserved attributes that override modelled ones. SR-M19: the source map's hashes must survive migrations and forks. SR-N12: `table_cell` content in 03 §4.3 omits `preserved_block`, and no list names endnotes ([review](../review/2026-11-06-second-review.md)). ADR 0017 names "block and definition nodes" without a list; the test reads that as every node in the block groups except `extension_block` and the atoms themselves, plus `region`, `section_break`, `story`, `table_row`, `table_cell`, `settings`, `style_def`, `numbering_def` and `page_setup`. The definition also gives `preserved` to the inline atoms `image`, `equation`, `footnote` and `field`, which ADR 0017 leaves to S11 ("Inline atoms without identifiers"); the prose check of CDM-006 flags it. Not decided here. Audit (2026-11-13): criterion 2 is unticked because the code and its tests accept element trees up to depth 12 (`PRESERVED_DEPTH` in `src/definition/shared.ts`; the test in `validate.test.ts` rejects only trees deeper than 12) and require registered-prefix names (a Clark name of a registered namespace is I11), while the criterion, ADR 0017 and ADR 0018 still say depth 8 and Clark notation, and the Evidence line ("deeper than 8") is stale; re-tick once ADR 0017, ADR 0018 and the criterion state the S11 limits. Lane w1 (2026-11-15): done. 03 §4.6 and "Changes from spike S11" in ADR 0017 already gave the S11 grammar (registered prefixes for the OOXML namespaces, Clark notation for any other, depth 12, 16 KiB, 32 KiB on `style_def`, references to `preserved_def`); the "Preserved properties" list of ADR 0017, the table row of ADR 0018 and criterion 2 now say the same, and the code was not changed. Criterion 2 is ticked against that wording. Both ADRs stay proposed: the limits are the spike's, not yet the owner's, and SR-C1 and SR-C2 are still open.

### CDM-052 Define sources, citations and bibliographies in the model

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 03 §1 (principles 1, 4), §13; 09 §3 · **Requirements:** R1, R5 · **Depends on:** CDM-004, CDM-006

As a maintainer, I want citations, their sources and bibliographies in the model, so that academic and technical documents can be written in the editor and typeset with biblatex.

**Acceptance criteria**

- [x] Given the decision of CDM-004, when the model is designed, then a proposed decision record fixes the representation. The starting point is: sources as definition nodes in `defs`, holding data compatible with CSL-JSON, so that they share the log, permissions and history (03 §1 principle 1); a `citation` inline atom naming one or more sources with prefix, suffix and locator; and a `bibliography` block atom. Any alternative is recorded with its reasons.
- [x] Given the definition (CDM-006), when it is regenerated, then the JSON Schema, the ProseMirror schema and the types include the new nodes. Every attribute has a grammar (I11), and there are no floating-point numbers: dates are strings.
- [x] Given a citation, when the document is validated, then every cited source exists (I4), and a source that is still cited cannot be deleted.
- [x] Given the writer-support table (CDM-046), when it is published, then it has rows for sources, citations and bibliographies for LaTeX and DOCX.
- [x] Given a document with sources, when it is hashed, then the canonical form is stable across implementations, with fixtures.

**Evidence:** Decision proposed in `docs/adr/0031-cdm-1-model-completion.md` section 6 (sources as `source_def` with CSL variables, `citation`, `bibliography`, core, `settings.citationStyle` proposed). `src/definition/citations.ts`; `src/definition/definition.test.ts`, "sources, citations and bibliographies (CDM-052)": the nodes are in the JSON Schema, the ProseMirror schema and the types, every attribute has a grammar and dates are strings; cited sources resolve and deleting a cited source is I4; writer-support rows for LaTeX and DOCX. Canonical form: the `all-constructs` fixture of CDM-011 holds a source, a citation and a bibliography, reproduced by the Python implementation.

**Notes:** new on 2026-11-06: the owner decided that the first release serves all three candidate markets (SPK-006), so citations and a bibliography are a version 1 requirement (CDM-004). The choice between CSL styles and biblatex styles for rendering in the editor is open for the decision record. Second review (2026-11-06, SPK-027), SR-M20: the decision record should also fix which citation styles the one house class offers (A3), whether a source is a named feature in `requires`, and the I4, I10 and writer-support rows, before `cdm: 1` is frozen ([review](../review/2026-11-06-second-review.md)).

## Read restrictions (ADR 0019)

Added on 2026-11-06 from spike S12 (SPK-029; `docs/spikes/2026-11-06-s12-read-restrictions.md`), after the owner decided that version 1 can hide regions and field values from some readers (SPK-005). Every other story that serves content, steps, positions, history, search, exports, comments, presence or field values applies the requester's projection: README §2.2 rule 8.

### CDM-053 Add the confidential policy, the placeholder and the redaction marker

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** ADR 0019; ADR 0009; 03 §4; 12 §3.2 · **Requirements:** R3, R13 · **Depends on:** CDM-024, SPK-029

As a maintainer, I want the CDM to define the confidential region policy, the `hidden_region` placeholder of projections and the redaction marker, so that every package handles projections from one definition.

**Acceptance criteria**

- [x] Given the region policy, when the definition is generated, then `confidential` is a third value beside `inherit` and `restricted` in the JSON Schema, the ProseMirror schema and the TypeScript types.
- [x] Given a stored document or a commit that contains a `hidden_region` node or a value equal to the redaction marker, when it is validated, then `validate()` refuses it: both exist only in projections.
- [x] Given the projection schema (the CDM schema plus `hidden_region`), when it is generated from the definition, then the placeholder is an atom block in the body with only `id` and `title`, selectable whole and with no position inside it.
- [x] Given a form field's `sensitive` attribute (12 §3.2), when the generated attribute documentation is read, then it states that the value is readable only by the principals of the read rule (FRW-088), no longer that the attribute is reserved.

**Evidence:** `src/definition/projection.ts`, `src/schema/prosemirror-spec.ts` (`generateProjectionSpec`), `src/prosemirror/index.ts` (`projectionSchema`); `src/definition/definition.test.ts`, "projections (CDM-053)": `confidential` is a policy in the JSON Schema, the ProseMirror schema and the types; a `hidden_region` or a redaction marker in a stored document is I1 (`projection_only_node`, `redaction_marker`); the projection schema (published as `spec/cdm/cdm-1.projection.json`) has the placeholder as an atom with only `id` and `title`, selectable, a leaf, allowed only in the body; the generated documentation of `sensitive` states the read rule of FRW-088.

**Notes:** The spike defines its projection schema in `packages/authority/src/projection/projection.ts`; this story moves the definition into the model. The owner questions of ADR 0019 (titles, default readers) stay open.

## Coverage

| Spec section | Stories |
|---|---|
| 03 §1 Principles 1 and 2 (one tree; plain JSON) | CDM-006, CDM-007, CDM-008 |
| 03 §1 Principle 3 (Word's concepts, not its package) | none: informative |
| 03 §1 Principle 4 (only what every writer can express) | CDM-046 |
| 03 §1 Principle 5 (formatting by reference) | CDM-041 |
| 03 §1 Principle 6 (stable identifiers) | CDM-012 |
| 03 §1 Principle 7 (no floating-point numbers) | CDM-010, CDM-025, CDM-002 |
| 03 §2 Envelope and canonical form, units | CDM-003, CDM-007, CDM-009, CDM-010, CDM-011 |
| 03 §3 Structure | CDM-006, CDM-008, CDM-016, CDM-018, CDM-020, CDM-021, CDM-022, CDM-024 |
| 03 §4 Opening (null inherits; `ext`) | CDM-041, CDM-048 |
| 03 §4.1 Definition nodes | CDM-016 to CDM-023 |
| 03 §4.2 Body containers | CDM-020 (`section_break`), CDM-024 (`region`; `body`) |
| 03 §4.3 Blocks | CDM-016, CDM-025 to CDM-032 |
| 03 §4.4 Inline nodes | CDM-029 (`image`), CDM-030 (`equation`), CDM-032 (`extension_inline`), CDM-033 to CDM-036; `form_field`: CDM-022 (slot) and FRW; comments are not nodes: CDM-007 |
| 03 §4.5 Formatting properties | CDM-017 (table), CDM-025 (run, paragraph) |
| 03 §5 Marks | CDM-037 to CDM-040 |
| 03 §6 Formatting cascade | CDM-041 |
| 03 §7 Layout semantics | CDM-005, CDM-035 (field time zone), CDM-042 to CDM-045 |
| 03 §8 Invariants I1 to I12 | CDM-013, CDM-014, CDM-015; by invariant: I1 CDM-009, CDM-013, CDM-022; I2 CDM-012, CDM-013, CDM-024; I3 CDM-020, CDM-024; I4 CDM-016, CDM-017, CDM-019, CDM-020, CDM-021, CDM-029, CDM-032, CDM-036; I5 CDM-016, CDM-017; I6 CDM-027; I7 CDM-013, CDM-024, CDM-027, CDM-030, CDM-032; I8 CDM-030; I9 CDM-038; I10 CDM-021, CDM-027, CDM-029, CDM-033, CDM-034; I11 CDM-002, CDM-013, CDM-015; I12 CDM-032 |
| 03 §8 I13 to I15 (defined in 12) | none: owned by FRW (CDM-013 and CDM-014 supply the registration point and fixture format) |
| 03 §9 Identifiers | CDM-012 |
| 03 §4.6 Preserved content (feature `preserve`) | CDM-051 |
| 03 §10 Writer support | CDM-046 |
| 03 §11.1 Versions and features | CDM-009, CDM-047 |
| 03 §11.2 Additive attributes | CDM-048 |
| 03 §11.3 Migration | CDM-049, CDM-050 |
| 03 §12 Example | CDM-007, CDM-008, CDM-010, CDM-015 (used as fixture and fuzz seed) |
| 03 §13 Open issues | CDM-001, CDM-004, and Open questions below |
| 12 §3 Document model additions (field, role, rule nodes) | none: owned by FRW (CDM-022 reserves the slots) |

## Open questions

| Question | Source | Stories affected |
|---|---|---|
| The footnote content model (`inline*` or `paragraph+` limited to one) is undecided until spike S1 reports. Proposed in ADR 0031 section 3: `paragraph+` with one paragraph (S1, option B); the owner has not accepted it yet. | 03 §13; review §6 item 3 | CDM-001, CDM-007, CDM-008, CDM-034 |
| Citations and a bibliography are not modelled; they are a version 1 requirement only if the first market is academic writing. ADR 0031 section 6 (proposed) models them as core nodes (`source_def`, `citation`, `bibliography`; CDM-052). | 03 §13; 11 §10 item 6 | CDM-004, CDM-046 |
| Tables in tables, floating figures with text wrap, text boxes and endnotes are excluded from version 1; each needs layout engine and writer support first. No story builds them. | 03 §13 | CDM-027, CDM-029 |
| Section breaks inside regions are excluded; lifting that needs a rule for who may change a page setup. | 03 §13; 07 §17 | CDM-020, CDM-024 |
| `levels` of a numbering definition is one attribute; if concurrent edits prove common it should become child nodes. | 03 §13 | CDM-019 |
| Block-level suggestions for table cells and columns are not defined, and the exact P4 rules beyond paragraphs and whole rows are open. | 03 §13; 07 §17; review §6 item 6 | CDM-039, CDM-040 |
| 03 does not list defaults, enumeration values, integer ranges, colour letter case, the built-in style list ("and the like"), the `bulletChar` list, the addressing form of `field.target`, `ext` key grammar, the shape of `fmt.before`, the inline payload limit, or the format and copy rule of `listId`. The canonical form and I11 depend on them. | Found while writing (03 §2, §4, §5, §8) | CDM-002, CDM-006, CDM-007, CDM-010, CDM-019, CDM-025, CDM-029, CDM-032, CDM-036, CDM-038, CDM-039, CDM-048 |
| The canonical form does not say how empty collections, the order of `requires`, defaults inside object-valued attributes, subtrees (07 §11 hashes a region), or a change of the canonical rules are handled. | Found while writing (03 §2; 07 §11) | CDM-003, CDM-010, CDM-011 |
| The example in 03 §12 gives a page setup the identifier `ps1`, while 03 §4.1 says every non-built-in definition gets a random identifier. | Found while writing (03 §4.1, §12) | CDM-002, CDM-007 |
| 03 §9 settles a split at the start or end of a paragraph but not a split in the middle (which half keeps the identifier). | Found while writing (03 §9) | CDM-002, CDM-012 |
| `restartAfter`, `numberingRestart`, skipped levels, the list instance of a style-carried `numbering`, `listId` on copy, footnote counting, whose `contextualSpacing` counts, boundary behaviour of spacing, and footer growth are not specified. | Found while writing (03 §4.1, §4.3, §7) | CDM-005, CDM-026, CDM-034, CDM-042, CDM-043, CDM-045 |
| When a paragraph has `numbering` and its style also carries `numbering`, which applies is not stated; the base values below the settings and default style are not stated. | Found while writing (03 §6) | CDM-041 |
| I6 says the column spans of each row add up to `grid`; with row spans, covered positions have no cell. | Found while writing (03 §8 I6) | CDM-027 |
| I2 ("never changes"), I3 ("ever removed"), I4 (attached assets) and I8 (math gate) are not functions of the document alone; the spec does not define the context `validate()` needs. ADR 0031 section 1 (proposed) completes the context with `identifierChanges` and `previous`; a change by replacement stays open (CDM-012). | Found while writing (03 §8) | CDM-013, CDM-014, CDM-024, CDM-029, CDM-030 |
| I4 requires every `field.target` to resolve, which would make deleting a referenced bookmark, heading or caption an invalid commit; the spec does not say how the editor handles it. | Found while writing (03 §8 I4) | CDM-036 |
| I4 does not list `settings.defaultParagraphStyle`, and does not require a reference to be of the right `kind` (a `charStyle` naming a paragraph style). Whether header slots must name header stories is not stated. | Found while writing (03 §8 I4) | CDM-017, CDM-018, CDM-021 |
| `story` content is `block+` and `footnote` content is `inline*`, so ProseMirror content expressions cannot forbid the tables and nested footnotes that I10 forbids; the ban on `form_field` in stories and footnotes (12 §3.2) is in no invariant. ADR 0031 sections 2 and 3 (proposed): `validate()` checks these I10 cases itself, and a misplaced `form_field` is I10 `form_field_placement`. | Found while writing (03 §4.1, §8 I10; 12 §3.2) | CDM-021, CDM-022, CDM-034 |
| 03 §7 calls `dateSigned` a `field`, but it is a `form_field` kind (12 §3.3); the `title` field has no data source inside the CDM. | Found while writing (03 §4.4, §7) | CDM-035 |
| `caption` has no `id`, although principle 6 says every block-level node carries one. | Found while writing (03 §1, §4.3) | CDM-029 |
| 03 §11.1 names the features `fields` and `extensions` but does not list their member node types; the rejection code of a commit that adds a feature a client lacks is not named (only `unsupported_feature` for a connecting client). `featureRegistry()` now lists the members of each feature (`packages/model/src/definition/features.ts`); the rejection code is still open. | Found while writing (03 §11.1) | CDM-022, CDM-047 |
| An `attr` step replaces `ext` as a whole, so two extensions writing different keys concurrently overwrite each other. | Found while writing (03 §4.1, §11.2) | CDM-048 |
| `watermark`, `gutter`, page numbering attributes and several character effects have no row in the writer-support table. ADR 0031 section 8 (proposed) gives them rows; EXP to confirm. | Found while writing (03 §4.1, §10) | CDM-020, CDM-046 |
| Which section a `section_break`'s `pageSetup` describes (the one after it or before it) is not stated. | Found while writing (03 §4.2) | CDM-020 |
| No major version bump is planned, so the timing of the migration framework and the length of the n and n-1 support window have no number. | 03 §11.3; 11 §9 risk 6 | CDM-049, CDM-050 |
| The first-market decision is pending. A4 (confirmed 2026-11-06) does not change this epic. A2 was reversed on 2026-11-06 and adds the preservation feature of ADR 0017, which spike S11 tests before `cdm: 1` is frozen. A second review pass over draft 0.2 is still pending. | 11 §10; review §6 item 7; ADR 0017 | CDM-051 |
