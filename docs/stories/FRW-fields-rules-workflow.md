# FRW Fields, rules, workflow, signing, sealing and evidence

**Status:** first draft, 2026-11-06, written from [12 Fields, rules and workflow](../spec/12-fields-rules-workflow.md) (draft 0.1, normative for its sections 3 to 6 and 10), [ADR 0011](../adr/0011-fields-in-tree-and-fill-capability.md), [ADR 0012](../adr/0012-typed-json-rules.md) and [ADR 0013](../adr/0013-signing-stance.md), and the review findings on fields (PD-1, M-1, F2, PR-6, S-06; review sections 2, 3.7, 5 and 6). Not yet reviewed. Every number in a story is a target to validate, not a measurement.

**Scope.** Typed fields assigned to role placeholders; the permission to fill (rules P7 to P9); the rules language as `packages/rules`; the workflow resource and its states; participants, authentication and evidence; the signing ceremony; the final PDF, certificate and seal through a separate signing service; templates, prefill and bulk send; the protocol additions of 12 §10; fill mode and the authoring tools in the frontend (12 §11); export behaviour for fields (12 §12); and the pitfalls of 12 §14 as acceptance criteria. Phases follow 12 §13 exactly. Where §13 names no phase for a story (for example the authoring panels, mirror fields or the static validation limits), the story says "phase inferred" in its Notes.

**Left to other epics (README §2.3).** The reserved field, role and rule nodes in the CDM (CDM); the authority algorithm, rebase and server-authored commit plumbing (SYN); the outcome check itself (PRM; this epic owns the fill rules that extend it); the embedding contract in general, webhook contract and signatures, and the conformance kit machinery (PRO); the webhook dispatcher and workflow tables as deployment (BE); the history service, hash chain and verification tool (HIS); the LaTeX pipeline, typed emitters, reproducibility rules, `layout.json` and the DOCX writer and importer (EXP); spikes S3 and S8 and the owner decisions of 11 §10 (SPK); field rendering in the page view, the recovery journal and the editing surface (FE); shell, panes, command registry, governance and the reference host (UX).

## Document model additions (12 §3)

### FRW-001 Define role placeholders

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | must | Maintainer |

**Spec:** 12 §2, §3.1; ADR 0011 · **Requirements:** R13 · **Depends on:** CDM-022

As a maintainer, I want `role_def` definitions in the CDM schema, so that fields and regions can be assigned to named roles without a document ever naming a person.

**Acceptance criteria**

- [x] Given the generated ProseMirror schema, when a `role_def` with `id`, `name` and `color` is placed in `defs`, then the document validates; given the same node anywhere else in the tree, then validation fails.
- [x] Given a `role_def` that carries any attribute other than `id`, `name` and `color` (for example a user identifier or an e-mail address), when the document is validated, then validation fails, and the grammar of `name` and `color` is declared in the published schema (invariant I11).
- [x] Given a user with `edit` but not `structure`, when a commit adds, renames, recolours or deletes a `role_def`, then it is rejected with `permission_denied` naming the `defs` scope.
- [x] Given a user with `structure`, when a commit adds a `role_def`, then it is accepted and appears in the next `GET /documents/{id}/content`.
- [x] Given two `role_def` nodes, when they are compared with a field's `assignee`, then roles are matched by `id` only, never by name or colour.

**Evidence:** `packages/model/src/fields/fields.test.ts`, "role placeholders (FRW-001)": a `role_def` validates in `defs` and nowhere else; any other attribute is refused, and the published schema (`spec/cdm/cdm-1.schema.json`) declares the grammars of `name` and `color`; a field matches a role by `id` only (I13). Lane FRW-001-013 (2026-11-13): `packages/authority/test/frw-001.role-defs.test.ts`, "FRW-001": a region-only editor (Rita, no document-level `structure`) is refused for adding, renaming, recolouring and deleting a `role_def` with a `defs:` scope, outcome check and room (criterion 3). Lane w4 (2026-11-15): `tests/security/test/frw-001-role-def-content.test.ts` (memory and PostgreSQL, 4 cases pass): against the real document service, an editor's commit over the wire that adds a `role_def` is acknowledged and the next `GET /v1/documents/{id}/content` has the definition at the next seq; a commenter's same commit is refused with `permission_denied` and the content does not change (criterion 4).

**Notes:** Phase from 12 §13 (1b). The node is reserved in CDM version 1 so that adding it later needs no new major version (review M-1). The identifier examples in 12 (`role_tenant`) are not the 16-character form of 03 §9; see Open questions. Lane FRW-001-013 (2026-11-13): criterion 3 is ticked; the same file shows the room stores an owner's added `role_def` (the room side of criterion 4), but criterion 4 stays unticked because the read through `GET /documents/{id}/content` is the content API's (PRO) and no HTTP route is built. The test uses a region-only editor for "edit but not structure", since the role table gives every document `editor` `structure`. Criterion 4 is still not met as written. Lane U-FRW-001-018 (2026-11-13), checked and left open: `services/document-service/test/control-plane/support.ts` runs `GET /content` and `PUT /content` over PostgreSQL, but its data plane is a stand-in (`StubDataPlane.replaceContent` records what it is given), and the room that would hold the stored `role_def` is not on that path, so no test here shows the role in the next read; this needs the outbox and the rooms (SYN, BE) and is not built in this lane. Lane w4 (2026-11-15): criterion 4 is now ticked, because the security harness composes the real data plane (rooms) with the control plane's content route. The document must list the feature `fields` in `requires` and the client must offer it, or the commit is refused with `invalid_op` (I1).

### FRW-002 Define the form field node

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 12 §3.2, §3.3, §3.6 (I15); 03 §4.4, §9; ADR 0011 · **Requirements:** R13 · **Depends on:** FRW-001, CDM-022

As a maintainer, I want the `form_field` inline atom with its full attribute set in the schema, so that fields can sit in sentences and table cells and be validated like any other content.

**Acceptance criteria**

- [x] Given the schema, when a `form_field` is placed in a body paragraph or in a table cell, then the document validates; when it is placed in a header, a footer or a footnote story, then validation fails (not allowed in version 1).
- [x] Given the attributes `id`, `key`, `kind`, `label`, `assignee`, `required`, `readOnly`, `value`, `default`, `placeholder`, `options`, `format`, `validation`, `width` and `sensitive`, when the schema is generated, then each has a declared type and grammar (invariant I11) in the machine-readable artifact; `kind` accepts exactly `text`, `number`, `date`, `checkbox`, `choice`, `signature`, `initials`, `dateSigned` and `formula`, and the reserved kind `attachment` is not accepted by version 1.
- [x] Given the editing schema, when a field is inserted, then `id` defaults to null and the identifier plugin assigns a 16-character identifier in the same transaction, so invariant I2 holds at the end of the commit.
- [x] Given a field copied and pasted or duplicated, when the paste commit is applied, then the copy has a fresh `id` and the document still satisfies invariant I13 (unique keys); how the copy's `key` is chosen is open (Open questions).
- [ ] Given `sensitive`, when the document is opened, synced, compared, exported or read through the API, then a value is readable exactly by the readers ADR 0019 allows, and redacted for everyone else.
- [x] Given `options` on a `choice` field, when the document is validated, then each option has an `id` and a `label` and option identifiers are unique within the field.
- [x] Given a `width` attribute, when it is validated, then it is a length in the document's length unit.

**Evidence:** `packages/model/src/fields/fields.test.ts`, "the form field atom (FRW-002)": a field validates in a body paragraph and a table cell and not in a header, a footer or a footnote (I10); every attribute has a grammar in `spec/cdm/cdm-1.schema.json`, and `kind` takes exactly the nine kinds of version 1 (`attachment` is refused); each choice option has an `id` and a `label`, unique within the field (I11 `duplicate_option_id`); `width` is a length in twips. The editing schema defaults `id` to null ("defaults id to null in the editing schema"). Lane U-FRW-001-018 (2026-11-13): `packages/engine/src/frw-002.field-ids.test.ts`, "inserting a field with a null id gives it a 16-character identifier" (criterion 3; Node.js, run with `pnpm exec vitest run`): `insertContent` of a `form_field` with `id` null gives one 16-character identifier and no violation. Lane w4 (2026-11-15), criterion 4: the identifier plugin gives a copied field whose key is taken a key of its own in the same transaction (`packages/engine/src/ids.ts`, `copiedFieldKey`, `rekeyCopiedFields`; the rule is proposed in [ADR 0366](../adr/0366-w4-FRW-002-key-of-a-copied-field.md)). `packages/engine/src/frw-002.field-ids.test.ts` (4 tests): a pasted copy has a fresh identifier and the key `tenant.name_2`, a second copy `tenant.name_3`, and `validate` reports nothing; a field that is cut and pasted keeps its key; the new key stays in the key grammar and within 128 characters. `packages/engine/test/frw-002-paste-commit.test.ts`: through backend-mock's real room the paste is one commit, it is acknowledged, and the stored document holds two fields with two identifiers and two keys and no violation.

**Notes:** Review F5 (a required `id` disables ProseMirror node creation) and M-1. Page-view rendering is FE's. `sensitive` becomes the read restriction for values. Changed on 2026-11-06: the owner decided that version 1 can hide regions and field values from some readers (SPK-005; ADR 0019, spike S12 SPK-029). Not met here: (4) is the editor's paste: the same test file shows a copied field pasted gets a fresh 16-character identifier, but the copy keeps its `key`, so I13 reports `duplicate_field_key`; the key rule is an open question (decision for the owner or a proposed ADR, not decided here), so criterion 4 stays unticked; (5) needs the projection on every read path (FRW-088, SYN, EXP). Lane w4 (2026-11-15): criterion 4 is ticked. The criterion leaves the choice of the copy's key open; the rule used (`<key>_<n>`, the original keeps its key, a moved field keeps its key, mirrors and rules pasted with the copy are not rewritten) is a proposal in ADR 0366 for the owner, not a decision. There is no separate duplicate command; a duplicate is a copy and a paste. Criterion 5 stays unticked: the sweep of `tests/security/test/read-restrictions.test.ts` and `sec-064-hidden-surfaces.test.ts` shows a sensitive value kept from a reader without access on the REST operations and one WebSocket channel, but no export file is produced there (the harness has no export runner), so the exported path is not shown, and SEC-064 criterion 1 is itself open for that reason.

### FRW-003 Type, limit and store field values

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 12 §3.3, §3.6 (I15); ADR 0011 · **Requirements:** R13, R4 · **Depends on:** FRW-002

As a maintainer, I want every field value typed by its kind and stored in the tree as the `value` attribute, so that values get the same ordering, attribution, hash chain, comparison, time travel and export as all other content.

**Acceptance criteria**

- [x] Given a `text` field, when a value longer than 4 KiB (target limit) is submitted, then the commit is rejected and the stored value is unchanged.
- [x] Given a `number` field, when the value is a decimal string such as `"12.50"`, then it is accepted and stored as written; when the value is a JSON number or any binary float, then it is rejected; no code path converts a stored number to a binary float.
- [x] Given a `date` field, when the value is an ISO 8601 calendar date it is accepted; when it is a date-time or any other format, then it is rejected. Given a `checkbox`, only a boolean is accepted. Given a `choice`, only the `id` of one of the field's `options` is accepted.
- [x] Given `signature` and `initials`, the value shape is `{ asset, mode }` with `mode` one of `typed`, `drawn`, `uploaded` and `asset` attached to this document (invariant I4); given `dateSigned`, the value is an ISO 8601 date; given `formula`, a decimal string or a string. Null means empty for every kind.
- [x] Given a value set at `seq` 10 and changed at `seq` 20, when content is read at `seq` 15, then the field holds the value from `seq` 10 and the change at `seq` 20 appears in comparison and history like any attribute change.
- [x] Given a whole-document restore with no active workflow, when it is applied, then field values return to their values at the restored `seq`.

**Evidence:** `packages/model/src/fields/fields.test.ts`, "typed, limited field values (FRW-003)" and "one verdict with the rules package": a text value over 4 KiB, a JSON number, a date-time, a checkbox that is not a boolean, an unknown option and a signature of the wrong shape or with an asset that is not attached are I15 or I4 at the path of the value; a decimal string is kept as written; null is empty; the verdict equals `checkFieldValue` of `@docedit/rules` for every kind. The authority runs `validateDoc` on the result of every commit and refuses an I15 at a value with `field_invalid`, keeping the stored value (`packages/authority/test/invariants.test.ts`, "maps a wrongly typed fill to field_invalid"; `packages/authority/test/permissions.room.test.ts`, "refuses a wrongly typed value with field_invalid and drop, and keeps the stored value"). Criterion 6: `packages/authority/test/frw-003.restore.test.ts` (lane FRW-001-013, 2026-11-13). Criterion 5 (lane w4, 2026-11-15): `packages/history/test/frw-003-field-value-history.test.ts` (5 tests) on a log of 25 commits with the value set at seq 10 and changed at seq 20: the authority's `contentAt` at seq 15 holds the value of seq 10; `compare` from seq 15 to the head reports one `field` change for the field, by its author at seq 20, in the same list as a paragraph style change of seq 18, by both methods (`steps` and `aligned`), and none when the range ends at seq 19; `fieldHistory` lists seq 20 and seq 10. With `packages/authority/test/frw-003.field-time.test.ts` for the read at a `seq`.

**Notes:** The code returned for an oversize or wrongly shaped value depends on who submits it: a fill commit uses `field_invalid` (FRW-008); other commits fail invariant I15 (`invalid_op`). Oversize `text` for a fill commit is not named in 12 §4.2; see Open questions. Accepted consequences from ADR 0011: every participant can read every value, except a value marked sensitive (ADR 0019; FRW-088); a whole-document restore reverts values and is refused while a workflow is active (FRW-029). Not met here: (5) reading at a `seq` and (6) restore are the history's and the authority's (HIS, SYN). Lane FRW-001-013 (2026-11-13): `packages/authority/test/frw-003.field-time.test.ts`, "FRW-003", shows through `contentAt` that a value set at seq 10 is held at seq 15 and that the seq 20 change is stamped with the field scope alone. Criterion 5 stays unticked: its "comparison and history" part is not tested in that file (`fieldHistory` of `@docedit/history` has its own test, HIS-016, but no test shows the seq 20 change in a comparison). Criterion 6 is ticked (lane FRW-001-013, 2026-11-13): `packages/authority/test/frw-003.restore.test.ts`, "FRW-003 a whole-document restore returns field values (criterion 6)", restores a document whose value is 13.00 to its 12.50 checkpoint with reason `restore` and no workflow active, and the value returns to 12.50; the same restore is refused while a workflow is active and the value stays. Criterion 5 stays unticked (its comparison part is not tested in that file). Lane w4 (2026-11-15): criterion 5 is ticked; the comparison and history parts are now tested in `packages/history` (see Evidence). The test runs the history package's functions over a built log; the comparison a reader gets over HTTP is the content API's and is not exercised here.

### FRW-004 Check static validation limits and presets

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Participant |

**Spec:** 12 §3.2 (`validation`, `required`), §11; ADR 0012 · **Requirements:** R13, R11 · **Depends on:** FRW-002, FRW-003

As a participant, I want to be told while I fill a field whether my entry is acceptable, so that I can correct it before I finish.

**Acceptance criteria**

- [x] Given a `number` field with `validation` `min` `"0"` and `max` `"1000000"`, when the entry is `-1` or `1000000.01`, then the control is marked `aria-invalid`, a message is shown, and `validateFields()` reports the field; when the entry is `0` or `1000000`, then it is valid. Bounds are compared as decimals, never as binary floats.
- [x] Given a `text` field with `minLength` and `maxLength`, when the entry is shorter or longer, then it is reported invalid with a message; the unit of length is the one fixed in the schema grammar.
- [x] Given a `preset` of `email`, `phone` or `postcode`, when the entry does not match the preset's definition, then it is reported invalid; the preset definitions are published with the fixtures.
- [x] Given a `required` field that is empty (null or an empty string), when `validateFields()` runs, then it is reported as required and empty.
- [x] Given an invalid entry, when it is submitted as a fill, then the commit follows the rules of FRW-008; the client keeps showing the field as invalid until the entry changes.

**Evidence:** `packages/rules/test/entry-checks.frw004.test.ts` (11 tests, pass on 2026-11-13): number bounds `-1`, `1000000.01`, `0` and `1000000` through `checkEntry` and `validateFields`, and a bound compared as a decimal to 20 fraction digits (criterion 1, the decimal part only); text limits in code points, with the messages (criterion 2); the three presets through `checkEntry` (criterion 3); null, empty and absent required entries through `validateFields` (criterion 4). Existing: `packages/rules/test/fields.test.ts`, "validateFields (FRW-004)". Lane w4 (2026-11-15), criteria 1 and 5. The control: `packages/engine/src/view/form-field-view.ts` (a node view with a native control) and `packages/engine/src/field-entries.ts` (the entries, checked by `checkEntry` of `@docedit/rules`). `packages/engine/src/view/frw-004-field-control.universal.test.ts` (7 tests, run with `pnpm exec vitest run --project browser` on this Windows machine in Chromium, Firefox and WebKit, 21 passed): the entries `-1` and `1000000.01` mark the control `aria-invalid`, the message it is described by (its text in `aria-description`, changed from an `aria-describedby` reference at the batch 5 integration, because no ID reference may be set from script: FE-108 criterion 2) is shown in the same root, and the core's `validateFields()` reports the field; `0` and `1000000` clear the mark. `packages/engine/test/frw-004-entries.test.ts` (8 tests, Node.js): the same bounds through the core, a bound compared as a decimal where a binary float cannot tell the entries apart, and criterion 5 through backend-mock's real room: a fill-only participant's letters in a number field are refused with `field_invalid` and dropped, the stored value stays, and the core keeps showing the entry as invalid, and reporting it, until the entry changes; an entry outside a limit is stored by the room and stays invalid on the client.

**Notes:** Phase inferred. 12 §13 names "required and type checks" for 1b; the `validation` limits and presets are treated here as part of the same client-side checks, because `maxLength` is the 12 §14 response to "filling moves page breaks". The `pattern` limit is FRW-018 (phase 2). Until `packages/rules` exists (phase 2) these checks live elsewhere; FRW-015 requires them to move into the one implementation. Server-side enforcement of required fields and validations is at completion (FRW-047, phase 2); whether the authority also rejects a limit violation at commit time is open (Open questions). The model holds no entry checks: `checkEntry` and the presets of `@docedit/rules` are the one implementation (ADR 0030 §6; ADR 0031 §5). Lane FRW-001-013 (2026-11-13): criteria 2 to 4 are ticked on the rules side. Not met, so unticked: criterion 1 (`aria-invalid`, the shown message and the editor's control) is the editor's; criterion 5 (the commit follows FRW-008 and the client keeps the field invalid) needs the authority's fill path in the room and the editor. Lane w4 (2026-11-15): criteria 1 and 5 are ticked. What was built for them, and its limits: the web view draws a `form_field` of kind `text`, `number`, `date`, `checkbox` or `choice` as a native control (the rest of FRW-079, such as `format`, the screen reader run and axe, is not done here); in the `fill` mode the core now lets the value of a form field change and refuses every other change (before, the mode refused everything), which is the part of FRW-076 criterion 1 these criteria need. `validateFields()` is the core's method (`DocumentCore.validateFields`); the method of the same name on `<doc-editor>` is FRW-069's and is not built. The engine reaches `checkEntry` and `validateFields` through `@docedit/authority`, which re-exports them, because the engine has no dependency on `@docedit/rules` and this lane adds none. The mock backend takes the roles a user may fill from `MockUser.fill`, a stand-in: the token claim for fill roles outside a workflow is still open (FRW-083). The room stores a correctly typed value that breaks a limit (the open question above is not decided here); the test records that behaviour and the client still shows the field as invalid.

### FRW-005 Enforce the field invariants of the document model

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 12 §3.6 (I13, I14 first half, I15); 03 §8; 04 §5 step 6 · **Requirements:** R13 · **Depends on:** FRW-001, FRW-002, FRW-003, SYN-001, SYN-006

As a maintainer, I want the field invariants checked at the end of every commit and by `model.validate()`, so that no document can hold duplicate keys, dangling roles or oversize values.

**Acceptance criteria**

- [x] Given a commit whose result contains two `form_field` nodes with the same `key`, when the authority checks invariants, then it is rejected with `invalid_op`.
- [x] Given a field whose `assignee` does not resolve to a `role_def`, or a commit that deletes a `role_def` still referenced by a field's `assignee`, then it is rejected with `invalid_op` (I13).
- [x] Given a `field` node of kind `formValue` whose `target` is not an existing field key, or a commit that deletes a field whose key is the `target` of a `formValue`, then it is rejected with `invalid_op` (I14, first half; the rule half is FRW-019).
- [x] Given a document with 2,000 fields (target limit), when a commit adds one more, then it is rejected with `invalid_op` (I15).
- [x] Given any commit, when it consists only of `attr` steps that change `value`, then the invariants still run on the result (checks apply to the result of every step type).
- [x] Given the same corpus of valid and invalid documents, when run through `model.validate()` and through the authority, then both return the same verdict for I13 to I15.

**Evidence:** `packages/model/src/fields/fields.test.ts`, "the field invariants of the document model (FRW-005)": two fields with one key and an assignee that names no role or a deleted role (I13 `duplicate_field_key`, `unresolved_role`), a `formValue` whose target is no field key (I14 `unresolved_field_key`), 2,001 fields (I15 `too_many_fields`), and a result made only of value attribute steps. The authority runs `validateDoc` on the result of every commit and refuses every other violation with `invalid_op` (`packages/authority/test/room-scenarios.test.ts`, "I13: rejects a duplicate field key, an assignee that is no role, and deleting a role still used" and "checks the result of all seven step types"). Lane U-FRW-001-018 (2026-11-13), criterion 6: `packages/authority/test/frw-005.corpus.test.ts` (I13, I14) and `packages/authority/test/frw-005.i15-corpus.test.ts` (I15, the 2,000th and 2,001st field), each run in Node.js through `validateDoc` and the room's commit path; both verdicts agree. Lane w4 (2026-11-15), criterion 3: `packages/authority/test/frw-005.mirror-target.test.ts` (4 tests, Node.js) through the room's commit path: a mirror of a key no field has is refused with `invalid_op`; with a mirror stored, a commit that deletes the targeted field, or renames its key, is refused with `invalid_op` and the room's document and head are unchanged; a commit that deletes the field together with its mirror is accepted. `validateDoc` reports I14 `unresolved_field_key` for each refused result.

**Notes:** The rule-related halves of I14 and I15 (cycles, 500 rules) are in FRW-019 because rules arrive in phase 2. Criteria (3) and (4) are tested in the model; in the authority they take the refusal path its I13 test covers. Lane FRW-001-013 (2026-11-13): `packages/authority/test/frw-005.corpus.test.ts` runs six cases (I13 duplicate key, unresolved assignee, deleted role; I14 unresolved and resolved mirror; one valid new field) through `validateDoc` and through the room's commit path, and the verdicts agree. Lane U-FRW-001-018 (2026-11-13): criterion (6) is ticked on the two files together. `packages/authority/test/frw-005.i15-corpus.test.ts` adds the I15 cases (the 2,000th field accepted, the 2,001st refused) through the same two paths. The corpus is split across two files, not one, so the tick rests on both. Audit (2026-11-13): criterion 3 is unticked because no test deletes a field that a `formValue` targets (the model test named "and deleting the field it mirrors" only checks a mirror with a missing target, and the authority corpus only inserts mirrors), so the deletion half is unproven. Lane w4 (2026-11-15): criterion 3 is ticked again; the deletion half is now tested through the room (see Evidence). No code changed: the room already ran I14 on the result of every commit.

### FRW-006 Mirror a field's value elsewhere in the document

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | could | Author |

**Spec:** 12 §3.4; 03 §4.4 · **Requirements:** R13 · **Depends on:** FRW-002, FRW-005

As an author, I want to display one field's value again elsewhere in the document, so that a name or amount typed once appears wherever the text needs it.

**Acceptance criteria**

- [x] Given a `field` node of kind `formValue` with `target` set to a field key, when the target's value changes, then every mirror shows the new value in the editor without a reload.
- [x] Given a mirror, when a participant with only `fill` tries to change it, then the commit is rejected with `permission_denied`, because only `value` attributes of form fields are changeable by a fill (FRW-008).
- [x] Given a mirror whose target key does not exist, then the document is invalid (FRW-005).
- [x] Given a PDF export, when a target field has a value, then the mirror prints that value in the text; when the value is empty, it prints nothing and raises no diagnostic.
- [x] Given a mirror, when the user selects it, then it behaves as an atom and its accessible name states that it shows the value of the named field.

**Evidence:** `packages/model/src/fields/fields.test.ts`, "mirrors of a field value (FRW-006)": a mirror whose target is no field key makes the document invalid (I14 `unresolved_field_key`); `fieldText()` prints the value of the target field, a choice by its option label, and nothing for an empty value. Lane FRW-001-013 (2026-11-13): `packages/authority/test/frw-006.mirror-rights.test.ts`, "FRW-006": a fill-only participant's change to a mirror's `cached` text or `target` is refused with the body scope, and the fill of the field itself is still accepted (criterion 2; the outcome check, not the editor). Lane w4 (2026-11-15), criteria 1, 4 and 5. The mirror is a node view of the web view (`packages/engine/src/view/form-field-view.ts`, `MirrorView`, `mirrorText`), drawn again after every change of the document. `packages/engine/src/view/frw-006-mirror.universal.test.ts` (3 tests, run with `pnpm exec vitest run --project browser` on this Windows machine in Chromium, Firefox and WebKit, 9 passed): the mirror shows the target's new value in the same element when the value changes locally, and when another client stores it through backend-mock's real room (criterion 1); the mirror is not editable, a node selection takes it whole (one position, no position inside), and its accessible name is "Value of the field <label>: <value>" (criterion 5). `packages/export-latex/src/frw-006-mirror.compile.test.ts` (1 test, compiled in the export worker's Podman sandbox on this machine, text read with `pdftotext`): the PDF shows the target's value between the words either side of the mirror, nothing for an empty value, and the converter raises no diagnostic (criterion 4).

**Notes:** Phase inferred: `formValue` is part of CDM version 1 (03 §4.4) and 12 §13 names no phase. The `cached` attribute of the `field` node (03 §4.4) holds the last computed text for consumers that cannot compute it; who refreshes it is not stated. Second review (2026-11-06, SPK-027), SR-C3: under ADR 0019 a mirror of a hidden value, and its `cached` text, must be hidden from the same readers as the value ([review](../review/2026-11-06-second-review.md)). Lane FRW-001-013 (2026-11-13): criterion 2 is ticked (see Evidence; the outcome check refuses the change, so the mirror is not writable by a fill). Not met here: (1) and (5) are the editor's (FE), and (4) the PDF writer's; `fieldText()` of `@docedit/model` gives the text a mirror prints. Lane w4 (2026-11-15): criteria 1, 4 and 5 are ticked (see Evidence). The editor computes a mirror's text from the target with `fieldText()` and never reads or writes `cached`; who refreshes `cached` is still not stated and is not decided here. A mirror of a redacted value shows "[redacted]" in the editor (SR-C3); hiding the mirror on the other read paths is the projection's (FRW-088, FRW-089). The wording of the accessible name is English text in the engine, as the other node labels are; its translation is not done. Criterion 5 is tested by a node selection made through the core, not by a pointer or a screen reader run.

## Permission to fill (12 §4)

### FRW-007 Add the fill capability, the filler role and field scopes

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 12 §4.1; 07 §1, §2, §4; 05 §5.5; 08 §2 · **Requirements:** R13, R3 · **Depends on:** FRW-002, PRM-001, PRM-004, PRO-032

As a maintainer, I want the capability `fill`, the document role `filler` and the scope `field:<id>`, so that a person can be limited to filling fields and every fill is traceable to one field.

**Acceptance criteria**

- [x] Given the capability list, then `fill` exists; the role `filler` has exactly `view` and `fill`; when a token's `docs` claim gives a user `filler` on a document, then the connection's `caps` are `view` and `fill` and nothing else.
- [x] Given a stored commit that changed the value of field `F`, when its record is read, then its scopes include `field:F` and no scope for fields it did not change.
- [x] Given a rejection caused by a field value, when `sync.reject` is sent, then `scopes` lists `field:<id>` for the offending fields.
- [ ] Given `GET /documents/{id}/history?field=<id>`, when called, then it returns the commits that touched that field's scope, answered from the scopes recorded with each commit and without replaying the log.
- [x] Given `access` in `ch.opened` and `perm.changed`, then it carries `fill: { participant, roles, active }`, does not list fields, and is `null` for a connection with no fill rights.
- [x] Given form mode without a workflow (phase 1b), when the token carries the roles the user may fill in the claim defined for that purpose, then `access.fill.roles` equals those roles.

**Evidence:** `packages/authority/test/outcome.fields.test.ts`, "the fill capability, the filler role and field scopes": the role `filler` is exactly `view` and `fill`, a filler's document-level capabilities are those two and every region gives `view` only; a commit changing two values differs in exactly their two field scopes. `test/permissions.room.test.ts`: a stored fill is stamped with its field scope alone, and a refused fill names `field:<id>`. Lane U-FRW-001-018 (2026-11-13), criterion 5: `packages/protocol/src/bridge/frw-007.fill-access.test.ts` (7 tests, Node.js, passing) drives `toAccess` (`packages/protocol/src/bridge/translate.ts`, which the room bridge uses for `ch.opened` and `perm.changed`) with `computeAccess`: `fill` is `{ participant, roles, active }`, the user stands in for the participant when there is no `wfp` claim, no field is listed, and `fill` is null without fill rights. Lane w4 (2026-11-17), criterion 6, applying owner decision 5a of `docs/owner-decisions-2026-11-15.md` (the claim is configurable per tenant, `wfr` by default; 05 §3.1 and 12 §13 already say so): `TokenService` (`services/document-service/src/control-plane/tokens.ts`) reads the roles from the claim the tenant names (option `fillRolesClaim`, default `wfr`) into the connection's `participantRoles`, and sets `participantActive` while there are roles (decision 5b: active while the document is not locked, which `computeAccess` enforces through `fill.allowed`). `services/document-service/test/control-plane/frw-007.fill-roles-claim.test.ts` (8 tests, Node.js, passing) takes a signed token through `verifyUser`, `computeAccess` and `toAccess` and checks `access.fill.roles` equals the claim, `fill` is null without the claim, with an empty one and on a locked document, a tenant's own claim name is read and `wfr` is then ignored, and a claim that is not an array of identifiers refuses the token.

**Notes:** Criterion 6: the claim name is per tenant through `fillRolesClaim`, a function the host of the service gives; where a tenant stores its name (the tenant registry table and the operator commands) is not built, and only the default is wired in `server.ts`. Earlier note: the token claim that carries fill roles outside a workflow is not named in 05 §3.1 (only `wfp`, `amr`, `auth_time` are), and the meaning of `active` without a workflow is not defined; both are in Open questions and in FRW-083. 12 §14: "who filled this field" is a history query. Not met (2026-11-06): (4) is the history service's (HIS). (5) is ticked by lane U-FRW-001-018 (see Evidence): `toAccess` builds the object from `fillSummary`; the 2026-11-06 remark about `packages/backend-mock/src/translate.ts` is out of date, as that file does not exist. (6) waits for the claim (FRW-083). Lane U-FRW-001-018 (2026-11-13), criterion 4 stays open and is blocked outside this lane: `GET /documents/{id}/history` is specified only as `listHistory` ("grouped commits", `spec/dep/dep-1.openapi.json`, with no `field` query member) and no handler serves it (`services/document-service/src/control-plane/handlers.ts` has no such route). The `commit_scopes` index that would answer it (`services/document-service/src/storage/log-store.ts`, HIS-016) exists, so the endpoint needs a spec change, which is generated and the main session's, before a PostgreSQL test can be written. Lane w4 (2026-11-15), checked again, nothing new ticked. Criterion 4: the definition now gives `listHistory` a `field` query member (`packages/protocol/src/definition/resources.ts`), and the store answers it from the index (`scopeHistory`, HIS-016, with a test of its query plan), but no handler serves `GET /documents/{id}/history` yet. The handler is not written in this lane for two reasons: its response is `HistoryGroup`, which the definition holds as a placeholder (gap G67), so its shape is an open question and not this story's to decide; and the grouping lives in `@docedit/history` (`listHistory` in `packages/history/src/groups.ts`), which `services/document-service` does not depend on, and this run adds no dependency. The route is PRO-054 criterion 1 and HIS-008; when it is served, this criterion needs one test that the `field` filter is answered from `commit_scopes` without reading payloads. Criterion 6: still waits for the owner's decision on the claim that carries fill roles outside a workflow (FRW-083). The mock backend now takes those roles from the user it is given (`MockUser.fill` in `packages/backend-mock`, added for FRW-004); that is a test stand-in, not the claim, so it does not meet the criterion.

### FRW-008 Let a fill-only participant change only the values of their own fields

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Participant |

**Spec:** 12 §4.2 (P7); 07 §5.1; 04 §5 step 7; ADR 0011 · **Requirements:** R13, R3, R10 · **Depends on:** FRW-003, FRW-007, FRW-009, PRM-009, SYN-001, SYN-006

As a participant with the fill capability only, I want to set the values of the fields assigned to my roles and nothing else, so that I can complete my part without being able to alter the rest of the document.

**Acceptance criteria**

- [x] Given a user with `fill` but not `edit` whose roles include a field's `assignee`, when they submit a commit whose only difference is a correctly typed `value` of that field, then it is accepted and acknowledged, and other connected clients receive it.
- [x] Given the same user, when the commit also changes anything else (body text, another attribute of the field such as `required` or `assignee`, definitions, regions, structure, marks), then it is rejected with `permission_denied` and the offending scopes, however the steps are shaped (`attr`, mark, node-mark or crafted `replaceAround`).
- [x] Given a field assigned to another role, a field with a null `assignee`, or a field of kind `signature`, `initials`, `dateSigned` or `formula`, when the user changes its value, then the commit is rejected with `permission_denied`.
- [x] Given a value of the wrong type for its kind (letters in a `number` field, a non-ISO `date`, a `choice` id not in `options`), when submitted, then it is rejected with `field_invalid`, action `drop`, and a message the client can show; the stored value is unchanged.
- [x] Given a fill commit whose `base` is older than the head, when unrelated commits were accepted meanwhile, then the `attr` step needs no position mapping and the commit is accepted if still valid; the check is a lookup in the room's field index plus the rules that depend on the field, and its cost does not grow with unchanged scopes (target).
- [x] Given a commit labelled with origin `fill` from a user who lacks the right, then the label has no effect: the outcome check alone decides (origin is a hint).

**Evidence:** P7 is the registered module `FILL_RULE` (`packages/authority/src/permissions/fill.ts`). `test/permissions.room.test.ts`: a fill by the assignee's participant is stored, acknowledged and broadcast; letters in a number, a non-ISO date and a choice outside the options are refused with `field_invalid`, `drop` and the validation message, and the value stays. `test/outcome.fields.test.ts`: the same fill with body text, another attribute of the field, a definition, a region, a mark, a node mark or a crafted `replaceAround` is refused naming the other scope; another role's field, a field only authors set, a read-only field and server-set kinds are refused, as are inactive participants and missing roles; the origin `fill` gives the same verdict as `input` for every user. Lane w4 (2026-11-15), criterion 5: `packages/authority/test/frw-008.old-base.test.ts` (5 tests, Node.js) through the room: a fill made on seq 0 is accepted after two unrelated commits that moved the field, and the stored commit is the one `attr` step at the field's place in the head document, stamped `field:<id>` alone; the step's position map is empty, so a commit made before the fill is stored with its steps unchanged; the fill is refused when the field was removed meanwhile, and with `conflict` when its value changed meanwhile; the field is in the room's field index (`room.indexes.field`), and in a document 300 paragraphs longer the scope comparison visits the same number of nodes and the index update scans the same number of nodes (counted by `diffScopes(...).visited` and `PermissionIndex.scanned`; a count, not a timing).

**Notes:** Conditions that need rules or a workflow (field visible and enabled; participant active in the workflow) are added in FRW-022 and apply from phase 2; in form mode they are not checked (see FRW-083). The suggester case is in FRW-011. Review S-01 (the outcome check) and PD-1. Not met (2026-11-06): (5) a fill on an old base is accepted rebased and its check visits only the changed path (`packages/authority/test/permissions.room.test.ts`, `test/outcome.fields.test.ts`), but the room keeps no field index to look the field up in (PRM-016). 2026-11-13: the room now keeps one (`PermissionIndex.field`, PRM-016), but the fill is still rebased (`ack.rebased` is true in `permissions.room.test.ts`, "accepts a fill made on an old base"), so the `attr` step does map positions and criterion 5 stays open. Lane w4 (2026-11-15): criterion 5 is ticked, on this reading, which is said here so that it can be challenged. "The `attr` step needs no position mapping" is read as 12 §4.2 states it: an `attr` step has no position map of its own, so nothing is mapped over a fill. The step's own position is still mapped through the commits stored since its base (the field may have moved), which is why the acknowledgement says `rebased`; no reading of the criterion can avoid that. "The check" is the permission check of step 7: the scope comparison, the field index and the rule gate. The invariant check of step 6 (`checkInvariants`) is not measured by this test, and no time was measured. A static `readOnly` flag counts as disabled (ADR 0033 item 9). A binary float is refused as `invalid_op`, not `field_invalid`, because the CDM grammar refuses non-integer numbers (I11) besides I15.

### FRW-009 Reserve server-set values to the server

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 12 §3.3, §4.2 (P8); 04 §3.1, §10; review S-06 · **Requirements:** R13, R10 · **Depends on:** FRW-003, SYN-030

As a maintainer, I want the values of `signature`, `initials`, `dateSigned` and `formula` fields changeable only by server-authored commits, so that no client can forge a signature, a signing date or a computed result.

**Acceptance criteria**

- [x] Given any client connection, including an owner, when a commit changes the `value` of a field of kind `signature`, `initials`, `dateSigned` or `formula`, then it is rejected with `permission_denied`.
- [x] Given a client commit that inserts a field of one of those kinds with a non-null `value` (for example by pasting a copy of a signed field), when it is submitted, then it is rejected; inserting the field with a null value is allowed.
- [x] Given a client that submits a `dateSigned` value (a backdated signing date), then it is rejected with `permission_denied` and the stored value is unchanged.
- [x] Given the server writes a value of these kinds, then it does so only in a commit with origin `sign` or `rules`, authored under the requesting user or `system`, and the commit passes through the same log, chain and attribution as any other.
- [x] Given a request to write such a value is retried or the process stops between the outbox and the log, then the commit is applied exactly once (deterministic commit identifier).

**Evidence:** P8 is in the core of the outcome check (`packages/authority/src/permissions/outcome.ts`). `test/outcome.fields.test.ts`, "server-set values": every client change of a signature, initials, date-signed or formula value is refused, the owner's included; only a server-authored commit with origin `sign` or `rules` may make it; a pasted signed field and a filled field turned into a formula are refused, the same field without a value accepted. `test/permissions.room.test.ts`: a backdated `dateSigned` from the owner or the participant is refused and the value stays; `Room.author` with origin `sign` stores it under the signer through the same steps and log as any commit, and a `prefill` of a formula is refused. Lane U-FRW-001-018 (2026-11-13), criterion 5: `services/document-service/test/data-plane/frw-009.outbox-crash.pg.test.ts`, "FRW-009 criterion 5 over PostgreSQL" (PostgreSQL in Podman, one test, passing).

**Notes:** The outcome check, not the origin label, enforces this; clients may send any `origin` and nothing is authorised on its strength. What the server does with a client-supplied reserved origin is not stated (Open questions). Paste is the forgery vector to include in the property test of FRW-066. The room refuses a reserved origin from a client with `invalid_op`. P8 also refuses a pasted signed field and a filled field whose kind becomes a server-set kind, and a restore, import or prefill that would set such a value (ADR 0033 item 9). Not met: (5). At the room, a retry with the same deterministic identifier is applied once, also when the log already holds it (`test/room-commits.test.ts`, "apply once when a retry with the same deterministic id is delivered twice"; SYN-030). The outbox between the control plane and the log, and the process stop between the outbox and the log, are the document service's (BE), so the criterion stayed open for the room-level tests. Lane U-FRW-001-018 (2026-11-13): criterion 5 is ticked. `services/document-service/test/data-plane/frw-009.outbox-crash.pg.test.ts` claims the item with a short lease, applies it to the log and stops before settling; after the lease runs out a second node delivers it, and the log holds the commit once. Run over PostgreSQL in Podman (`docedit-test-postgres`, shared; the test creates its own database and drops it).

### FRW-010 Reject concurrent fills of the same field

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Participant |

**Spec:** 12 §4.2 (P9); 04 §8; ADR 0011 (alternatives); review §3.7 · **Requirements:** R13, R7 · **Depends on:** FRW-008, SYN-001, SYN-006

As a participant, I want a clear conflict when someone else changed the field I was filling, so that a half-merged amount or date can never be stored.

**Acceptance criteria**

- [x] Given two participants with the same role filling the same field from the same `base`, when the first commit is accepted, then the second is rejected with `conflict`, action `drop`, and the client shows the other (current) value; the values are not merged.
- [x] Given any commit accepted after a fill commit's `base` that changed the same field (another fill, a prefill, an edit by an author, a server-authored commit), when the fill is processed, then it is rejected with `conflict`.
- [x] Given a fill commit whose `base` is older than the head, when none of the commits accepted since changed the same field, then it is accepted; unrelated changes never cause a conflict.
- [x] Given a fill commit that changes two fields where only one was changed concurrently, then the whole commit is rejected and neither value is stored.
- [x] Given the client receives `conflict`, then the control shows the current value, the participant is told the field was changed by someone else, and the rejection is announced through a live region, never dropped silently.

**Evidence:** `packages/authority/test/permissions.room.test.ts`: of two participants filling one field from one base the second gets `conflict` and `drop`, and the reference client (`test/harness/client.ts`) then shows the stored value, not a merge; a fill after an author's edit or a server-authored prefill of the same field is refused with `conflict`, and a commit changing that field and another stores neither; a fill on an old base is accepted rebased, and changes of other fields never conflict. `test/outcome.fields.test.ts`, "concurrent fills", for the outcome check alone. Lane w4 (2026-11-17), criterion 5: a `conflict` that names `field:<id>` scopes keeps the field identifiers on the set-aside item (`Discarded.fields` in `packages/engine/src/sync/state.ts`, `RecoveredItem.fields` through `packages/engine/src/core.ts`), and the shell's notice for it says the field was changed by someone else and now shows the current value (`notice.rejected.fieldConflict` in `packages/ui/src/i18n/en-GB.ts`, chosen in `packages/ui/src/shell/notices.ts`). Tests: `packages/engine/test/sync-state.test.ts` (the discarded item keeps the field ids; the visible document is the other participant's value, not a merge, as before), `packages/engine/test/frw-010.conflict-notice.test.ts` (2 tests, real core with the mock service: the fill is gone from the document and the recovered item names the field), `packages/ui/test/notices.test.ts` (the notice key), and `packages/ui/e2e/ux-017-recovered-announce.spec.ts` (Chromium, `--project=chromium`, 2 passed on 2026-11-17: the shell's status live region receives the words and they name no field).

**Notes:** Review §3.7: fills are exclusive per field. Whether P9 also applies to a commit by a user who holds both `edit` and `fill` is not stated (12 says "a fill commit"); see Open questions. The exclusivity check is an index lookup on `field:<id>` scopes recorded since `base`. The code applies P9 to every commit that changes a value, whoever makes it, as spike S3 did (ADR 0033 item 9). Criterion 5 was the editor's (FE) and is met by lane w4 (2026-11-17) on the existing set-aside notice and the shell's live region (UX-017); the e2e test drives the shell with a fake core that is given the item, so the path from a real rejection to the shell is covered by the engine test and the shell by the e2e test, not by one run in a browser with a backend. The notice does not name the field (ADR 0019); a per-field marker on the control itself is not added.

### FRW-011 Keep editing rights and fill rights consistent

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | should | Owner |

**Spec:** 12 §4.3; 07 §4, §11 · **Requirements:** R13, R3 · **Depends on:** FRW-008, PRM-001, PRM-004

As an owner, I want rights over fields to combine predictably with editing rights, suggestions and region states, so that filling is never blocked by a review state and never lets someone edit more than a value.

**Acceptance criteria**

- [x] Given a document that is a draft and a user with `edit` in the scope, when they change any attribute of a field (key, label, assignee, required, validation, width, value), then the commit is accepted.
- [x] Given a user with `suggest` but not `edit`, when they change a field's value or any other attribute, then the commit is rejected with `permission_denied`, because a value change alters the baseline of rule P4.
- [x] Given a field inside a region whose state is `approved`, or that is leased to another user, when a participant with `fill` and the field's role fills it, then the commit is accepted; approval and leases do not block fills.
- [x] Given the same approved region, when a user with `edit` changes any other attribute of the field, then it is rejected as for any other content of the region.
- [x] Given a commit that changes a field's value and the text of its region in one step list, when the submitter has only `fill`, then it is rejected as a whole.

**Evidence:** `packages/authority/test/frw-011.field-rights.test.ts` (4 tests, pass on 2026-11-13): an editor in a draft changes the label, required flag, width, assignee and value of a field and is accepted (criterion 1); a suggester is refused for a value change (`field:<id>`) and for an attribute change (`body`) (criterion 2); a fill of a field in the approved region Terms, with a lease on that region, is accepted for the landlord role (criterion 3); a fill with a body text change is refused as a whole, the fill alone being accepted (criterion 5, tested with body text, not a region's text). Lane w4 (2026-11-17), same file, now 8 tests (passing, Node.js 22.18): criterion 4 on the region Terms set to `approved`: the owner (`carol`) changing `label`, `required`, `width` or `assignee` of the field `terms.rent` is refused with the scope `region:rTerms000000000A`, the region's editor (`rita`) is refused too (P6, as an approved region leaves her `view` only), the same change by her is accepted while the region is a draft, and a change of the value by her is refused; criterion 5 with the text change inside the field's own region: the fill alone by the landlord role is accepted, the fill plus an inserted character in the same paragraph is refused as a whole, in a draft and in an approved region.

**Notes:** The removal of the `edit` right once a workflow is active is FRW-029. Lane FRW-001-013 (2026-11-13): criterion 4 was unticked because no test showed that `outcomeCheck` (`packages/authority/src/permissions/outcome.ts`) refuses an edit of another attribute in an approved region (07 §11), and criterion 5 because only body text was tested. Lane w4 (2026-11-17): the check already refuses both, as the computed access (`computeAccess`) leaves nothing above `view` and `comment` in an approved region (07 §4); the two criteria are ticked on the new tests, with no change to the authority. Until P4 is enforced (phase 2) the suggester case is rejected by rule P1. Review §3.7. Second review (2026-11-06, SPK-027), SR-M25: the third criterion contradicts 07 §11 (nothing may change an approved region, and the approval hash covers values); the review proposes an approval hash that excludes field values and an exception in 07 §11 for fills and `sign` and `rules` commits ([review](../review/2026-11-06-second-review.md)). The model gives the authority the attributes a fill may change (`FILL_ATTRIBUTES`, only `value`) and the kinds only the server sets (`SERVER_SET_FIELD_KINDS`) in `@docedit/model/definition`; the criteria are the authority's (PRM).

### FRW-012 Grant a region to a role placeholder

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Owner |

**Spec:** 12 §3.4, §4.3; 07 §1, §4 · **Requirements:** R13, R3 · **Depends on:** FRW-026, FRW-086, PRM-018, PRM-035

As an owner, I want to grant a region to a role placeholder instead of a named person, so that whoever is bound to the role can write a long, formatted answer without the answer being a field.

**Acceptance criteria**

- [ ] Given a region grant whose principal is `role:<id>`, when a workflow is active and a participant is bound to that role, then that participant (matched by `sub`) holds the granted role in the region and a person not bound to the role does not.
- [x] Given no active workflow, when access is computed, then the principal `role:<id>` resolves to nobody and no one gains rights from the grant.
- [ ] Given participants are added, removed or reset (correction, routing), when the binding changes, then access is recomputed and `perm.changed` is sent with a higher `rev`.
- [x] Given the grants dialog, when the owner chooses a principal, then role placeholders are offered beside users and groups.
- [x] Given a region grant to a role, then the grant never conveys `structure` or `manage`, as for any region grant.

**Evidence:** `packages/authority/test/frw-012.role-region-grant.test.ts`, "FRW-012" (lane FRW-001-013, 2026-11-13): with a workflow active, a grant to `role:landlord` gives the bound participant (matched by `sub`) the granted `edit` in the region and gives nothing to an unbound person (criterion 1); the grant leaves the document role, the structure scopes and `manage` untouched (criterion 5).

**Evidence (criteria 2 and 4, lane w4, 2026-11-17):** Criterion 2: `packages/authority/test/frw-012.role-region-grant.test.ts`, describe "a grant to a role resolves to nobody without an active workflow" (`pnpm exec vitest run --project node <file>`, 6 passed): a participant bound to `role:landlord` holds no grant and no `edit` while `workflowActive` is false, and holds both once it is true (control); with the lock each state implies (`lockFor`), draft, declined and voided give nobody the grant and sent and in progress do; a person bound to no role gains nothing either way. The rule is `grantMatches` in `packages/authority/src/permissions/access.ts`; the same decision is PRM-023 criterion 2 (spec default of 07 §1). Criterion 4: `packages/element/e2e/frw-012-role-grant.spec.ts`, in the real element and its shadow root against the embed page's backend, Chromium, Firefox and WebKit (`DOCEDIT_DEMO_PORT=58478 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-012-role-grant.spec.ts e2e/pro-080-grants-search.spec.ts --project=chromium --project=firefox --project=webkit --retries=0`, 6 passed with the existing PRO-080 spec): on a document with a region and the roles Tenant and Landlord (`regionRolesDocId`, new in `packages/element/demo/embed-page.ts`), typing "Land" in the grants pane lists the host's user and group and the role Landlord in one list, each labelled "Person", "Group" and "Workflow role"; the host's directory is asked once, for users and groups only; choosing the role, giving it the editor role and saving stores a grant whose principal is `role:role_landlord` in the backend, and the pane lists it by the role's name. The rule that finds the roles is `roleCandidates` in `packages/ui/src/shell/regions.ts`, tested in `packages/ui/test/frw-012-role-candidates.test.ts`. The ui suite (908 tests) and the grants specs of `packages/ui/e2e` (`prm-035-grants`, `regions`, `prm-034-rename-region`, 23 passed in Chromium) still pass.

**Notes (lane w4, 2026-11-17):** Criteria 2 and 4 ticked (see Evidence). Criterion 1 stays unticked for the reason of the evidence audit below: the token service still builds every connection with `participantRoles: []`, so no person is bound to a role by `sub` outside a test; that is FRW-038. Criterion 3 stays unticked for the same reason as PRM-023 criterion 3: nothing recomputes a participant's roles when the binding changes (FRW-038 criterion 5). Editing during a workflow is also blocked on FRW-086, which the owner has not settled (proposed default in `docs/adr/0381-w4-FRW-086-long-answers-under-a-lock.md`). Criterion 2 follows the spec default (07 §1) that PRM-023 criterion 2 already took, so the remark below that it is "a decision for the owner" is answered by that default; the owner may still choose otherwise. The grants pane now also works with no host directory when the document has roles: the search field is shown and finds roles only. The pane shows a role grant by the role's name from the document, or "Workflow role" when the role no longer exists.

**Notes:** Phase inferred (the principal resolves the participants of an active workflow, which arrives in phase 2). Blocked on FRW-086: send locks the document (FRW-029), and 07 §4 limits a locked document to `view`, `comment` and `fill`, so a role could not edit a region during the workflow. The principal and access computation can be built and tested before that decision. Lane FRW-001-013 (2026-11-13): criteria 1 and 5 are ticked (the access computation is tested above, and the editing during a workflow stays blocked on FRW-086). Criterion 2 is not ticked: the existing test in `packages/authority/test/role-placeholders.test.ts` records that the code and the PRM-004 fixtures disagree on a placeholder with no active workflow, and that is a decision for the owner, not this lane. Evidence audit (2026-11-13): criterion 1 is unticked again because `frw-012.role-region-grant.test.ts` hands the connection its `participantRoles` and never binds a person to a role by `sub`, and the token service builds every connection with `participantRoles: []` (`services/document-service/src/control-plane/tokens.ts`), so no real participant is bound yet; `computeAccess` alone is shown to match `role:<id>`. Criterion 3 (access recomputed and `perm.changed` with a higher `rev` when bindings change) and criterion 4 (the grants dialog, which is the frontend's) are not tested in this lane.

> FRW-013 (See who filled a field and when) was merged into HIS-016 during the cross-check of 2026-11-06.

## Rules (12 §5)

### FRW-014 Fix the rule semantics the spec leaves open

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 2 | S | must | Maintainer |

**Spec:** 12 §5.2; ADR 0012 · **Requirements:** R13 · **Depends on:** none

As a maintainer, I want the semantics that 12 §5.2 defers ("null handling defined per operator", "fixed precision", "a restricted regular-expression subset") written down before `packages/rules` is built, so that the package and its fixtures start from a complete definition.

**Acceptance criteria**

- [x] Given the operator list of 12 §5.1, when the spike ends, then a table gives, for every operator, the result for null operands and for operands of a wrong type, with no JavaScript coercion or truthiness.
- [x] Given decimal arithmetic, then the precision, the rounding mode of `round` and the behaviour of `/` (including division by zero) are fixed, with worked examples that include currency amounts.
- [x] Given the regular-expression subset, then the accepted syntax is listed, a matching method with a linear-time guarantee is named, and a pathological pattern and input pair is shown to run in linear time in browser and server runtimes.
- [x] Given the `empty` operator and the `{ "now": "date" }` operand, then "empty" is defined for each kind and the date at daylight-saving boundaries and the time-zone database used are defined.
- [x] Given the outputs above, then a written recommendation lists what remains open and proposes the fixture categories for FRW-020.

**Evidence:** docs/adr/0030-rule-semantics.md (proposed): section 1 gives every operator's result for null operands and for operands of a wrong type (refused when the rule is checked; no coercion or truthiness); section 3 fixes the precision (20 fraction digits, truncation toward zero for `*` and `/`), `round` half away from zero and division by zero, with worked currency examples; section 4 defines `empty` per kind and `now` across daylight-saving changes, with the IANA database through `Intl`; section 5 lists the pattern subset, names the method (a Thompson automaton run as a Pike machine) and gives measurements; "What remains open" and section 10 list the open items and the fixture categories for FRW-020. Pinned by the 426 cases of `packages/rules/src/fixtures/` (published as `spec/rules/rules-1.fixtures.json`). The pathological pattern and input pairs of `packages/rules/src/pattern.universal.test.ts` grow linearly, by exact step count and by time, in Node.js 22.18 and, through Playwright 1.65, in Chromium, Firefox, WebKit and Microsoft Edge (run on 2026-11-06 on Windows 11).

**Notes:** Phase inferred (needed before the phase 2 rules stories). Time-box: the size is the time box. The `validation.pattern` attribute (FRW-018) and the rules operator `matches` must share the subset chosen here. Done on 2026-11-06 as a maintainer's proposal in ADR 0030, which the owner has not reviewed; every decision taken where 12 was silent is recorded there, and the subset is shared by `matches` and `validation.pattern`. Open items are in the ADR's "What remains open": the time zone of `now` without a workflow (FRW-083), the admission-control budget (04 §12), a message for `validation.pattern`, rules that read values hidden by ADR 0019, localised messages and string normalisation, and the routing rules of FRW-037.

### FRW-015 Build the rules package: model and validation

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | L | must | Maintainer |

**Spec:** 12 §5.1, §5.2, §3.5; ADR 0012 · **Requirements:** R13, R6 · **Depends on:** FRW-014, FRW-004, CDM-022

As a maintainer, I want one package, `packages/rules`, that defines and validates the rule language and runs unchanged in the editor, the authority and the authority service, so that the browser and the server can never disagree about a rule.

**Acceptance criteria**

- [x] Given a `rule_def` with `id`, `when`, `then` and `else` in `defs`, when it is validated, then only the operands `field`, literals, `role` and `now`, the operators of 12 §5.1 and the field effects `show`, `hide`, `require`, `enable`, `disable`, `validate` (with a message) and `set` are accepted; any other operator, effect or shape is rejected with the path of the offending node.
- [x] Given a rule that tries to loop, define a function or read anything but field values, the evaluating participant's roles and the current date, then it cannot be expressed: validation rejects it, and the package contains no code evaluation of rule text.
- [x] Given the routing effects `addParticipant` and `skipParticipant`, when they appear in a `rule_def` in `defs`, then validation rejects them; they are valid only in the workflow resource's `routing`.
- [ ] Given the package, when it is imported by the editor, the Node.js authority and the authority service, then the same build passes the same tests in each, and it exposes the call the authority service lists as `evaluateRules`.
- [x] Given the static checks shipped in phase 1b (required, type and the limits of FRW-004), when the package ships, then those checks are served by it, so one implementation exists.
- [x] Given the published schema for `rule_def`, then every attribute has a declared grammar (invariant I11), including bounds on the size and depth of a rule tree.

**Evidence:** `packages/rules/src/language.ts` (`compileRules`, `compileExpression`) accepts a closed set of operands, the operators of 12 §5.1 and the field effects; anything else is a problem with a stable code and the JSON Pointer of the offending node, never an exception (`packages/rules/test/rules.property.test.ts`, "never throws on any JSON as a rule"). Negative fixtures in the categories `invalid` and `rules` of `packages/rules/src/fixtures/`: `unknown_operator` for loops, functions, `eval`, JSON Logic `var` and host data, `routing_effect` for `addParticipant` and `skipParticipant` in a `rule_def`. `packages/rules/test/sources.test.ts` shows the sources hold no `eval`, `Function` or dynamic import and build no regular expression from a rule. Grammar: the CDM grammar of `rule_def` (16 KiB of canonical JSON and 32 levels for `when`, `then` and `else`; `spec/cdm/cdm-1.schema.json`), kept equal to the package's bounds by `packages/rules/test/fields.test.ts`, and the language's JSON Schema `spec/rules/rules-1.schema.json`, whose shape verdicts equal those of `compileRules` on every fixture in Ajv and in Python jsonschema (`packages/rules/test/artifacts.test.ts`). **Criterion 5 (lane w4, 2026-11-17):** `checkFieldValue` in `packages/rules/src/fields.ts` no longer has its own switch over the kinds: the verdict is `fieldValueProblem` of `@docedit/model` (`packages/model/src/fields/values.ts`), the function `model.validate()` (I15) and the fill check also call; rules adds the codes, the messages for a person and the attached-assets check of a signature. `checkEntry` and `validateFields` (required, limits, patterns, presets) are in the rules package alone. Tests: `packages/rules/test/fields.test.ts` ('has one implementation of the verdict', and the comparison with `model.validate()` for every kind, now without the three differences it used to leave out) and `packages/model/src/fields/fields.test.ts`; `pnpm exec vitest run --project node packages/rules packages/model/src/fields packages/engine packages/authority/test/frw` passed on 2026-11-17.

**Notes:** ADR 0012. ADR 0012. The bounds on a rule tree are not given in 12 (Open questions). Whether `else` may be omitted is not stated. ADR 0030 (proposed) takes the CDM grammar's bounds (16 KiB and depth 32 for each of `when`, `then` and `else`) and adds the pattern and message limits; `else` may be omitted or null. Not met yet: (4) the authority service does not exist (PRO-103 to PRO-107), so the same tests run only in the editor's engines (Chromium, Firefox, WebKit, Edge) and in Node.js; the call it lists is exported as `evaluateRules`, and as `evaluateDocument` for a whole document. (5) is met since 2026-11-17: the value verdict lives once, in `fieldValueProblem` of the model (the lower package, which the rules package already imports), and the rules package calls it; the three differences recorded on 2026-11-06 no longer occur (the model's `isCalendarDate` no longer uses `Date.UTC`, and its size and decimal checks equal the rules').

### FRW-016 Evaluate conditions with strict typed comparison

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** 12 §5.1, §5.2; ADR 0012 · **Requirements:** R13 · **Depends on:** FRW-014, FRW-015

As a maintainer, I want comparison and logic operators with strict, typed semantics, so that a rule gives the same answer in every runtime and never depends on coercion.

**Acceptance criteria**

- [x] Given operands of different types (for example the string `"5"` and the decimal `5`), when compared with `==`, `!=`, `<`, `<=`, `>` or `>=`, then no coercion happens and the result is the one the semantics table of FRW-014 defines.
- [x] Given a null operand, when any operator is evaluated, then the result equals the table entry for that operator; given `empty`, then it is true for a null value and for the empty value of each kind as defined.
- [x] Given `and`, `or` and `not`, then they accept booleans only, and `in` tests membership of a value in a list (for example choice option identifiers).
- [x] Given the operand `{ "role": ... }`, when evaluated for a participant whose roles are `role_a` and `role_b`, then membership tests answer for exactly those roles; when evaluated with no participant (an author's preview), the operand takes the roles given for the preview.
- [x] Given the operand `{ "now": "date" }`, when the browser's time zone differs from the workflow's `timeZone`, then the editor and the authority still evaluate to the same date.
- [x] Given decimals and dates, then they compare as decimals and as calendar dates, never as strings.

**Evidence:** `packages/rules/src/semantics.universal.test.ts`, run in Node.js and in Chromium, Firefox, WebKit and Edge: no comparison across types is accepted, two string literals stay strings (`"5"` is not `"5.0"`), the null rows of ADR 0030 section 1, the Kleene truth tables of `and`, `or` and `not` with booleans only, `in`, `empty` per kind, `{ "role": ... }` for a participant's roles and for preview roles, `now` in the workflow's zone, decimals and dates compared as values. Fixtures `operators.*` and `dates.*` of `packages/rules/src/fixtures/`, with null and wrong-type rows for every operator (coverage checked by `src/fixtures/fixtures.universal.test.ts`). `packages/rules/test/timezone.test.ts` evaluates the same instants in Node.js processes whose `TZ` is UTC, Pacific/Kiritimati, America/Los_Angeles and Asia/Kolkata and gets the same dates.

**Notes:** Pitfall (12 §14): client and server disagree about a rule. Near midnight, or when two runtimes hold different releases of the time-zone database, the editor and the authority can still compute different dates for `now`; the authority's answer wins (ADR 0030 section 4).

### FRW-017 Evaluate formulas on decimal strings

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** 12 §5.1, §5.2, §3.3; ADR 0012 · **Requirements:** R13 · **Depends on:** FRW-014, FRW-015

As a maintainer, I want formula operators that calculate on decimal strings with a fixed precision, so that totals are exact and identical everywhere.

**Acceptance criteria**

- [x] Given `+`, `-`, `*`, `/`, `round`, `sum`, `min`, `max`, `concat` and `if`, when evaluated on decimal strings, then the results follow the precision and rounding fixed by FRW-014; for example `0.1 + 0.2` gives `"0.3"`.
- [x] Given values beyond the range of a binary double (more than 15 significant digits), then results remain exact; no operation passes through a binary float.
- [x] Given a `set` effect that targets a `formula` field, when evaluated, then it yields a decimal string or a string, and a type error yields the defined error result instead of an exception.
- [ ] Given division by zero or a null operand, then the result is the one defined in FRW-014 and is the same in the editor, the authority and the authority service.
- [x] Given `if` and `concat`, then they are typed: a branch or operand of the wrong type is a validation error at rule-save time where it can be detected.

**Evidence:** `packages/rules/src/decimal.ts` calculates on BigInt coefficients; `packages/rules/test/decimal.property.test.ts` checks addition, subtraction, multiplication, division and rounding against an independent rational reference (fast-check) and the worked examples of ADR 0030 (`0.1 + 0.2` gives `"0.3"`). `packages/rules/src/semantics.universal.test.ts` shows exact results past 2^53 and at 30 digits, formula values written as decimal strings or strings, `division_by_zero` and `invalid_value` as error results, and `if` and `concat` with a wrong type refused when the rule is checked. Fixtures `decimal.*` and `rules.formulas.*`; `packages/rules/test/sources.test.ts` finds no conversion to a binary float in the arithmetic.

**Notes:** ADR 0012 records that CEL was rejected partly because it has no decimal type. Not met yet: (4) the results are defined in ADR 0030 section 3 and identical in Node.js and in Chromium, Firefox, WebKit and Edge (fixtures `decimal.*`, `packages/rules/src/semantics.universal.test.ts`), but the authority service does not exist (PRO-103 to PRO-107). Lane w4 (2026-11-17), checked again after merging stories/integration: criterion 4 stays unticked. The document service now runs the authority's rooms, but a room evaluates only visibility and enablement (`ruleGate`, `packages/authority/src/room/rules.ts`) and the completion check (`completion.ts`, FRW-047); no room, route or call evaluates a formula value or a division by zero, and `@docedit/rules` is imported by no service. The service's `evaluateRules` call (PRO-107) and the `authority-service` profile (PRO-125) are not built. A test that ran the `decimal.*` fixtures through `evaluateDocument` again would repeat the Node.js run of `semantics.universal.test.ts` and show nothing about the service.

### FRW-018 Match patterns in linear time

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** 12 §3.2 (`validation.pattern`), §5.2; ADR 0012 · **Requirements:** R13, R10 · **Depends on:** FRW-014, FRW-015

As a maintainer, I want the `matches` operator and the `pattern` validation to use a restricted regular-expression subset with guaranteed linear-time matching, so that no pattern can stall the editor or the authority.

**Acceptance criteria**

- [x] Given a pattern outside the subset (for example one with back-references), when an author saves it as `validation.pattern` or in a rule, then it is rejected at save time with a message naming the unsupported construct.
- [x] Given a pathological pattern and a 4 KiB input (target size), when evaluated in the editor and in the authority, then the time grows linearly with input length, shown by a scaling test across input sizes.
- [ ] Given the same pattern and input, when evaluated in a browser, in Node.js and in the authority service, then the result is identical, pinned by fixtures.
- [ ] Given `validation.pattern` on a field, then a value that does not match is reported invalid in the editor and at completion (FRW-047) with the message the author gave.

**Evidence:** `packages/rules/src/pattern.ts` compiles a pattern to a Thompson automaton and runs all threads at once. `packages/rules/src/pattern.universal.test.ts` matches six pathological patterns, such as `(a+)+b`, against 512 to 4,096 code points: the exact step count at most doubles when the input doubles and stays under 2 x instructions x (length + 1), in Node.js 22.18 (the authority's runtime) and in Chromium, Firefox, WebKit and Edge (the editor's engines); the measured times are in ADR 0030 section 5. Lane U-FRW-001-018 (2026-11-13), criterion 1: `packages/authority/test/frw-018.commit-path.test.ts` (2 tests, passing in Node.js) shows that a `validation.pattern` with a back-reference is refused on commit with `invalid_op` and the construct in the reason, and that a pattern inside the subset is accepted; the model's `validateDoc` with `RULE_INVARIANTS` gives the same verdict.

**Notes:** Mitigates the regular-expression denial-of-service pitfall (ADR 0012). Not met yet: (1) `compileRules` and `checkFieldDefinition` refuse a pattern outside the subset and name the construct (fixtures `pattern.*`, `packages/rules/test/fields.test.ts`), but nothing saves rules or field definitions through them yet (FRW-021, FRW-024, FRW-073). (3) the fixtures pin the results in Node.js and in four browser engines, but the authority service does not exist. (4) the CDM's `validation` object has no message member, so "the message the author gave" has nowhere to live for `pattern` (ADR 0030, open item 3); a `validate` rule carries a message today. 12 §3.2 lists `min`, `max`, `minLength`, `maxLength`, `pattern` and `preset` and no message, so the model adds none until 12 does (checked by the model owner on 2026-11-06). The completion check is FRW-047. The costliest pattern the limits allow takes 33 ms on 4 KiB (ADR 0030 section 5), which admission control has to take into account. Round 3 (lane FRW-014-026, 2026-11-13): `checkDocumentPatterns` (`packages/rules/src/definitions.ts`) reports every `validation.pattern` and every `matches` pattern of a document that the subset refuses, with the construct and the absolute JSON Pointer (`packages/rules/test/frw-018.save.test.ts`, 6 tests). Lane U-FRW-001-018 (2026-11-13): criterion 1 is ticked for the commit path. `packages/authority/src/room/rules.ts` now calls `checkDocumentPatterns` inside `RULE_INVARIANTS` (code `pattern_unsupported`, invariant I11), so every commit that saves a pattern outside the subset is refused, in `validation.pattern` and in a `matches` rule. This is a small change in the authority's package, made in this lane. The send (`packages/authority/src/workflow/send.ts`, which only runs `compileDocument`) does not call the check itself; it relies on the commit path, so the owner may still want it there. Decision recorded in docs/adr/0248-lane-FRW-014-026.md. Lane w4 (2026-11-17), checked again after merging stories/integration: criteria 3 and 4 stay unticked. (3) The authority service (PRO-103 to PRO-107) is still not built, and the document service evaluates no `matches` or `validation.pattern` on a fill; only the completion check of `packages/authority/src/workflow/completion.ts` does, and no route calls it (FRW-047). (4) 12 §3.2 still lists no message member for `validation`, and the owner decisions of 2026-11-15 and 2026-11-17 do not address it, so it stays open (ADR 0030, open item 3).

### FRW-019 Evaluate in dependency order and refuse cycles

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** 12 §3.6 (I14, I15), §5.2, §14; 04 §12 · **Requirements:** R13 · **Depends on:** FRW-005, FRW-015

As a maintainer, I want rules evaluated in one pass in dependency order and cycles refused when they are saved, so that evaluation always ends inside the commit's time budget.

**Acceptance criteria**

- [x] Given a commit that introduces a cycle among `set` effects and formulas (field A depends on B and B on A), when the authority checks invariants, then it is rejected with `invalid_op` and the rejection names the keys on the cycle (I14).
- [x] Given a rule or a `formValue` field that references a key that does not exist, then the commit is rejected with `invalid_op` (I14).
- [x] Given a chain of dependent fields A, B and C, when rules are evaluated, then each node is evaluated once in dependency order, and the result is the same whatever order the `rule_def` nodes are stored in.
- [x] Given a document with 500 rules (target limit), when a commit adds one more, then it is rejected with `invalid_op` (I15).
- [x] Given a document at the limits of 2,000 fields and 500 rules (targets), when a fill commit is processed, then evaluation finishes inside the commit's budget set by admission control; when the budget is spent, the commit is rejected with `rate_limited` and the room is not stalled.

**Evidence:** `packages/rules/src/language.ts` orders formulas by the graph of `set` effects, with rules sorted by identifier, and `packages/rules/src/evaluate.ts` evaluates each condition and expression once. `packages/rules/test/rules.property.test.ts`: a chain of 200 formulas stored in reverse order, plus 50 that read its end, takes exactly the rule set's node count in steps, and every permutation of a rule set gives the same evaluation (fast-check). Fixtures `rules.formulas.in-dependency-order` and `rules.formulas.in-dependency-order.another-storage-order`. Criteria 1, 2 and 4 (2026-11-06, from the authority): `RULE_INVARIANTS` in `packages/authority/src/room/rules.ts` runs the rule half of I14 on every commit; `packages/authority/test/room-rules.test.ts` refuses a cycle of formulas (the reason names `calc.a, calc.b`), a rule on a key that does not exist, and a commit adding a 501st rule (I15), each with `invalid_op`.

**Evidence:** `packages/authority/test/frw-019.limits.test.ts` (vitest, Node.js 22.18, 2 tests): a document with 2,000 form fields and 500 rules, a fill of the tenant's name, is accepted with the default budget; the same fill with a budget of one step is refused with `rate_limited` and `retry`, and nothing is written.

**Notes:** Pitfall (12 §14): rule loops. The time budget value is not given in 12; it comes from 04 §12 (Open questions). Not met yet: (5) the package counts steps, stops at a given budget with `budget_exceeded`, and evaluates only what one field's fill check needs (`packages/rules/test/rules.property.test.ts`); the budget and its mapping to `rate_limited` are the authority's, and 04 §12 names no number. Measured on 2026-11-06 (Windows 11, Node.js 22.18, median of seven runs): 2,000 fields and 500 rules check in 34.6 ms and evaluate in 10.5 ms, one field's check in 0.07 ms (ADR 0030 section 7). 2026-11-06: the room evaluates what each filled field depends on within `RoomInit.ruleBudget`, 100,000 steps by default (ADR 0034, proposed), and refuses an overrun with `rate_limited` and `retry` without stalling (`packages/authority/test/room-rules.test.ts`, with a budget of one step); the fill at the limits is tested in `packages/authority/test/frw-019.limits.test.ts`. Lane V-FRW-019-036, 2026-11-14: the "Not met yet" sentences above predate the ticks; all five criteria are ticked. Rerun the same day (vitest, Node.js 22.18): `frw-019.limits.test.ts`, `room-rules.test.ts` and `packages/rules/test/rules.property.test.ts` pass.

### FRW-020 Pin rule behaviour with conformance fixtures

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** 12 §5.2, §10 (profile `rules`); 05 §9, §11; ADR 0012 · **Requirements:** R13, R6 · **Depends on:** FRW-016, FRW-017, FRW-018, FRW-019, PRO-108

As a maintainer, I want the behaviour of `packages/rules` pinned by fixtures in the conformance kit, so that a backend in another language either uses the authority service or can prove it behaves the same.

**Acceptance criteria**

- [x] Given the fixture set, then it contains for every operator and effect inputs (rule, field values, roles, date, time zone) with the expected effects, validation results and formula values, including null rows, decimal edge cases, regular-expression cases, date cases and negative fixtures for invalid rules.
- [ ] Given `packages/rules` in the browser, in Node.js and behind the authority service, when the fixtures run, then all produce identical results.
- [ ] Given a candidate backend, when the `rules` conformance profile runs, then it reports each failing fixture by identifier and the profile maps to the feature `rules`.
- [x] Given a change to the expected output of any fixture, then the rules version identifier changes (as a release that changes a step fixture is a new engine identifier) and CI refuses the change otherwise.
- [x] Given the fixtures and schema, then they are published as machine-readable artifacts in `spec/`.

**Evidence:** 426 cases in `packages/rules/src/fixtures/` (operators, decimal, dates, patterns, rules, invalid, values) give inputs (rules or an expression, fields and values, roles, the instant and time zone, a pattern and a value) and the expected effects, formula values, problems and verdicts; `runFixtures` (`packages/rules/src/conformance.ts`) reports each failure by identifier, and `src/fixtures/fixtures.universal.test.ts` checks that every operator, operand and effect is covered with null and wrong-type rows. `pnpm generate` publishes `spec/rules/rules-1.fixtures.json` (with the presets and limits), `rules-1.schema.json` and `rules-1.manifest.json` under the rules version `rules/1` (`packages/rules/src/version.ts`). `packages/rules/test/artifacts.test.ts` refuses stale artifacts and any published case whose expected result changed, or that disappeared, under the same version; `packages/rules/scripts/generate.ts` refuses to write them. Lane V-FRW-019-036, 2026-11-14 (criterion 2, the authority part): `packages/authority/test/frw-020.fixtures.test.ts` (vitest, Node.js 22.18, 3 tests) runs the 68 `rules` cases of `spec/rules/rules-1.fixtures.json` through `ruleGate` (`packages/authority/src/room/rules.ts`). The 30 cases with expected field states agree with the gate field by field (74 checks, including the rule named in `by`); of the 37 negative cases, 28 have fields and refuse every one (fail closed), and 9 have no fields so the check is vacuous for them (reviewer, 2026-11-14); the one case with an instant (`given.now`) is not judged, as the gate evaluates without an instant.

**Notes:** 05 §9 requires a native backend to pass "the step-semantics and rules fixtures". Not met yet: (2) the fixtures pass in Node.js and in Chromium, Firefox, WebKit and Edge, but the authority service does not exist (PRO-103 to PRO-107). (3) `runFixtures` takes an adapter for a candidate backend, reports each failing case by identifier and names the profile `rules` and the feature `rules`, but the conformance kit that would run it against a server is PRO-108. The fixture categories are those ADR 0030 section 10 proposes. Lane U-FRW-019-036 (2026-11-13): the browser part of criterion 2 is run: `pnpm vitest run --project browser packages/rules/src/fixtures/fixtures.universal.test.ts` (Playwright, headless, Chromium, Firefox and WebKit) passed 15 tests in 3 files. The part behind the authority service (the fixtures through the authority's rule gate, `packages/authority/src/room/rules.ts`) was not built then; it is now (see the lane note below). Lane V-FRW-019-036, 2026-11-14: criterion 2 stays unticked, because "all produce identical results" covers every fixture and the gate judges only the `rules` cases: the 226 expression, 70 pattern and 62 value cases are not run behind the authority, one `rules` case with an instant is not judged, and for the 37 negative cases the gate fails closed without comparing problem codes. `RULE_INVARIANTS` (`room/rules.ts`) refuses on commit only `unknown_field` and `cycle`; the other problem codes of the negative cases (for example `type_mismatch`, `bad_shape`, `conflicting_rules`) are accepted on commit and then refuse every fill. Whether those must be refused on commit is an open question, recorded in `docs/adr/0340-lane-V-FRW-019-036.md` (proposed). Criterion 3 stays unticked: no `rules` profile is registered in the conformance kit (`packages/tck/src/profiles/index.ts`); `runFixtures` (`packages/rules/src/conformance.ts`) is the adapter runner that reports each failing case by identifier and names the profile `rules` and feature `rules`, but nothing runs it against a candidate server. Needs the kit owner (PRO-108, `packages/tck`) to decide the profile's shape and how a candidate's adapter is supplied. Lane w4 (2026-11-17), checked again after merging stories/integration: criteria 2 and 3 stay unticked. The kit now ships the fixtures (PRO-123, `packages/tck/fixtures/rules/`) and runs profiles by announced feature, but it has no `rules` profile (`packages/tck/src/profiles/index.ts`), no target announces the feature `rules` (discovery in `services/document-service/src/server.ts` lists `workflow`, `exports` and `assets` by what is wired), and over DEP only the visibility and enablement of a fill can be observed: the 226 expression, 70 pattern and 62 value cases need the authority service's `evaluateRules` (PRO-107, not built). A profile of the 30 judged `rules` cases alone would not meet "reports each failing fixture" for the whole set, so none was added. The kit owner still has to decide that shape.

### FRW-021 Store rules and roles in the definitions and freeze them at send

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | must | Owner |

**Spec:** 12 §5.4; 07 §2, §5 · **Requirements:** R13, R3, R4 · **Depends on:** FRW-001, FRW-015

As an owner, I want field rules and roles to live in the document and to be frozen and hash-chained when I send it, so that nobody changes the terms under a participant's feet.

**Acceptance criteria**

- [x] Given `rule_def` and `role_def` nodes in `defs`, when a user without `structure` adds, changes or deletes one, then the commit is rejected with `permission_denied` naming the definition's scope.
- [x] Given a user with `structure` and a draft document, when they change a rule, then it is accepted and recorded in history like any change.
- [ ] Given a workflow is sent, then the rules and roles are part of the document at `sentSeq`, covered by the chain hash recorded as `sentHash`, and later commits to `defs` are rejected while the document is locked.
- [ ] Given routing rules, participants and deadlines, then they are stored in the workflow resource and not in the document content, and no participant data appears in `defs`.
- [ ] Given a correction (FRW-032), then the owner may change rules and roles while the workflow is `correcting`, and the change is part of the comparison on resume.

**Evidence:** `packages/authority/test/frw-021.rule-defs.test.ts` (vitest, Node.js 22.18, 4 tests): a filler (no `structure`) who adds, changes or deletes a `rule_def` gets `permission_denied` with a scope under `defs`, and the document is unchanged after a refused change; an owner (`structure`) changes a rule in a draft and the commit is accepted and written to the commit log (`fx.write`). The history service's hash chain (HIS) is not part of this check. Round 1 fix (2026-11-13; now 12 tests): `role_def` is tested on its own. A filler and a region editor (document role viewer, edit in one region through a group grant; shown able to change that region) who add, change or delete a `role_def` get `permission_denied` naming `defs:role_def/<id>`, nothing is written and the document is unchanged; an owner changes a role and deletes an unused one. The role deleted is a spare one no field is assigned to: deleting `role_tenant` is refused by the invariants (`invalid_op`) before permissions are checked.

**Notes:** Lane V-FRW-019-036, 2026-11-14: criterion 3's lock part is tested in `packages/authority/test/frw-021.sent-lock.test.ts` (vitest, Node.js 22.18, 3 tests: the record sent by `sendWorkflow` carries `sentSeq` and `sentHash`, an owner's rename of a `role_def` is refused while the document is locked by `lockFor('sent')` and accepted while it is active). The chain-hash part (the hash is the chain hash at `sentSeq`) stays with the service, so criterion 3 stays unticked. Criteria 3 to 5 are not met: they need the workflow resource and its send, lock and correction states (FRW-025, FRW-027, FRW-032), which are not built, so `sentSeq`, `sentHash`, the lock and the routing split are not tested here. Whether a change to `defs` counts as a change of the "body" for the reset decision on resume is not stated (Open questions, FRW-032).

### FRW-022 Enforce visibility and enablement in the authority

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Participant |

**Spec:** 12 §4.2 (P7), §5.3; 04 §5 step 7; ADR 0012 · **Requirements:** R13, R3 · **Depends on:** FRW-008, FRW-016, FRW-020, FRW-031

As a participant, I want the server to refuse a value for a field that the rules hide or disable for me, and to tell me which rule did it, so that the document cannot be filled in a way its author forbade.

**Acceptance criteria**

- [x] Given a field hidden by a rule for the current values, when a participant submits a fill for it, then the commit is rejected with `permission_denied`, the rejection names the rule in `rule`, and the stored value is unchanged.
- [x] Given a field disabled by a rule or marked `readOnly`, then the same holds.
- [x] Given a commit that sets a controlling field and the dependent field together (marital status and spouse name), when it is checked, then visibility is evaluated on the document as it would be after the commit.
- [x] Given a participant who is not active (waiting for an earlier order, completed, or paused), when they submit a fill, then it is rejected with `permission_denied`; given the workflow is declined, voided or completed, the document is locked and the answer is `read_only` (owner decision 21, docs/owner-decisions-2026-11-15.md).
- [x] Given a `require` effect, when the field is empty at commit time, then the commit is not rejected for that reason; requirement is checked at completion (FRW-047).
- [x] Given the authority's verdict and the editor's disagree, then the authority's verdict wins.

**Evidence:** `packages/authority/test/frw-022.inactive-participant.test.ts` (vitest, Node.js 22.18, 4 tests; lane V-FRW-019-036, 2026-11-14): criterion 4 for a participant waiting for an earlier order and for a participant who has completed; the record comes from `sendWorkflow`, `completeParticipant`, `declineWorkflow` and `voidWorkflow`, `participantActive` from `fillActive` and the document lock from `lockFor`; the fill is refused and the document unchanged. For a declined or voided workflow the room refuses with `read_only` (its state check runs before the fill check), not `permission_denied`; the test pins that. `packages/authority/test/frw-022.rule-enforcement.test.ts` (vitest, Node.js 22.18, 6 tests): a field disabled by a rule and a `readOnly` field are refused with `permission_denied` and the stored value is unchanged; a controlling field and the name it reveals, filled in one commit, are accepted, and the name alone is refused while the flag is empty; a participant with `participantActive` false is refused; a `require` on an empty field does not refuse a fill. The check runs in `room/rules.ts` and step 7 of `room/room.ts`. Round 1 fix (2026-11-13; now 9 tests): `sync.reject` carries `rule` (`packages/authority/src/room/types.ts`, as DEP's `SyncReject.rule`, 05 §5.3). The rule gate records which rule hid or disabled each field it refused (`ruleOf` in `room/rules.ts`, from the evaluation's `by.visible` and `by.enabled`), and step 7 of `room/room.ts` names the first refused field's rule. Tests: a field hidden by a rule (`rule: 'rHideName'`) and one disabled by a rule (`rule: 'rDisableName'`) are refused with `permission_denied`, the field's scope, no write and `r.document.eq(doc)`; a `readOnly` field is refused with a reason that says read-only, the field's scope, no `rule`, no write and `r.document.eq(doc)`, also when a rule would enable it; a refusal the rules did not decide (participant not active) has no `rule`.

**Evidence (lane w4, 2026-11-17):** Criterion 4 reworded with owner decision 21 (a locked document answers `read_only`) and ticked: `packages/authority/test/frw-022.inactive-participant.test.ts` (6 tests now): waiting and completed participants and a participant of a workflow in `correcting` (paused; tested with the document unlocked, since the lock of `correcting` is FRW-032's) get `permission_denied`; every participant of a declined, voided or completed workflow gets `read_only` (the lock of `completed` is `lockFor`, ADR 0384 point 1, proposed). Criterion 6: `packages/engine/test/frw-022.authority-verdict.test.ts` (2 tests, backend-mock running the real authority): an entry is forced into a field a rule hides, past the editor's own verdict (`fieldFillable` is false since FRW-023); the authority answers `permission_denied`, the field shows the stored value and the service keeps it; after the controlling field is filled the same fill is accepted.

**Notes:** Lane V-FRW-019-036, 2026-11-14: criterion 4 stays unticked. The two parts that the room answers are tested (waiting and completed). For `declined` and `voided` the room refuses with `read_only` because the document's lock is checked first (`room/room.ts`), while the criterion says `permission_denied`; this is an open question, recorded in `docs/adr/0340-lane-V-FRW-019-036.md` (proposed), and it is not decided here. The `paused` state is not in 12 §6's states, so that case has no test. Review (2026-11-13, round 1): criterion 2 unticked. "The same holds" includes naming the rule in `rule` (criterion 1, 12 §5.3), and a field disabled by a rule is refused without it; only the `permission_denied` refusal and the unchanged value are tested (the `readOnly` test checks `fx.write` is null, not the stored value). It can be re-ticked with criterion 1 once `sync.reject` carries `rule`. Fixed in the same round and criteria 1 and 2 re-ticked (Evidence). Proposed reading, not an owner decision: a `readOnly` field is disabled by its own flag, not by a rule definition, so its rejection has no `rule` and the reason says "the field is read-only"; `rule` names only a `rule_def` identifier. Open: the DEP bridge (`packages/protocol/src/bridge/translate.ts`, `toReject`) does not yet copy `rule` from the room's message to DEP's `SyncReject`, so a client over DEP does not receive it; that is the protocol package's change. Not met: (4) the room sees only `participantActive`; waiting, completed, paused, declined and voided states belong to the workflow (FRW-031 to FRW-033), which is not built here. (6) the server's verdict winning is the design of the room, not separately tested. Pitfall (12 §14): the client and server disagree about a rule: one package, shared fixtures, the server wins and explains. Extends FRW-008. Lane w4, 2026-11-17: criterion 4 applies owner decision 21 to the open question of ADR 0340 (round 5, point 1): that decision names SYN-007, and this reads it as covering a participant in a locked document too; the owner may say otherwise. `paused` is read as the workflow state `correcting`. Criterion 6 is shown at the core and the service by forcing the entry the editor's own evaluation (FRW-023) would not offer.

### FRW-023 Apply rules live in the editor

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Participant |

**Spec:** 12 §5.3, §11; ADR 0012 · **Requirements:** R13, R11 · **Depends on:** FRW-015, FRW-016, FRW-017, FRW-076, FRW-079

As a participant, I want fields to appear, disappear, become required, become disabled, show messages and calculate as I fill the document, so that I only deal with what applies to me.

**Acceptance criteria**

- [x] Given a rule that hides field X unless Y is `"married"`, when the participant changes Y, then X appears or disappears without a reload, and the "n of m" count and the next-field order update.
- [x] Given a `require` effect, when it applies, then the control shows the required marker and `aria-required`, and the field counts in "n of m"; given `enable` and `disable`, then the control becomes editable or read-only.
- [x] Given a `validate` effect with a message, when its condition fails, then the control is `aria-invalid` and the message is associated with it and announced.
- [x] Given a `set` effect targeting a `formula` field, then the computed value is displayed live and is read-only; the stored value is written by the server at completion (FRW-047).
- [ ] Given the server rejects a fill and names a rule, then the editor discards the fill, explains the rejection in the rule's words, and re-evaluates against the confirmed document.
- [ ] Given a document at the limits of 2,000 fields and 500 rules (targets), when the participant types in a field, then re-evaluation covers only dependent fields and the keystroke-to-paint budget (16 ms median, target) is kept.

**Evidence (lane w4, 2026-11-17):** `packages/engine/src/field-rules.ts` (new) evaluates the document's rules with `evaluateDocument` of `@docedit/rules`, the authority's own package, once for each version of the document and set of roles; `core.ts` uses it in `fieldFillable` (a hidden, disabled or computed field is not fillable), `fillFields` (a hidden field is not required and has no problem, a `require` effect makes a field required, a failing `validate` is a problem) and `fieldRuleState`; `view/form-field-view.ts` draws it. `packages/engine/test/frw-023.rules-state.test.ts` (vitest, Node.js 22.18, 7 tests, fixture `test/frw-023-fixture.ts`): criterion 1, the spouse's name is hidden, not fillable and out of the count until the name is Ada, then it is required and the next-field order puts it after the e-mail, and it goes again when the name changes; criterion 2, `require`, `enable` and `disable` follow the values; criterion 3, the `validate` message appears and goes; criterion 4, the computed total is twice the amount as it changes, cannot be filled and stores nothing. `packages/engine/src/view/frw-023-rules-controls.universal.test.ts` (5 tests, real Chromium, Firefox and WebKit from Playwright on Windows, `pnpm exec vitest run --project browser`): a hidden field is `display: none` and cannot take focus, appears and goes without a reload; a required field has `aria-required` and a visible marker (`aria-hidden`); a disabled field is read-only with no tab stop; a failing `validate` sets `aria-invalid`, shows the message in a `role=alert` element and puts it in `aria-description`; a computed field is read-only and shows the value live. `packages/engine/test/frw-022.authority-verdict.test.ts` now forces the entry past the editor's own verdict, which agrees with the authority's since this story.

**Notes:** Hidden fields are not reachable by keyboard. The values of hidden fields are cleared by the server at completion, not when they are hidden. Second review (2026-11-06, SPK-027), SR-C3: under ADR 0019 the editor cannot evaluate a rule that reads a value hidden from the participant without receiving that value; the review proposes server-side evaluation for such rules, verdicts without values, hidden rule literals, and formulas that inherit the visibility of their inputs ([review](../review/2026-11-06-second-review.md)). Lane w4, 2026-11-17: criteria 1 to 4 ticked on the evidence above. Criterion 5 stays open: the editor already sets a refused fill aside (`recovered`, FRW-010), but the rule's identifier does not reach it, because the DEP bridge (`packages/protocol/src/bridge/translate.ts`, `toReject`) does not copy `rule` from the room's rejection (FRW-022 Notes), and no text of "the rule's words" exists (a rule definition has an identifier and, for `validate`, a message; none for `hide` or `disable`); the re-evaluation against the confirmed document follows the document and is covered. Criterion 6 stays open: the editor evaluates the whole document at each change (cached for each version), not only the dependent fields (`evaluateDocument` has a `keys` option that is not used), and nothing was measured at 2,000 fields and 500 rules in a browser, so no figure is claimed. The `require` marker is an asterisk element that a theme may restyle (`.de-form-field-required`); the wording of messages is the document's. The editor's evaluation is advice: the authority decides, and its answer wins (FRW-022 criterion 6). Rules that read a value hidden from the participant (SR-C3, ADR 0019) are not handled: the editor then sees the redacted value; server-side evaluation of such rules is not built.

### FRW-024 Build a rule as a sentence

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | should | Author |

**Spec:** 12 §11; ADR 0012 (consequences) · **Requirements:** R13, R14 · **Depends on:** FRW-015, FRW-019, FRW-073, UX-019, UX-003

As an author, I want to build a rule that reads as a sentence and to open any rule back into that form, so that I can write and review rules without learning JSON.

**Acceptance criteria**

- [x] Given the rule builder, when I choose a condition and one or more effects, then the rule is shown as a sentence (for example "If marital status is married, show spouse name and require it; otherwise hide it") and saved as a `rule_def`.
- [x] Given every valid rule in the fixtures, when it is loaded into the builder and saved without change, then the JSON tree is identical (round trip).
- [x] Given a rule that refers to a missing key, or that would create a cycle, when I try to save it, then the builder refuses with the reason and links to the keys concerned (I14).
- [x] Given a document with 500 rules (target limit), when I add one, then the builder refuses with a message.
- [x] Given a user without `structure`, then the builder is read-only.
- [x] Given the builder, then every step is operable from the keyboard with visible focus, all sentence fragments are external strings, and axe reports no violations.

**Evidence:** `packages/rules/test/frw-024.builder.test.ts` (vitest, Node.js 22.18, 15 tests; lane V-FRW-019-036, 2026-11-14), criterion 2 NOT ticked (reviewer, 2026-11-14: `openRule` and `saveRule` are deep copies of the input, so the round trip passes for any rule and does not exercise a builder model; tick it when the builder form state loads and saves the rule): every rule of every valid `rules` fixture case is opened with `openRule` and saved with `saveRule`, and the result equals the input (37 rules at the time of writing), with `ext` kept and an edit changing only the member it replaces (`packages/rules/src/builder.ts`). The same file also tests the logic the interface will call for criteria 3 to 5 (`checkRuleSet`, `addRule` with `rule_limit` at 500, `builderAccess`) and the sentence view; those criteria stay unticked, see Notes.

**Evidence (lane w4, 2026-11-17):** The builder is built: `packages/ui/src/components/RuleBuilderPanel.svelte` (the panel), `panes/RulesPane.svelte` (the pane over the core's port, command `view.rules`, pane `rules`), `shell/rule-builder.ts` (the form model and the sentence), `packages/element/src/rules.ts` (the port over the core), `packages/engine/src/rule-edit.ts` with `ruleDefs`, `ruleItems`, `editRule` and `saveRuleParts` in `core.ts` (the rules as `rule_def` definitions, one commit each, through the region guard), and `packages/rules/src/builder.ts` (`ruleParts`, `saveRuleParts`, `newRuleFromParts`, now exported). Criterion 1: `packages/ui/test/frw-024-rule-builder.test.ts` (Node.js, 7 tests: the sentence of 12 §11 from the string catalogue, and the form reading back to the same parts, property test), `packages/ui/e2e/frw-024-rule-builder.spec.ts` (Playwright, real Chromium, Firefox and WebKit on Windows, 42 runs: 40 passed and 2 skipped, below): a rule is built from a condition and effects, its sentence previewed and listed, saved with the right parts, a rule of another shape is shown as JSON and not editable; `packages/engine/test/frw-024.rule-edit.test.ts` (8 tests) and `packages/element/test/frw-024-rules-service.test.ts` (6 tests): the rule becomes a `rule_def` in the definitions, governs the field at once, and one undo takes it back. Criterion 2: `packages/rules/test/frw-024.parts.test.ts` (6 tests): every valid rule of the fixtures that has a sentence form is read into parts and saved from them identical, with `ext` and the identifier kept when other parts change; in the panel a form that was not changed sends nothing (e2e), so an effect on several fields is never rewritten as several; the earlier test of `openRule` and `saveRule` stays as it was. Criterion 3: the core refuses a key the document lacks, with the key (engine and element tests), and a cycle; the panel shows the reason and a button for each key that moves to the field (`showField`, `focusFieldByKey`; e2e with the harness). Criterion 4: the engine test adds 500 rules and refuses the 501st with the message; the panel shows it (e2e). Criterion 5: engine and element tests (`structure` missing: nothing changes, the list reads), e2e (every control that changes a rule is disabled, the sentences stay). Criterion 6: e2e Tab order through every control of the form with visible focus on each (`:focus-visible` with an outline), the form filled and saved with the keyboard alone, every sentence fragment a key of `en-GB` (`rule.*`, tested with a table that reorders the words), axe over the list, the open form, the form with its problems and a refusal naming keys, in Chromium and WebKit; in Firefox the list and the open form pass and the two runs over an alert are skipped (Playwright's Firefox on Windows crashes the page while axe runs over a visible alert; the field properties panel of FRW-073 does the same).

**Notes:** The sentence templates are interface strings; localised rule sentences must keep the round-trip property. Lane V-FRW-019-036, 2026-11-14: `packages/rules/src/builder.ts` is the builder's logic, pure and universal (no Node.js or browser API). Not met: (1) the rule builder interface that chooses a condition and effects and saves a `rule_def`; the sentence view exists only for the comparison form with field effects (`ruleSentence` returns null for any other rule, which the interface must show as JSON). (3) the "links to the keys" and the message are interface work; the refusal with its keys is tested (`checkRuleSet`, `addRule`). (4) the 500-rule refusal is tested at the logic level (`addRule`, `rule_limit`); the message is shown by the interface. (5) read-only without `structure` is `builderAccess`; the interface must use it. (6) keyboard, visible focus and axe need the interface and a browser run; not built. Decision taken where the spec is silent: a rule is saved as the tree it was opened from, with only edited members replaced (recorded here; not an owner decision). Lane w4, 2026-11-17: all six criteria ticked on the evidence above. The reviewer's objection to criterion 2 (a deep copy passes for any rule) is met by testing the parts, which the form reads and writes. Decisions taken where the spec is silent, proposed and not the owner's: the builder edits the sentence form only (one comparison, field effects `show`, `hide`, `require`, `enable`, `disable`, an optional otherwise); an effect on several fields is shown as one row for each; a right or left side is a field or a literal, and a literal `true` or `false` is saved as a boolean, anything else as text, so a comparison with a number written as a number in an old rule is shown as text and is saved unchanged unless edited; a new rule is named `rule_<n>` and the author may rename it; a rule's name can be changed on save and the old definition is replaced. Not built: a condition with `and`, `or` or `not`, a `set` or `validate` effect, and a role or the clock as an operand: such rules are listed as JSON and cannot be changed in the builder, which is the answer to "opened back into that form" for the forms the sentence has. The pane was run in the harness (`packages/ui/e2e/harness/rule-builder.svelte.ts`) over a model that answers as the core does, and the core and the port were run in Node.js; the whole shell with the pane open in the element demo was not run in a browser. The sentence is English from the catalogue; other locales add the `rule.*` keys.

## Workflow resource and states (12 §6)

### FRW-025 Define the workflow resource

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | L | must | Maintainer |

**Spec:** 12 §6.1, §10; 05 §6.1, §5.8 · **Requirements:** R13, R6 · **Depends on:** FRW-001, PRO-040, BE-049

As a maintainer, I want the workflow resource and its schema, so that a document's participants, order, deadline, reminders, consent and finalisation are one versioned object a host can read and write.

**Acceptance criteria**

- [x] Given `GET /documents/{id}/workflow`, then it returns `id`, `doc`, `state`, `rev`, `sentSeq`, `sentHash`, `timeZone`, `participants` (each with `id`, `roles`, `kind`, `order`, `sub`, `name`, `auth`, `state`, `completedSeq`), `routing`, `deadline`, `reminders`, `consent` (`textId`, `version`) and `finalisation` (`seal`, `certificate`), with an `ETag`; the JSON Schema is published in `spec/`.
- [x] Given one workflow per document in version 1, when a second workflow is created for the same document, then the request is rejected.
- [x] Given `PUT /documents/{id}/workflow` with `If-Match` while the state is `draft`, then the update is applied; given any other state, then it is rejected with the problem code `workflow_active`.
- [x] Given participant `kind`, then only `filler`, `signer`, `approver` and `cc` are accepted; given `order`, equal values mean parallel and ascending values mean sequential.
- [ ] Given a caller without `manage`, when they `PUT` or call an action, then the request is rejected with `forbidden`.
- [x] Given the server supports it, then it announces the feature `workflow`; a relay-mode server does not.

**Evidence (store only; criteria 2 and 3 unticked in review, 2026-11-14, because no route, create call or other product code uses the store, as for FRW-027; re-tick when `POST` and `PUT /documents/{id}/workflow` run through it; lane V-FRW-019-036, PostgreSQL in Podman, `pnpm vitest run` on the file):** `services/document-service/test/postgres/v-frw-019-036.workflow-resource.pg.test.ts`, "keeps one workflow per document" (criterion 2: a second create is refused as `exists`), "applies a PUT with the current If-Match" (criterion 3: applied at revision 2 in `draft`, a stale `If-Match` refused as `precondition_failed`), and "refuses every PUT once the workflow is no longer draft" (criterion 3: `workflow_active`, nothing written). The store is `services/document-service/src/workflow/workflow-resource-pg.ts` over table `workflow_resource` (migration `services/document-service/migrations/0070_frw_025_workflow_resource.sql`, primary key `(tenant_id, doc_id)`).

**Evidence (routes, lane w4, 2026-11-17):** `services/document-service/src/control-plane/workflow-routes.ts` (`getWorkflow`, `putWorkflow`) over the port `WorkflowResourceStore` (`src/workflow/workflow-resource.ts`; memory store and `PgWorkflowResourceStore`, migration `0071_frw_025_workflow_members.sql`), body check `checkWorkflowBody` (`packages/authority/src/workflow/workflow-body.ts`). Decisions in `docs/adr/0371-w4-FRW-025-workflow-put.md` (proposed). `services/document-service/test/control-plane/frw-025.workflow-resource.test.ts`, on memory and on PostgreSQL in Podman (both ran, 16 tests passed with `pnpm exec vitest run --project node`): criterion 1 (every member, the `ETag` `"1"` and a 304 on `If-None-Match`; `sentSeq`, `sentHash` and a participant's `state` and `completedSeq` once set, written to the store directly because `send` is not built; the JSON Schema `Workflow` is published in `spec/dep/dep-1.schema.json` and `spec/dep/dep-1.openapi.json`), criterion 2 (a second creation is 412 `precondition_failed`), criterion 3 (200 with the current `If-Match`, 412 with a stale one, 428 without, 409 `workflow_active` once the state is not `draft`), criterion 4 (the four kinds; every other value refused with its path; `packages/authority/test/frw-025.body.test.ts`), criterion 6 (discovery lists `workflow`; `relayCapabilities` drops it, `packages/authority/test/frw-025.body.test.ts` and `relay.test.ts`). `tests/security/test/sec-045-route-sweep.test.ts` now treats both routes as offered and seeds a workflow for tenant B.

**Evidence:** `packages/authority/src/workflow/resource.ts` (`checkParticipants`, `PARTICIPANT_KINDS`) refuses every kind other than `filler`, `signer`, `approver` and `cc`, with the position and member of each problem; `packages/authority/test/frw-025.resource.test.ts` (fast-check over every other string, case variants and role names, and over orders that are zero, fractional or beyond the safe integers). The equal and ascending order rule is tested in `packages/authority/test/frw-026.participants.test.ts` (order.ts) and `packages/authority/test/workflow.order.test.ts`. Lane FRW-014-026, 2026-11-13: decisions in `docs/adr/0248-lane-FRW-014-026.md` (proposed).

**Notes (lane w4, 2026-11-17):** Criteria 1 to 4 and 6 are ticked on the routes. Criterion 5 stays open: a caller without `manage` is refused `forbidden` on `PUT` (tested for `viewer` and `commenter`), but the actions `send`, `correct`, `resume`, `void` and `remind` do not exist (FRW-027 and after), so `or call an action` cannot be tested. Decided as proposed in ADR 0371, none of them the owner's: creation is a `PUT` with `If-Match: "0"`; the server-owned members are ignored when echoed; `timeZone` defaults to `UTC`; the lower bounds of the reminder and consent numbers are 1; `GET` uses the row `read.head`; a relay never announces `workflow` (`RELAY_EXCLUDED_FEATURES` gained it; 05 §2 names three features only). Criterion 4, unticked in audit because nothing called `checkParticipants`, is ticked again: the route validates through it. `sec-045-route-sweep.test.ts` (SEC lane) was changed to match the two new routes. The routing conditions are not checked against the document by the `PUT` (FRW-037 does it at send).

**Notes (lane V-FRW-019-036, 2026-11-14):** Criteria 2 and 3 are ticked on the store, not on an endpoint: no `GET` or `PUT` route is built, so the status codes and `If-Match` header handling are not tested. Criterion 1 stays open: the store holds `id`, `doc`, `state`, `rev`, `timeZone` and `participants` with the ETag `"rev"`, but not `sentSeq`, `sentHash`, `routing`, `deadline`, `reminders`, `consent` or `finalisation`, and the JSON Schema is not in `spec/`. Criterion 5 stays open: the store refuses `create` and the participant `replaceParticipants` without `manage` as `forbidden`, but the action `send` and the other actions are not built. Decision recorded here: the store is one row per document, so the criterion-2 rule is a primary key, not a check in code. `checkParticipants` is now called by product code (the store), which closes the audit objection under criterion 4 of FRW-026.

**Notes:** Lane FRW-014-026 (2026-11-13): criterion 4 ticked for the kinds and the order rule, which the checks in `resource.ts` and the existing order functions give. Criteria 1, 2, 3 and 5 stay open: they describe the `GET` and `PUT` (with `If-Match` and the ETag), the one-workflow-per-document check and the caller's `forbidden` as the endpoint answers them, and no endpoint or store exists. The published JSON Schema is not generated into `spec/`. Use of `workflow_active` for a `PUT` after send is inferred; 12 §10 names the code but not each use. Who may `GET` the workflow and what a participant sees of other participants are not stated, and 07 §12 has no rows for 12's resources (Open questions). The path form `/workflow/participants/{pid}/...` in 12 §10 is read as relative to `/documents/{id}`. Criterion 4 was unticked in audit (2026-11-13): `checkParticipants` and `PARTICIPANT_KINDS` in `resource.ts` are imported by no product code and only by tests, so nothing that accepts a participant enforces the four kinds (the same standard as FRW-027); re-tick when the workflow resource endpoint validates through it.

### FRW-026 Bind people to roles and order them

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Owner |

**Spec:** 12 §6.1; 13 §3; PRODUCT (host owns people) · **Requirements:** R13 · **Depends on:** FRW-001, FRW-025, UX-019

As an owner, I want to bind people to the roles of my document and put them in order, so that the right person fills and signs each part at the right time.

**Acceptance criteria**

- [ ] Given a draft workflow, when I add a participant with one or more roles, a kind, an order, a `sub` and a name, then it is saved in the workflow resource.
- [x] Given two participants with order `1` and one with order `2`, then the first two are parallel and the third is sequential after both (the behaviour itself is tested in FRW-031).
- [ ] Given a person bound to two roles, then both appear in their `roles` and both sets of fields are theirs; given a role bound to two participants, then either may fill that role's fields.
- [x] Given the workflow and participant schemas, then they hold no contact detail (no e-mail address or telephone number); only `sub` and `name` identify a person.
- [x] Given a role with no participant, then the pre-send checklist flags it (FRW-027).
- [ ] Given a host backend with a service credential, when it writes participants through the API, then the editor shows them without the owner re-entering them.

**Notes (lane V-FRW-019-036, 2026-11-14):** Criterion 4 stays open: the stored table `workflow_resource` (`services/document-service/migrations/0070_frw_025_workflow_resource.sql`) has no contact column, and `checkParticipants` refuses an `email` member, as `services/document-service/test/postgres/v-frw-019-036.workflow-resource.pg.test.ts` shows in PostgreSQL. The published participant JSON Schema of FRW-025 criterion 1 is still absent, so the criterion's "schemas" is not met as written. Criterion 1 stays open: `PgWorkflowResourceStore.replaceParticipants` writes a participant with `roles`, `kind`, `order`, `sub` and `name` through the product path, but the editor's add-participant action is not built.

**Evidence:** `packages/authority/test/frw-026.participants.test.ts` (criterion 2: two participants of order 1 are active together, the one of order 2 waits for both and is activated when they complete, through `activeParticipantIds` and `completeParticipant` in `packages/authority/src/workflow/order.ts`; a fast-check property over random orders and completions. Criterion 5: `sendChecklist` in `packages/authority/src/workflow/send.ts` reports `role_without_participant` with the role's identifier when no participant holds it, and reports nothing when two participants hold a role). Participant lists are checked by `packages/authority/src/workflow/resource.ts`, tested in `packages/authority/test/frw-025.resource.test.ts`, which refuses a contact detail as an unknown member. Lane FRW-014-026, 2026-11-13: decisions in `docs/adr/0248-lane-FRW-014-026.md` (proposed).

**Evidence (criterion 4, lane w4, 2026-11-17):** `services/document-service/test/control-plane/frw-026.no-contact-detail.test.ts` (`pnpm exec vitest run --project node <file>`, 6 passed and 1 skipped by design, on memory storage and on PostgreSQL in Podman): the published schema `Workflow` in `spec/dep/dep-1.schema.json` names exactly `id`, `roles`, `kind`, `order`, `sub`, `name`, `auth`, `state` and `completedSeq` for a participant, and no property anywhere in it names a way to reach a person (e-mail, phone, telephone, mobile, address, contact and the like, matched word by word); `PUT /documents/{id}/workflow` refuses `email`, `phone`, `telephone`, `mobile`, `contact` and `address` on a participant, and a contact member of the workflow, with 400 and stores nothing; a participant with `sub` and `name` is stored and read back; and the columns of the `workflow%` tables in PostgreSQL include none that names a contact.

**Notes (lane w4, 2026-11-17):** Criterion 4 is ticked (see its Evidence). Criteria 1, 3, 5 and 6 stay unticked, each for what is not built, not for a missing test. Criterion 1 and criterion 6: the service stores and returns participants with `roles`, `kind`, `order`, `sub` and `name` through `PUT` and `GET /documents/{id}/workflow` (FRW-025, `frw-025.workflow-resource.test.ts`), but the editor has no participants view and its backend (`packages/backend-dep`) has no client for the `workflow` port of `packages/protocol` (only the mock's port types exist; `packages/backend-dep/src` has none for grants or workflow either), so "I add a participant" and "the editor shows them" cannot be shown end to end; a pane over a mock port would not meet them. Criterion 3: the roles of a bound participant reach `access.fill.roles` through the token binding of FRW-038 (`bindParticipant` in `packages/authority/src/workflow/binding.ts` is pure and not yet used by the data plane, `services/document-service/src/data-plane` records `wfp` only), so a test of "both sets of fields are theirs" would only compose the two pure functions itself. Criterion 5: `sendChecklist` is still not called by the service (FRW-027), as the audit note below says. Re-tick 3, 5 and 6 with FRW-038, FRW-027 and the backend client; 1 with the editor's participants view.

**Notes:** External participants are not in the host's user base. How the editor learns their `sub` (a host callback or the host writing the workflow through the API) is not specified (Open questions). Lane FRW-014-026 (2026-11-13): criteria 2 and 5 ticked on the pure functions above; the behaviour of activation as events and the `wf.changed` push are FRW-031 and FRW-035. Criterion 1 stays open: there is no add-participant endpoint, and the workflow record of `lifecycle.ts` does not yet store `name` or `auth`. Criterion 3 stays open: the roles of a person and the fields they fill come from the permission model (`packages/authority/src/permissions/`) through the token binding (FRW-038), which is not wired to participants here; the two-holder case is tested only for the checklist. Criterion 4 stays open: the published participant schema (FRW-025 criterion 1) does not exist; the refusal of contact members is in `resource.ts`. Criterion 6 stays open: the service credential and its API writes are not built. Criterion 5 was unticked in audit (2026-11-13): it rests on `sendChecklist` in `send.ts`, which no product code calls (only `problems.ts`, itself unexported and unused, and tests), and the same behaviour was unticked under FRW-027 criterion 1 for that reason; re-tick together with FRW-027 when the checklist runs through the service. Lane w4 (2026-11-17): re-ticked. `POST /documents/{id}/workflow/send` runs `sendChecklist` and answers a role with no participant as a violation `/roles/<role>` (`services/document-service/test/control-plane/frw-027.send-route.test.ts`, "lists every failure ...", memory and PostgreSQL).

### FRW-027 Send a document for completion

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Owner |

**Spec:** 12 §6.2 (`send`), §10; 08 §4; 07 §12 · **Requirements:** R13, R3, R4 · **Depends on:** FRW-021, FRW-025, FRW-026, FRW-030, PRM-056

As an owner, I want to send the document, so that its body is frozen and the first participants are asked to act.

**Acceptance criteria**

- [x] Given a draft workflow and a caller with `manage`, when the action `send` is called, then a checklist runs: every required field has an assignee; every role has a participant; the rules validate; there are no unresolved suggestions.
- [x] Given any check fails, then the send is refused with a problem that lists each failure (field keys, role identifiers, suggestion identifiers) and the state stays `draft`; the unresolved-suggestions failure uses the `pending_suggestions` code of the registry.
- [x] Given all checks pass, then the service records `sentSeq` and the chain hash as `sentHash`, sets the document state to `locked`, activates the participants with the lowest `order`, moves the workflow to `sent` and creates a `sent` version at `sentSeq`.
- [ ] Given the send succeeds, then the webhooks `dep.workflow.sent` and one `participant_activated` per activated participant are raised, and each connected client receives `wf.changed`.
- [x] Given the same `send` request is repeated with the same `Idempotency-Key`, then the document is sent once; given a send when the state is not `draft`, then it is refused and nothing changes.
- [x] Given a caller without `manage`, then the request is rejected with `forbidden`.

**Evidence:** `packages/authority/test/workflow.send.test.ts` (criteria 1, 2 and 6 through `sendChecklist` and `sendWorkflow` in `packages/authority/src/workflow/send.ts`: the four checks, every failure listed, `pending_suggestions` for an unresolved mark, the draft unchanged on refusal, `forbidden` without `manage`; the refusal of a send from any state other than `draft`, property tests). Lane w4 (2026-11-17), criteria 1, 2, 3, 5 and 6 through the service: `sendWorkflow` in `services/document-service/src/control-plane/workflow-routes.ts` answers `POST /documents/{id}/workflow/send` (an operation `sendWorkflow` of `packages/protocol/src/definition/frw.ts`, in the manage row of the permission matrix). `services/document-service/test/control-plane/frw-027.send-route.test.ts` (vitest, Node.js 22.18, 8 tests: 4 on memory and 4 on PostgreSQL from the test environment in Podman, against the real data plane with an owner connected): an editor gets `forbidden` and nothing changes; a document with an unassigned required field, a role without a participant, an unresolved suggestion and an invalid rule is refused `validation_failed` with a violation for each (`/fields/<key>`, `/roles/<id>`, `/suggestions/<id>`, the rule's path) and stays `draft`, unlocked, with no control commit and no event; an unresolved suggestion alone is `pending_suggestions` (409); a good document is sent: `sentSeq` is the head before the send, `sentHash` is `sha256:` and the chain head, the document is `locked` with `workflowActive`, participant `p1` (order 1) is `active` and `p2` `pending`, one control commit follows `sentSeq`, a `sent` version exists at `sentSeq`, and `dep.workflow.sent.v1` and one `dep.workflow.participant_activated.v1` (for `p1`) were raised with the control commit's `seq` and the chain head; the same `Idempotency-Key` returns the stored response and adds no commit, version or event; a second send with another key when the state is `sent` is `conflict` and changes nothing. The recorder behind it is FRW-030.

**Notes:** The `sent` version kind is from 08 §4. Lane FRW-027-039, 2026-11-13: criteria 1, 2 and 6 are met by the pure functions, not by an endpoint; the endpoint is the service's. Criterion 3 stays open: `sendWorkflow` sets `sentSeq`, `sentHash` and `sent` and activates the lowest order (`order.ts`), but the lock (FRW-029), the `sent` version and the control commit are not built. Criterion 4 stays open: the webhooks and `wf.changed` are not raised (FRW-035, FRW-036). Criterion 5 stays open: the idempotency key is the service's; only the refusal of a send that is not `draft` is tested. Decisions are in `docs/adr/0249-lane-FRW-027-039.md` (proposed). The "rules validate" check is the validation of FRW-015 and FRW-019 over all rules. Criteria 1, 2 and 6 were unticked in review (2026-11-13): they describe the `send` action and its refusal as the service answers them, and no endpoint exists; `send.ts` is not exported from `packages/authority/src/index.ts` and only its tests import it. The problem codes `required_field_unassigned`, `role_without_participant` and `rules_invalid` are not in the registry. The same standard was applied to FRW-047 (`completion.ts`, no tick without the endpoint). Re-tick when the action runs through the service. Lane w4 (2026-11-17): criteria 1, 2, 3, 5 and 6 are ticked, because the action now runs through the service (see Evidence). Criterion 4 stays unticked for its second half: the webhooks `dep.workflow.sent` and `participant_activated` are raised (tested), but no client receives `wf.changed`, which the data plane does not send (FRW-035; no `wf.changed` in `services/document-service/src/data-plane`). Decisions are in docs/adr/0383-w4-FRW-027-send-route.md and docs/adr/0382-w4-FRW-030-transition-record.md (proposed): method and path (12 §10 and G95 leave them open; 12 §10 now names `/workflow/send` as an assumed `POST`), `conflict` for a send from a state other than `draft`, a participant's `state` is `active` or `pending`, and the content hash that stands for the chain head of a document with no commit yet. Open: `sentSeq` is read before the lock is stored, so a content commit that the room accepts in between lies between `sentSeq` and the control commit (ADR 0383 point 4). Earlier note, Fixer E group 3 (2026-11-13): the refusals are now mapped to registry codes in `packages/authority/src/workflow/problems.ts` (`sendProblem`, `transitionProblem`; ADR 0249 decision 10, proposed), tested against `spec/dep/dep-1.registry.json` in `packages/authority/test/workflow.problems.test.ts`. Criteria 1, 2 and 6 stay unticked: no workflow service or route exists in the repository, and the three modules are not yet exported from `packages/authority/src/index.ts` (left to the main session).

### FRW-028 Run the pre-send checklist in the editor

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Author |

**Spec:** 12 §6.2, §11 · **Requirements:** R13, R11 · **Depends on:** FRW-027, FRW-073, FRW-074

As an author, I want to see the pre-send checklist before I send, with a way to each problem, so that I fix what blocks the send instead of discovering it from an error.

**Acceptance criteria**

- [x] Given I open "send for completion" with `manage`, then the editor lists the four checks, each marked passed or failed in words and with an icon, not by colour alone.
- [x] Given a failed check, when I activate its link, then the editor moves focus to the field, opens the roles manager or the participants view, or goes to the suggestion concerned.
- [x] Given all checks pass, then the send control is enabled and asks for confirmation; given I confirm, then the editor shows the locked state and the workflow status when the send succeeds.
- [x] Given the server refuses a send that the client thought valid, then the list is updated to the server's verdict.
- [x] Given the result of the checks changes, then a live region announces it; the dialog is operable from the keyboard and uses external strings.
- [x] Given a user without `manage`, then the control is absent or disabled with a stated reason.

**Evidence (lane w4, 2026-11-18, all six criteria):** The dialog is `packages/ui/src/components/SendDialog.svelte` (rows from `packages/ui/src/shell/send-checklist.ts`), opened by the command `workflow.send` ("Send for completion"; `packages/ui/src/commands/builtin.ts`, `App.svelte`; parity row `fields-and-forms`, regenerated into `spec/parity/` and `spec/embedding/`). Its port is `WorkflowSendService` of `CoreApi` (`packages/ui/src/core-api.ts`); the element builds it over the core and the backend's `workflow` port (`packages/element/src/workflow-send.ts`, wired in `editor.ts` and `doc-editor.ts` only when the backend has the port), and the core gained `sendChecklist` (the authority's checklist over the document the reader holds) and `selectSuggestion` (`packages/engine/src/core.ts`). Browser, Playwright in Chromium, Firefox and WebKit, 14 tests each, all passed (`DOCEDIT_UI_PORT=57628 DOCEDIT_BROWSERS=chromium,firefox,webkit pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-028-send-dialog.spec.ts --retries=0`, Windows 11, 2026-11-18): `packages/ui/e2e/frw-028-send-dialog.spec.ts` with a stand-in service (`e2e/harness/frw-028-send-port.ts`). Criterion 1: four rows in order, each with the word Passed or Failed and an icon (`svg[data-icon]`, hidden from assistive technology), the count of problems; with `manage` only. Criterion 2: a failed field, suggestion, role and rules check each has a link; the field and suggestion links close the dialog and ask the service to move there, the role link opens the roles pane and the rules link the rules pane. Criterion 3: Send is off while a check fails (with its reason as the button's description), on when all pass; the first press asks for confirmation (nothing sent), Go back cancels, Confirm and send sends once, and the dialog then says the document is locked and shows "Workflow status: sent". Criterion 4: a server refusal replaces the list with the server's failures, and says so in an alert. Criterion 5: a live region inside the dialog says "4 checks failed.", "1 check failed.", and "All checks passed." when the number changes and says nothing new when it does not; Tab, Enter and Escape work; an override of `dialog.send.title` and `send.check.roles` shows (external strings); axe finds nothing with failures, with all passed and once sent (Chromium and WebKit; in Firefox the last run, over the sent state, is skipped as in FRW-024). Criterion 6: without `manage` Send is disabled with "You need the right to manage this document to send it."; a workflow already sent and one not yet read give their own reasons. In Node.js (`pnpm exec vitest run --project node <paths>`): `packages/engine/test/frw-028.send-checks.test.ts` (the four checks over the core, with the roles held, a required field without an assignee, an unresolved suggestion; `selectSuggestion` selects the marked text), `packages/element/test/frw-028-workflow-send.test.ts` (state and participants read from the port, the failures follow them, send, the server's refusals read from the problem's violations: `validation_failed`, `pending_suggestions`, `forbidden`, `conflict`), `packages/ui/test/frw-028.violations.test.ts` and the earlier `packages/ui/test/frw-028.send-checklist.test.ts`.

**Notes (lane V-FRW-019-036, 2026-11-14):** The checklist model is built and tested in Node.js: `packages/ui/src/shell/send-checklist.ts` (`checklistRows`, `sendControl`, `serverVerdictRows`, `checklistAnnouncement`), `packages/ui/test/frw-028.send-checklist.test.ts` (11 tests, `pnpm vitest run` on the file). It gives the four rows with a passed or failed word and icon, the link target of a failed row, the send control with its reason, the server's verdict and the announcement. Criteria 1 to 6 stay open as stories: no dialog component renders these rows, no keyboard or axe run was made, and the send action is not wired to the authority's `sendChecklist` (FRW-027). The link of a failed role check goes to the participants view and of a failed rules check to the rules panel: a spec default, not stated in 12 §6.2 (decided here, not by the owner).

**Notes (lane w4, 2026-11-18):** All six criteria are ticked on the dialog and the element's service, which run against a stand-in `workflow` port and in the browser against a stand-in service. Not built, so not shown end to end: `packages/backend-dep` has no client for the `workflow` port (as FRW-026 says), so no shipped backend gives the element a port and the command appears only with a backend that has one; the violation paths the service reads (`/fields/<key>`, `/roles/<id>`, `/suggestions/<id>`, a rule's path) are those `POST /documents/{id}/workflow/send` writes (`services/document-service/src/control-plane/workflow-routes.ts`), but no test joins the two. The lock the dialog speaks of after a send is the server's (FRW-029 shows it in the editor); `wf.changed` is not read, so the state is read again each time the dialog opens. Decisions, none the owner's: a failed role check links to the roles pane because no participants view exists (FRW-026); the rules link opens the rules pane; the link of a failed field, role or suggestion goes to the first named item of that link; the server's `conflict` and `workflow_active` both mean "no longer a draft"; a document with no workflow resource (404 `not_found`) is read as a draft with no participants; asking for the `workflow` feature in `backend-source.ts` was left out because the DEP client has no workflow port. `core.sendChecklist` gives every participant the kind `filler` and order 1, as the checks look at roles only. The story's other changes of the lane: `packages/ui/package.json` gained the subpath `./send-checklist` (like `./fill`) so the element can read the violations without loading the shell.


### FRW-029 Lock the document while a workflow runs

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Owner |

**Spec:** 12 §3.3, §4.3, §6.2; 07 §4; 08 §8; review §3.7 · **Requirements:** R13, R3 · **Depends on:** FRW-008, FRW-009, FRW-027, HIS-018, HIS-019

As an owner, I want the document locked while participants fill and sign, so that nothing under their signatures changes except values they are meant to set.

**Acceptance criteria**

- [x] Given a workflow in `sent` or `in_progress`, when anyone, an owner included, submits a commit that is not a fill allowed by P7 or a server-authored value allowed by P8, then it is rejected: with `read_only` where the document state forbids it, and with `permission_denied` for an out-of-scope change by a participant.
- [x] Given a user with `edit` who could change a field's attributes in draft, when the workflow is `sent` or `in_progress`, then that right is gone and the field's attributes cannot be changed.
- [x] Given a commenter or participant, when they create a thread or reply while the workflow is `sent` or `in_progress`, then it is allowed, because commenting never changes the document.
- [x] Given a whole-document restore requested while a workflow is active, then it is refused with `workflow_active`.
- [x] Given a workflow that ends `declined` or `voided`, then the document stays locked, and the document is reused only by forking it.
- [x] Given the lock, then the editor shows the locked state and who may still act, and explains a refused change instead of dropping it.

**Evidence:** `packages/authority/test/frw-029.workflow-lock.test.ts` (criterion 2: the `perm.changed` access of an owner and an editor under the lock has no `edit` and no `structure`, and an editor's attribute change is refused and stored nowhere; the lock mapping of `packages/authority/src/workflow/lock.ts` is tested in the same file). Lane V-FRW-019-036, Node.js (`pnpm exec vitest run`): criterion 3 in `packages/authority/test/frw-029.lock-comments.test.ts` (a commenter creates a thread and replies and resolves it under the lock from `lockFor('sent')` and `lockFor('in_progress')`; a view-only user cannot reply).

**Evidence (lane w4, 2026-11-18, criteria 1, 4 and 6):** Criterion 1, `packages/authority/test/frw-029.lock-commits.test.ts` (Node.js, `pnpm exec vitest run --project node <file>`, 7 tests): a fast-check property over the state (`sent`, `in_progress`), every user of the fixtures (owner, editors, suggester, participant, viewer) and six kinds of change (text, a field attribute, a value in the tenant's field, in the landlord's field, in a field no role may fill, a client-written signature) on the room the service runs under the lock `lockFor` gives: only the active participant's fill of a field of their role (P7) is accepted; every other pair is refused with nothing stored, `read_only` where the state is what forbids it (step 1 for a user with no `fill`, the outcome check for one who could make the change on an active document) and `permission_denied` where no state would allow it (a participant outside their fields, a client-written signature, P8); the owner is refused `read_only` for text, an attribute and a value; a server-authored commit (`room.author`) with origin `sign` for a signature and `rules` for a formula value is accepted (P8), and one with another origin that changes text or a server kind is refused. The same over HTTP and the data plane: `services/document-service/test/control-plane/frw-029.lock-routes.test.ts` (memory and PostgreSQL in Podman, both ran, 6 tests passed): after `POST /documents/{id}/workflow/send` the owner's text commit over the WebSocket is a `sync.reject` with `read_only` and the head does not move. Criterion 4, the same file: `POST /documents/{id}/restore` of the whole document is 409 `workflow_active` and neither the head nor the versions change, and so is `PUT /documents/{id}/content`; the room's own refusal of a restore commit stays `conflict` (`frw-003.restore.test.ts`), which the REST layer never reaches because it refuses first. Criterion 6: the shell's banner `packages/ui/src/components/WorkflowBanner.svelte` (model `packages/ui/src/shell/workflow-lock.ts`) names the lock and, while the workflow runs, who may act now (the participants in state `active`, by name, else role); a read-only refusal and a `read_only` rejection are explained in the workflow's words (`NoticeTracker`, `notice.refused.workflow`, `notice.rejected.workflow`). Browser, Playwright in Chromium, Firefox and WebKit, 5 tests each, all passed with axe (`DOCEDIT_UI_PORT=57629 DOCEDIT_BROWSERS=chromium,firefox,webkit pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-029-lock-banner.spec.ts --retries=0`, Windows 11, 2026-11-18): the banner for a running workflow with "May act now: Ada Lovelace.", for a declined and a voided one ("The document stays locked."), its appearance and disappearance with the state, its absence without a workflow port, and the refusal notice in the workflow's words (and in the general ones when nothing locks). Node.js: `packages/ui/test/frw-029.workflow-lock.test.ts`, `packages/element/test/frw-028-workflow-send.test.ts` (the service reads the workflow at start and on `wf.changed`, tells its listeners once per real change, stops on `dispose`).

**Notes:** Review §3.7: comments stay available during a workflow; whether to switch them off is FRW-085. The definition of "active" (is `correcting` active? are `completed`, `finalised` and `expired` terminal and locked?) is not given (Open questions). Which of `read_only` and `permission_denied` applies to an owner's commit follows 04 §5 step 1; confirm in the property test. Lane FRW-027-039, 2026-11-13: criterion 1 stays open. Room step 1 (`packages/authority/src/room/room.ts`) admits a connection whose `fill.allowed` is true, and the owner and editor roles carry `fill` (`permissions/model.ts`), so an owner's or an editor's text change under the lock is refused with `permission_denied`, not `read_only` as 12 §3.3 names it (`frw-029.workflow-lock.test.ts` pins the refusal and the stored state, not the code). Only a viewer gets `read_only`. Fixing step 1 is the authority's (SYN, PRM). Lane w4 (2026-11-15, SYN-007): the room now answers `read_only` to an owner's or an editor's change under the lock and keeps `permission_denied` for a participant's out-of-scope change (ADR 0363, proposed; `syn-007-workflow-lock.test.ts`, and this story's test now pins the code). Criterion 1 is not ticked by that lane: the property test this note asks for and the P8 case are not covered there. Criterion 3: thread creation on a locked document under a workflow lock is tested in `packages/authority/test/threads.test.ts` ("works on a locked document ..."), but a reply under the lock is not tested by this lane. Criterion 4 stays open: the room already refuses a whole-document restore while `perms.workflowActive` is set (`packages/authority/src/room/room.ts`, step 1 of the restore check), but with `conflict`, not `workflow_active` (12 §10 names that code for the REST surface). Changing the code means editing three other lanes' tests (`frw-003.restore.test.ts`, `leases-states.test.ts`, `room-commits.test.ts`), so it is left to the main session (Lane U-FRW-019-036, 2026-11-13). Criterion 5 stays open: `lockFor` (`workflow/lock.ts`) holds `declined` and `voided` locked, and the room refuses fill for them (`frw-029.workflow-lock.test.ts`), but the second half, that the document is reused only by forking, is FRW-033 criterion 5 (fork endpoint, not built). `lockFor` returns null for `correcting`, `completed`, `finalised` and `expired`, because 12 does not decide them (ADR 0249, proposed). Criterion 6 is the editor's, not this lane's.

**Evidence (criterion 5, lane w4, 2026-11-18, with FRW-033):** `services/document-service/test/control-plane/frw-033.decline-void.test.ts`, "leaves a voided document locked and reusable only by a fork" and the same for a declined one (memory and PostgreSQL in Podman, both ran): after the workflow is stopped the document is `locked`, the owner's text commit is refused `read_only`, a restore and a replacement of the content are 409, and the host forks the document with its service credential into a draft with no workflow (a user may not fork). The room's refusals for a stopped workflow are in `packages/authority/test/syn-007-workflow-lock.test.ts` and `frw-029.workflow-lock.test.ts`; the banner of the lock for a declined or voided workflow is in `packages/ui/e2e/frw-029-lock-banner.spec.ts`. The component's `de-fork-request` is not part of this criterion's text; it is FRW-033 criterion 5.

**Notes (lane w4, 2026-11-18):** Criteria 1, 4 and 6 are ticked. Criterion 5 was left unticked in the first commit of this story because nothing set a workflow to `declined` or `voided` through the service; FRW-033 did, and it is ticked there (see its Evidence). Criterion 1: the Notes above ask for a property test and the P8 case; both are in `frw-029.lock-commits.test.ts`. Whether a user with no `fill` is refused `read_only` by step 1 and not by the outcome check is the room's (04 §5 step 1), and the property pins the code as the oracle `read_only` for such a user and for a change the same user could make on an active document. The lock covers `sent` and `in_progress`; `correcting`, `completed`, `finalised` and `expired` are not decided (ADR 0249) and show no banner. Criterion 4: the REST answer is `workflow_active` as 12 §10 names it; the room's own answer to a restore commit while a workflow is active stays `conflict` (the room is the second line, behind the REST layer and `room-host.ts` which refuse with `workflow_active` first); no test of this story changes that. Criterion 6 is shown with the stand-in service in the browser and with a stand-in port in the element's test; no shipped backend has a `workflow` port yet, so the banner appears only with one (FRW-028 Notes). The banner names the participants in state `active`; whether a person waiting for an earlier order should also be named is not specified.


### FRW-030 Record workflow transitions as control commits

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** 12 §6.2 (last paragraph); 04 §3.2, §10; 08 §2, §12; 07 §14 · **Requirements:** R13, R4 · **Depends on:** FRW-025, SYN-004, HIS-002, HIS-033

As a maintainer, I want every workflow transition written to the commit log as a control commit, so that the order of fills, signatures, corrections and completion is part of the hash chain and provable.

**Acceptance criteria**

- [ ] Given each transition (send, first open, correct, resume, a participant's completion, decline, void, expiry, completed, finalised), when it happens, then a control commit with no steps is appended to the log in the same total order as content commits, and clients advance their `seq` on receiving it.
- [ ] Given a run in which a field is filled, a signature is written and a correction happens, when the log is read, then the relative order of those events is recoverable and the hash chain verifies across them.
- [ ] Given a transition and the log write are one logical action, when the process stops between the workflow table update and the log write, then the outcome is atomic: after recovery the state and the log agree, and the commit is applied exactly once (deterministic identifier).
- [x] Given each transition, then it is also written to the audit trail with actor, document and server time.
- [x] Given a webhook for a transition, then its data carries the `seq` of the control commit and the chain head.

**Evidence:** Lane w4 (2026-11-17), criterion 4: `recordTransition` (`services/document-service/src/workflow/transitions.ts`) is the one path of a transition. It stores the lock of the new state through the grant store (whose audit entry `grants.changed` is written in the revision's transaction), tells the room, moves the workflow row in one conditional write (`WorkflowResourceStore.transition`, memory and `workflow-resource-pg.ts`), and writes a `workflow.transition` audit entry with the actor, the document, the server time and `{ from, to, rev }`. `services/document-service/test/control-plane/frw-030.transition-record.test.ts` (vitest, Node.js 22.18, 8 tests: 4 on memory and 4 on PostgreSQL from the test environment in Podman) runs it against the real data plane with a connected room for three transitions (`sent`, `in_progress`, `voided`) and reads the audit entries back in order; the room's control commit has no steps, follows the head, and carries the grants revision. Criterion 5: `frw-027.send-route.test.ts` (the `dep.workflow.sent.v1` event carries the control commit's `seq` and the chain head).

**Notes:** Plumbing is SYN's and HIS's; this story asserts the workflow's side. Lane V-FRW-019-036, 2026-11-13 (Node.js): `packages/authority/test/frw-030.transition-order.test.ts` shows that a lock change (`lockFor('sent')`, then `lockFor('declined')`) is written as a control commit with no steps (`room.ts` `ensureControlCommit`), in one contiguous seq order with a fill. Criterion 1 stays unticked: the other transitions (first open, correct, resume, participant completion, void, expiry, completed, finalised) have no writer, because the workflow service that would record them is not built, and `completed` and `finalised` have no lock to write. Criteria 2 to 5 stay open: no signature, no correction, no audit event for a transition (the audit writer exists only for grants, `grant-store.ts`), no webhook seq, and no crash-atomic write of a workflow row with its log commit. Those need the workflow table and service, which are not in the repository. Lane w4 (2026-11-17): the workflow table (`workflow_resource`) and the recorder now exist; criterion 4 is ticked (see Evidence). Criterion 1 stays unticked: only `send` has a route (FRW-027); first open, correct, resume, a participant's completion, decline, void, expiry, completed and finalised have no caller of `recordTransition`, and `completed`, `finalised`, `correcting` and `expired` have no lock that `lockFor` decides. Criterion 2 stays unticked: no signature and no correction is written yet. Criterion 3 stays unticked: the lock and the state are two writes in two stores, made safe by repeating the request (tested with a stop between them), not one transaction; docs/adr/0382-w4-FRW-030-transition-record.md (proposed) records this. Criterion 5 was ticked in the commit of FRW-027, which raises the webhook: the recorder returns the control commit's `seq` and the chain head when a room is open, and `frw-027.send-route.test.ts` shows `dep.workflow.sent.v1` carrying that `seq` (equal to the stored control commit's) and a 64-character chain head. A document with no room open gets its control commit when a room next opens; the webhook then carries `sentSeq` and the chain head at the send (docs/adr/0382, point 5), so the criterion holds for a document whose room is open.

### FRW-031 Activate participants in order

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Participant |

**Spec:** 12 §6.1, §6.2 · **Requirements:** R13 · **Depends on:** FRW-026, FRW-027, FRW-030, FRW-035

As a participant, I want to be asked to act only when it is my turn, so that I never fill or sign before the people ahead of me.

**Acceptance criteria**

- [x] Given participants with order `1` and `2`, when the workflow is sent, then only the order `1` participant is active; the order `2` participant can open the document but has `access.fill.active` false and cannot fill.
- [ ] Given every participant of the lowest incomplete order has completed, then the participants with the next order are activated together, `participant_activated` is raised for each, and each receives `wf.changed`.
- [x] Given two participants with the same order, then both are active at once and either may complete first.
- [ ] Given the first participant opens the document while the workflow is `sent`, then the workflow moves to `in_progress`, a first-viewed time is recorded and `participant_viewed` is raised.
- [ ] Given a participant of kind `approver`, then completing means approving without fields; given kind `cc`, then the participant receives the result and is never active for filling.
- [x] Given the last participant who must act completes, then the workflow moves to `completed`.

**Evidence:** `packages/authority/test/frw-031.activation-room.test.ts` (vitest, Node.js 22.18, 4 tests; lane V-FRW-019-036, 2026-11-14): criterion 1 through the room: the workflow is sent by `sendWorkflow`, the document lock comes from `lockFor` and `participantActive` from `fillActive`; the order 1 participant's open shows `access.fill.active` true and its fill is accepted; the order 2 participant's open succeeds with `fill.active` false and its fill is refused (`permission_denied`, no write). The same file covers criterion 2 (state part: after the order 1 completion only order 2 may fill) and the fill part of criterion 3 (two same-order participants fill at once). `packages/authority/test/workflow.order.test.ts` (criteria 3 and 6 through `activeParticipantIds` and `completeParticipant` in `packages/authority/src/workflow/order.ts`: two same-order participants active together and either completes first; the workflow completes when the last must-act participant completes, with a `cc` participant not blocking it; property tests over random participant lists).

**Evidence (lane w4, 2026-11-17):** `services/document-service/test/control-plane/frw-031.progress.test.ts` (vitest, Node.js 22.18; memory storage, and PostgreSQL in Podman when the test environment is up; 3 tests for each): `recordCompletion` in `services/document-service/src/workflow/progress.ts` runs through `recordTransition` against the real data plane with a connected room. Criterion 3: the two order 2 participants are both marked `active` when order 1 completes, the approver completes first, the other completes after, and neither is refused. Criterion 6: the last completion moves the stored workflow to `completed`, the document is locked with `workflowActive` false, and the open channel received `wf.changed` for `sent`, `in_progress` and `completed` in order; a `cc` participant and a second completion are refused. Also covered, not ticked: first view stored once with `participant_viewed` returned (criterion 4), the events returned for the next order (criterion 2). Code: `progress.ts`, `record.ts`, `transitions.ts` (`workflowChanged` push), `packages/authority/src/workflow/lock.ts` (`completed` lock). Decisions: `docs/adr/0384-w4-FRW-031-progression.md` (proposed).

**Notes:** Lane FRW-027-039, 2026-11-13: criterion 1 stays open because the reading right to open the document is the room's (PRM) and only the derived fill flag is tested here (`fillActive`, which the order and the send test pin). Criterion 2 stays open: `completeParticipant` returns the newly active participants, but `participant_activated` and `wf.changed` are not raised (FRW-035, FRW-036). Criterion 4 stays open: the first-viewed time and `participant_viewed` are not built. Criterion 5 stays open for the approver part: the approver's completion without fields is FRW-047's. The state part of 3 and 6 is pure and tested; the service that stores completions is not built. The `cc` reading is decided in `docs/adr/0249-lane-FRW-027-039.md` (proposed). Whether and the approver's decline are counted in "last participant" is not stated; the criterion reads it as the participants who must act (Open questions). Criteria 3 and 6 were unticked in review (2026-11-13): nothing stores a completion or serves a participant's access, `order.ts` is not exported from `packages/authority/src/index.ts` and only its tests import it, and the same standard was applied to FRW-047. Lane V-FRW-019-036, 2026-11-14: criterion 1 is ticked on the room's evidence above (the room's open and fill checks, with the order and the lock derived by the pure functions). Criterion 1's "can open the document" is tested as the room's `ch.opened` only; the reading right itself is PRM's. Criteria 2 (the `participant_activated` event and `wf.changed`, FRW-035 and FRW-036), 3 (either participant completes first, which needs a stored completion) and 4 (first-viewed time) stay open. Criterion 6 is unchanged: no service stores the completion. The participant record here (`completed: boolean`) differs from the resource of 12 §6.1 (`state`, `completedSeq`); a mapping is needed. Lane w4, 2026-11-17: criteria 3 and 6 ticked on the service evidence above. Criterion 2 stays open: `recordCompletion` returns `participant_completed`, one `participant_activated` for each participant of the next order and `completed`, and the open channel gets `wf.changed`, but nothing raises the webhooks, because the route that completes a participant is FRW-047 (the send route raises its events itself) and participants' own channels are not tested (the token's `wfp` claim is not yet mapped to the connection's participant, ADR 0384 point 6). Criterion 4 stays open: `recordFirstView` stores `firstViewedAt` once, moves `sent` to `in_progress` and returns `participant_viewed` (tested), but nothing calls it when a channel opens. Criterion 5 stays open: the approver completes with no field check in `recordCompletion` and a `cc` participant is never active (tested), but the approve action itself and its checks are FRW-047's criterion 7. Decision for the owner, proposed: the lock of `completed` (locked, no fill; ADR 0384 point 1), which `lockFor` left undecided before.

### FRW-032 Correct a document in progress and resume

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Owner |

**Spec:** 12 §6.2 (`correct`, `resume`), §14; 02 §2.2 · **Requirements:** R13, R4 · **Depends on:** FRW-029, FRW-030, FRW-035, FE-008, FE-010

As an owner, I want to correct a document that is in progress and then resume, so that a mistake can be fixed without silently changing what people already signed.

**Acceptance criteria**

- [x] Given a workflow `in_progress` and a caller with `manage`, when the action `correct` is called, then the state becomes `correcting`, every participant is paused, a control commit is written and `corrected` is raised.
- [ ] Given a paused participant, when they submit a commit, then it is rejected with `read_only`, and the values they had not yet sent are placed in the recovered-edits pane instead of being lost.
- [x] Given `correcting`, then an owner with `edit` can change the body and the fields.
- [x] Given the action `resume` and a caller with `manage`, then the service compares the document at the head with the document at `sentSeq`; if the body changed, every completed participant is reset and must complete again; if only the fields of a completed participant changed, that participant is reset.
- [x] Given nothing relevant changed, when `resume` is called, then no participant is reset and the workflow returns to `in_progress`.
- [x] Given a reset participant, then the service never leaves a signature in place over a body it did not sign: the body is never changed silently under a signature.
- [x] Given a caller without `manage`, then `correct` and `resume` are rejected with `forbidden`.

**Evidence (lane w4, 2026-11-18, criteria 1 and 3 to 7):** The routes are `POST /documents/{id}/workflow/correct` and `/resume` (`packages/protocol/src/definition/frw.ts`: operations `correctWorkflow` and `resumeWorkflow`, `manage`, idempotent; `services/document-service/src/control-plane/workflow-routes.ts`), over `recordCorrection` and `recordResume` (`services/document-service/src/workflow/correction.ts`), which go through `recordTransition` (FRW-030). The authority gained the lock of `correcting` (`workflow/lock.ts`), `snapshotOf` and `fieldOwnersOf` (`workflow/snapshot.ts`), owners as lists in `resumeWorkflow` and the paused refusal in the room (`room/room.ts`). Decisions: `docs/adr/0385-w4-FRW-032-correct-and-resume.md` (proposed). Service, `pnpm exec vitest run --project node services/document-service/test/control-plane/frw-032.correct-resume.test.ts` (memory and PostgreSQL in Podman, both ran, 10 tests passed), a workflow sent by the route and progressed with `recordFirstView` and `recordCompletion`, with an owner connected: a caller without `manage` gets `forbidden` from both actions and a state that does not fit gets `conflict` (criterion 7); `correct` makes the state `correcting`, marks the participants who had not completed `paused` and leaves the completed ones `completed`, stores the lock `active` and `workflowActive` false, writes one control commit, raises `corrected` once, and answers a repeated `Idempotency-Key` from the stored response (criterion 1); the owner then changes the body text and a field value over the wire and both are acknowledged (criterion 3); `resume` with nothing changed leaves everybody as they were, returns to `in_progress`, locks the document again with one more control commit and raises `participant_activated` for the participant who is active again (criterion 5); a changed value of one participant's field resets that participant only, who loses `completedSeq` and is active again while the other completed participant keeps the completion (criterion 4); a changed body resets every completed participant, and the owner's next change is refused `read_only` (criteria 4 and 6). Authority, `packages/authority/test/frw-032.snapshot.test.ts` (12 tests: the snapshot keeps values out of the body; the owners of a field are the holders of its role; the reset for a value, a body, a field with no owner and two holders of a role; a property that nobody stands over a body or a value they did not sign) and `packages/authority/test/workflow.correction.test.ts` (the state parts, earlier); `packages/authority/test/frw-032.correct-room.test.ts` (criterion 3 in the room: an owner's change of text, of a field attribute and of a field value is accepted while `correcting` and refused `read_only` once the workflow is in progress again).

**Notes:** Pitfall (12 §14): an author correcting while someone fills. The reading of "those participants" in 12 §6.2 (every completed participant for a body change, the participant concerned for a field change) is mine; confirm it. What happens to a reset participant's earlier signature values and evidence is not stated (Open questions). That `correcting` allows editing is implied by its purpose, not written. Lane FRW-027-039, 2026-11-13 (round 3): `packages/authority/src/workflow/correction.ts` holds `correctWorkflow` (criterion 1, state part; `forbidden` without `manage`, `invalid_state` outside `in_progress`), `compareWithSent` and `resumeWorkflow` (criteria 4, 5 and 6: a changed body resets every completed participant, a changed field resets its completed owner, a changed field with no owner counts as a body change, nothing changed returns to `in_progress`). Tested in `packages/authority/test/workflow.correction.test.ts` (property tests included, pass). Criterion 2 is half met: `fillActive` is false while `correcting`, but the `read_only` refusal and the recovered-edits pane are the room's and the editor's, not built. Criteria 1, 4, 5, 6 and 7 stay unticked: the endpoints, the `correct` and `resume` control commits, the `corrected` event and the idempotency are not built (FRW-030, FRW-036), so no request reaches these functions. Criterion 3 is the permission model's (`lockFor('correcting')` is null, so no lock is set; not decided). Decisions in `docs/adr/0249-lane-FRW-027-039.md` (decision 15).

**Notes (lane w4, 2026-11-18):** Criterion 2 stays unticked, because a participant's commit cannot reach the refusal through the service yet. Both halves are tested apart: the room refuses everything a participant of a `correcting` workflow sends as `read_only` and stores nothing (`packages/authority/test/frw-032.correct-room.test.ts`, with the connection naming its participant), and the core keeps what the participant had not sent when a commit is refused `read_only` (`packages/engine/test/frw-032.paused-recovered.test.ts`: over backend-mock, whose refusal comes from the document's lock, the unsent value is set aside as a recovered edit with reason `read_only`, the field shows the stored value, and the core is read-only until the document is writable again). What is missing is the token binding of FRW-038: the data plane ignores the token's `wfp`, so a connection has no `participant` and the room cannot call it paused; re-tick 2 with FRW-038 and a service test of a participant's token. Decisions, none the owner's, in ADR 0385: `correcting` leaves the document active with no workflow running (so a whole-document restore and a replacement of the content are not refused with `workflow_active` while correcting, and `resume` resets everyone then); a completed participant keeps the mark `completed` while the others are `paused`, and every participant's own status word is `paused`; a field with no owner counts as the body; both holders of a role are reset by a change of their role's field; `sentSeq` and `sentHash` are not moved by `resume`, so a second correction compares with the first send (an owner decision: move the baseline to the head at `resume` or not); no `resumed` event is raised, because 12 names none. What happens to a reset participant's earlier signature value is still not stated. Outside the lane: `packages/authority/src/room/room.ts` (the paused refusal, small and additive), `packages/authority/src/workflow/lock.ts` (the lock of `correcting`, and the property test of FRW-029 that listed it as undecided is changed), the permission matrix and `spec/permissions` and `spec/dep` (two operations, generated), `docs/spec/12` §10 (the two actions named as assumed routes, as `send`).


### FRW-033 Decline or void a workflow

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Owner |

**Spec:** 12 §6.2 (`decline`, `void`), §10 · **Requirements:** R13 · **Depends on:** FRW-029, FRW-030, FRW-036

As a participant, I want to decline to proceed, and as an owner I want to void a workflow, so that a stopped process is recorded with a reason and cannot be resumed by accident.

**Acceptance criteria**

- [ ] Given a workflow `in_progress`, when a participant calls `/decline` with a reason, then the state becomes `declined`, the reason is recorded in the control commit and the evidence, and `participant_declined` is raised.
- [x] Given a workflow `sent` or `in_progress`, when a caller with `manage` calls the action `void` with a reason, then the state becomes `voided` and `voided` is raised.
- [x] Given a decline or void request without a reason, then it is rejected and nothing changes.
- [x] Given a workflow in `declined` or `voided`, then no further transition is possible, the document stays locked, and tokens of its participants no longer allow filling.
- [ ] Given the owner wants to reuse the document, then it is forked: the component raises `de-fork-request` and the host calls the fork endpoint with its service credential.
- [x] Given a caller without `manage`, then `void` is rejected with `forbidden`.

**Evidence:** `packages/authority/test/workflow.lifecycle.test.ts` (criteria 3 and 6 through `declineWorkflow` and `voidWorkflow` in `packages/authority/src/workflow/lifecycle.ts`: a blank reason is refused as `reason_required` and the record is unchanged, property tests; a void by a caller without `manage` is `forbidden` in every state; the terminal states admit no transition, `declined` and `voided`).

**Evidence (lane w4, 2026-11-18, criteria 2, 3, 4 and 6):** The routes are `POST /documents/{id}/workflow/void` and `POST /documents/{id}/workflow/participants/{pid}/decline` (`packages/protocol/src/definition/frw.ts`: operations `voidWorkflow` and `participantDecline`, body `WorkflowReason`; `services/document-service/src/control-plane/workflow-routes.ts`), over `recordVoid` and `recordDecline` (`services/document-service/src/workflow/stop.ts`) and the authority's `voidWorkflow` and `declineWorkflow`, through `recordTransition` (FRW-030). Decisions: `docs/adr/0386-w4-FRW-033-decline-and-void.md` (proposed). `pnpm exec vitest run --project node services/document-service/test/control-plane/frw-033.decline-void.test.ts` (memory and PostgreSQL in Podman, both ran, 14 tests passed), the real data plane with an owner and a participant connected: criterion 6, an editor's `void` is 403 `forbidden`; criterion 3, a body with no reason, an empty one, a blank one and one that is not text are 400 `validation_failed` for both actions (the blank one with the pointer `/reason`), the state stays, no control commit is written and no event is raised; criterion 2, the owner voids a `sent` workflow: the state is `voided`, every participant is `closed`, the document is `locked` with no workflow running, one control commit follows, `voided` is raised once (a repeated `Idempotency-Key` adds nothing) and carries no reason, a draft is `conflict`; criterion 4, once voided or declined, `send`, `correct`, `resume`, `void` and `decline` are each 409 `conflict` and change neither the revision nor the log, the document stays locked, the owner's text commit is refused `read_only` over the wire, a restore and a replacement of the content are 409, and a participant who filled while the workflow ran (a token with the fill role) is refused `read_only` afterwards. Criterion 1 in part: the participant whose token binds to them declines `in_progress` with a reason, the state is `declined`, one control commit follows, `participant_declined` is raised once with the participant's identifier and without the reason, and the trimmed reason and who declined are in the audit entry of the transition; a token of another participant, one with no `wfp`, one with another `sub` and the owner are 403, a `cc` participant is 403 (for the host too), the host's service credential may decline for a participant it names (05 §6.1), and a workflow that is only `sent` is 409. Criterion 5 in part: the host forks the stopped document with its service credential and the copy is a draft with no workflow, and a user may not fork.

**Notes:** The diagram has no decline from `sent`, and no void or expiry from `correcting`; see Open questions. Lane FRW-027-039, 2026-11-13: criteria 1 and 2 stay open: the state and the reason are set by the pure functions, but the `participant_declined` and `voided` events, the evidence entry and the control commit are not built (FRW-030, FRW-036, FRW-041). Criterion 4 stays open: the transitions are refused, but tokens that stop allowing fill (FRW-038) and the lock (FRW-029) are not built. Criterion 5 is the fork endpoint and `de-fork-request` (not built). The decisions taken (decline from `in_progress` only, the reason trimmed, a `cc` participant may not decline) are in `docs/adr/0249-lane-FRW-027-039.md` (proposed). Criteria 3 and 6 were unticked in review (2026-11-13): they describe the `/decline` and `void` requests, no endpoint exists, `lifecycle.ts` is not exported from `packages/authority/src/index.ts` and only its tests import it. Fixer E group 3 (2026-11-13): a blank reason maps to `validation_failed` and a void without `manage` to `forbidden` in `workflow/problems.ts` (ADR 0249 decision 10); the criteria stay unticked until a workflow service serves `/decline` and `void`.

**Notes (lane w4, 2026-11-18):** Criteria 1 and 5 stay unticked. Criterion 1: the state, the event and the participant are done, but the reason is not in "the control commit and the evidence": a control commit records a grants revision and has no member for a reason, and the evidence record of the workflow (FRW-041) is not written by any route; the reason is kept in the audit entry of the transition (ADR 0386, point 3). Re-tick when a place for the reason in the commit and the evidence is decided. Criterion 5: the fork endpoint exists and works on a stopped document (tested), but the component does not raise `de-fork-request` (HIS-022 criterion 1, `packages/element/src/events.ts` lists it as not yet raised). Criterion 4: "tokens of its participants" is shown with a token that carries the fill roles, as the data plane builds connections today; a token bound by `wfp` reaches no connection until FRW-038, so the part for such a token follows with that story. Decisions, none the owner's, in ADR 0386: a user declines only for the participant their token is bound to, and the host's service credential for any participant; the reason is 1 to 2000 characters and kept in the audit entry only; every participant who has not completed is marked `closed`; a `correcting` workflow is not voided. The reading of 12 that a decline is possible from `in_progress` only is the authority's (ADR 0249). Outside the lane: `packages/authority/src/index.ts` exports `declineWorkflow`, `voidWorkflow` and the refusal type; `recordTransition` takes a `note` for the audit entry; the matrix, `spec/permissions` and `spec/dep` (generated), `docs/spec/12` section 10.


### FRW-034 Expire at the deadline and send reminders

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Owner |

**Spec:** 12 §6.1 (`deadline`, `reminders`), §6.2, §10 · **Requirements:** R13 · **Depends on:** FRW-025, FRW-030, FRW-036

As an owner, I want reminders to go out and the workflow to expire at its deadline, so that a process that stalls ends in a recorded state.

**Acceptance criteria**

- [x] Given a `deadline` that passes while the workflow is `sent` or `in_progress`, then the state becomes `expired`, a control commit is written, `expired` is raised and participants can no longer fill.
- [x] Given `reminders` with `firstAfterDays` 3 and `everyDays` 2, then for each active participant who has not completed, `reminder_due` is raised after 3 days and every 2 days after that.
- [x] Given the action `remind` and a caller with `manage`, then `reminder_due` is raised for the active participants who have not completed.
- [x] Given a participant completes, or the workflow reaches a terminal state, then no further reminder is raised for them.
- [x] Given the scheduler restarts or two instances run, then each reminder is raised once per interval.
- [x] Given the deadline and reminder times, then they use the server clock and the `deadline` instant is read as UTC.

**Evidence:** `services/document-service/test/control-plane/frw-034.expire-remind.test.ts` (`pnpm exec vitest run --project node <file>`, Node.js 22.18, 14 tests, memory and PostgreSQL in Podman, both ran and passed; lane w4, 2026-11-18): the composed service with the real data plane, a participant connected, and the harness's service clock moved with `advance`. Criterion 1: a workflow with a `deadline` one day ahead stays `sent` one second before it and becomes `expired` at it; the stored participants are `closed`, the document is `locked` with `workflowActive` false, exactly one control commit is added, `dep.workflow.expired` is raised once (data: workflow, document, `seq` of that control commit, chain head) and the audit entry says `sent` to `expired`, `cause` `deadline`; the participant who filled before gets `sync.reject` `read_only` afterwards; a later run does nothing more. Criterion 2: with `firstAfterDays` 3 and `everyDays` 2, `reminder_due` is raised for the one active participant at 3 days (not a second earlier), then at 5 and 7 days; a participant who is pending or a `cc` gets none; with only one timer, or none, nothing is raised. Criterion 3: `POST /documents/{id}/workflow/remind` with `manage` raises it for the active participant at once, changes neither the revision nor the schedule's count (the reminder at 3 days still comes); an editor is `forbidden` and a draft is `conflict`. Criterion 4: after `recordCompletion` of `p1`, the next reminder is for `p2` three days after `p2` became active and none for `p1`; after a void none is raised. Criterion 5: two sweeps at the same instant raise one reminder and one expiry; a second run, and a run on new dependencies over the same stores, raise none; seven days without a run raise one event and count three reminders; `ReminderStore.claim` with 12 concurrent claims has one winner, on PostgreSQL too (`workflow_reminders`, migration 0076), and an earlier activation, a stale count and a count that does not rise are refused. Criterion 6: the deadline is compared with the service clock (`deps.now`), never a client value; a deadline written with `Z` in a workflow whose time zone is `Pacific/Auckland` expires at the instant, one hour on the server clock. The pure rules are tested in `packages/authority/test/workflow.schedule.test.ts` (existing) and `lockFor('expired')` in `packages/authority/test/frw-029.workflow-lock.test.ts`. Code: `services/document-service/src/workflow/schedule-sweep.ts` (`sweepTenant`, `recordRemind`), `reminder-store.ts`, `reminder-store-pg.ts`, `src/workflow/transitions.ts` (`activatedAt`), `src/server.ts` (the scheduled task `workflow.schedule`, every minute), `src/control-plane/workflow-routes.ts` (`remindWorkflow`).

**Notes:** Whether `firstAfterDays` counts from the send or from the participant's activation, and that `remind` raises `reminder_due`, are inferred (Open questions). The test-mode switch of the conformance kit shortens these timers. Lane FRW-027-039, 2026-11-13 (round 3): `packages/authority/src/workflow/schedule.ts` holds `parseDeadline` (the instant read as UTC; a `Z` or no suffix; other offsets and impossible calendar values refused, so no local-time reading), `expireIfDue` (criterion 1, state part: `expired` at the deadline, `end` left null, `fillActive` false afterwards), `remindersDue` and `newReminders` (criterion 2 timing, and criterion 5: the caller's stored count makes each reminder number raised once), `reminderEligible` and `remindTargets` (criteria 3 and 4: `forbidden` without `manage`, no reminder once completed or in a terminal state). Tested in `packages/authority/test/workflow.schedule.test.ts` (property tests included, pass). No criterion ticked: no scheduler runs these functions, no control commit or `expired`, `reminder_due` event is raised (FRW-030, FRW-036), and the store of the raised count and the server clock are the service's. The anchor of `firstAfterDays` is a parameter, not a default (Open questions). Decisions in `docs/adr/0249-lane-FRW-027-039.md` (decision 17, proposed).

**Notes (lane w4, 2026-11-18):** All six criteria are ticked. Decisions, none the owner's, in `docs/adr/0389-w4-FRW-034-expire-and-remind.md` (proposed): the reminders count from the participant's activation; both timers are needed; a backlog of due reminders is one event; the count of raised reminders is kept apart from the resource and moved before the event, so a crash between the two loses a reminder and never repeats one; an `expired` workflow is `locked` with no fill (`lockFor('expired')`, which FRW-029 had left open); a `correcting` workflow does not expire; the sweep runs every minute. Outside the lane: `packages/authority/src/index.ts` exports the schedule functions and `lockFor` now answers for `expired`; the operation `remindWorkflow` (`packages/protocol/src/definition/frw.ts`, generated `spec/dep`, `spec/permissions`, the matrix, `packages/tck/test/pending.ts`, `tests/security/test/sec-045-route-sweep.test.ts`, `packages/protocol/test/definition.test.ts`); `docs/spec/12` §6.2 and §10; migration 0076 with the purge list (`document-purge-pg.ts`) and `schema.pg.test.ts`. Here the sweep is called directly; the scheduler's own slot job is tested under BE-052.

### FRW-035 Push workflow state to connected clients

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** 12 §10 (real-time plane); 05 §5.2, §5.5; 07 §4 · **Requirements:** R13, R3 · **Depends on:** FRW-025, PRO-032

As a maintainer, I want the workflow state and the participant's status pushed to connected clients, so that the editor changes what a person may do without a reload.

**Acceptance criteria**

- [x] Given a channel is opened on a document with a workflow, then `ch.opened` carries the `workflow` object with its state and the participant's status.
- [x] Given the workflow state or the participant's status changes, then `wf.changed` (server to client) carries the new state and the participant's status, sent in the same way as `perm.changed` (a complete new object).
- [x] Given a transition that changes what a connection may do (activation, pause, completion, lock), then `access` is recomputed, its `rev` increases and `perm.changed` is sent as well; the server enforces the new permissions from the moment it computes them.
- [x] Given a client that was disconnected during a transition, when it reconnects, then `ch.opened` brings it to the current state.
- [x] Given a message to a participant, then it carries that participant's own status and not other participants' personal details.
- [ ] Given the editor receives `wf.changed`, then the guided bar and lock indicator update without a reload.

**Evidence:** `packages/authority/test/frw-035.workflow-push.test.ts` (vitest, Node.js 22.18, 11 tests; lane w4, 2026-11-17): the real `Room` with a workflow record built by `sendWorkflow`, `openWorkflow` and `completeParticipant`. Criterion 1: `ch.opened.workflow` is the state and the connection's own participant status (`active`, `waiting`, `copy`; the state alone for a connection that is no participant; no member without a workflow). Criteria 2 and 3: `Room.workflowChanged(record, perms)` sends `perm.changed` (revision 2, `access.fill.active` recomputed from the record, not from the stale token claim) and then `wf.changed` with the complete new object to each connection whose own object changed, none to a connection whose object did not; the revision is written as a control commit; the order 2 participant's fill is refused before and accepted after the transition. Criterion 4: a channel opened after the transition, on the same room or on a room started with the record, gets the current object and access in `ch.opened`. Criterion 5: no other participant's id, `sub` or roles appears in any message. `packages/protocol/src/bridge/frw-035.workflow-wire.test.ts` (3 tests): `RoomBridge.opened` puts `workflow` into the DEP `ch.opened`; `wf.changed` is translated and sent after the held `perm.changed` of the same transition (both after its control commit), or at once when no access is held; the payloads pass the generated `ChannelOpened` and `WorkflowStatus` schemas. Code: `packages/authority/src/room/room.ts` (`workflow` in `RoomInit`, `workflowChanged`, `withWorkflow`), `room/types.ts` (`wf.changed`, `ch.opened.workflow`), `workflow/state-view.ts` (`workflowStatus`), `projection/gateway.ts` (`workflowChanged`), `packages/protocol/src/bridge/room-bridge.ts`, `packages/protocol/src/definition/common.ts` (the participant status words; `spec/dep/*` and `src/generated/types.ts` regenerated).

**Notes:** The payload shape of `wf.changed` is not defined beyond "the workflow state and the participant's status"; the AsyncAPI definition is part of this story. Sending other participants' names to a participant is a privacy question (Open questions). Lane FRW-027-039, 2026-11-13 (round 3): `packages/authority/src/workflow/state-view.ts` holds `workflowView`, the complete object for one connection (state, `sentSeq`, the `lockFor` lock, and the own participant's id, kind and one-word status: `copy`, `completed`, `active`, `paused`, `closed`, `waiting`). It never carries another participant's entry, `sub` or roles; the privacy reading is decided as "no" (ADR 0249, decision 16, proposed). Tested in `packages/authority/test/workflow.state-view.test.ts` (property test over random participant lists, pass). No criterion ticked: the object is not put on `ch.opened` or `wf.changed` (no channel or push is wired to workflows), the `access` recomputation and `rev` increase (criterion 3) are the room's, and the AsyncAPI definition is not written. Lane V-FRW-019-036, round 2 (2026-11-13): the object is not wired into `ch.opened` (`packages/authority/src/room/room.ts`, `open()`), which has no workflow provider; the change needs `RoomInit` and `room/types.ts`, recorded in docs/adr/0340-lane-V-FRW-019-036.md (proposed). No criterion ticked. Lane w4, 2026-11-17: criteria 1 to 5 ticked on the room and bridge evidence above. Payload shape (the AsyncAPI definition): `wf.changed` carries the DEP `WorkflowStatus` (`state`, and `participant: { id, state }` for the receiving participant), the same object as `ch.opened.workflow`; `state` is one of `active`, `waiting`, `completed`, `paused`, `closed`, `copy` (the words of `participantStatusWord`; the definition lists them as known values, the string stays open). `rev` of `WorkflowStatus` is not set. Proposed, not decided by the owner: `wf.changed` follows `perm.changed` on the wire and waits behind it for the control commit (D12). The privacy reading of ADR 0249 stands (no other participant's data). Criterion 6 stays open: the client channel reports `wf.changed` as an effect (`packages/protocol/src/client/channel.ts`) but `backend-dep` drops it (no workflow port yet, `packages/backend-dep/src/channel.ts`), and nothing in the engine, element or `FillBar.svelte` reads it. Not built, and so a limit on criteria 1 to 5 in the running service: `services/document-service` does not give the room a workflow (`HostedRoom` loads no workflow resource, `RoomNotifier` has no `workflowChanged`, and `recordTransition` calls `permissionsChanged` only); the completion of a participant is not stored by any route, so the transition after `sent` is not driven there. The room, its gateway and the bridge are ready for that wiring (`ProjectionGateway.workflowChanged`, `RoomInit.workflow`). The fan-out follower (`room/follower.ts`) does not carry the workflow object.

### FRW-036 Leave all messages to the host

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 12 §6.3, §10 (webhooks), §1.1; 05 §7 · **Requirements:** R13, R6 · **Depends on:** FRW-025, PRO-069, PRO-070, BE-055

As an integrating developer, I want the document service to raise webhooks for every workflow event and send nothing itself, so that I send invitations and reminders in my own voice and the service never holds contact details.

**Acceptance criteria**

- [ ] Given each of the events `sent`, `participant_activated`, `participant_viewed`, `field_completed`, `participant_completed`, `participant_declined`, `auth_failed`, `reminder_due`, `corrected`, `voided`, `expired`, `completed` and `finalised`, when it occurs, then a signed CloudEvents webhook is raised once per occurrence (delivery at least once) under the `dep.workflow.` prefix, with small `data` that includes the `seq` and the chain head.
- [x] Given the webhook data, then it contains no contact detail and no evidence personal data such as an IP address.
- [x] Given the service's code and configuration, then it contains no path that sends e-mail or text messages, and its only outbound traffic for workflows is webhook delivery through the egress proxy.
- [x] Given `participant_activated`, then it carries the workflow, document and participant identifiers so that the host can invite the person and mint their token (FRW-038).
- [x] Given the 05 §7 event table, then it is extended with these events and the conformance kit asserts them.

**Evidence:** `packages/authority/test/workflow.events.test.ts` (criterion 2: the data of every event is built from identifiers, `seq` and the chain head only, a leaked email, phone, IP address, user agent and name are not copied, and the type carries `dep.workflow.`; criterion 4: `participant_activated` carries the workflow, document and participant identifiers). The builder is `packages/authority/src/workflow/events.ts`. Criteria 2 and 4 were unticked in review (2026-11-13): they describe the data of a webhook that is raised; no webhook is raised, and `events.ts` is imported by its test only (it is not even exported from `packages/authority/src/index.ts`). They wait for the raising of events (FRW-030) and a test at that level. Round 2 fix (2026-11-13): `events.ts`, `lock.ts` and `binding.ts` are now exported from `packages/authority/src/index.ts` for the workflow service, but they stay unwired: no service raises, signs or delivers a workflow webhook, so criteria 2 and 4 stay unticked.

**Evidence (lane w4, 2026-11-18, criteria 2 to 5):** `services/document-service/test/control-plane/frw-036.workflow-webhooks.test.ts` (`pnpm exec vitest run --project node <file>`, memory and PostgreSQL in Podman, both ran, 5 tests passed): the composed service with a subscription to the 13 workflow types, the real egress proxy and a fake resolver and connector. Criteria 2 and 4: after the send, the first view, the correction and the resume, the four deliveries (`sent`, `participant_activated`, `corrected`, `participant_activated`) are signed requests (`webhook-id` of the row, `webhook-signature` `v1,...`, `webhook-timestamp`) to the one host of the subscription; each body is a CloudEvents 1.0 structured event with `subject` the document and `data` holding only `workflow`, `document`, `seq`, `chainHead` and, for `participant_activated`, `participant`; the participant in the workflow carried a name with an e-mail address and a `sub`, and neither appears in any body, no value of the data looks like an address, an IP address or a phone number, and the `seq` of each is that of the control commit the transition wrote; a repeated send with the same `Idempotency-Key` raises nothing more. The data now stays within the published schema: `packages/protocol/src/definition/frw.ts` lists `workflow`, `document`, `chainHead` and, for the participant events, `participant` for the 13 events (`spec/dep/webhooks/dep.workflow.*.v1.schema.json` regenerated; before, they listed `seq` only, which the emitted data already exceeded). The builder's own test is `packages/authority/test/workflow.events.test.ts`. Criterion 3: `services/document-service/test/control-plane/frw-036.no-outbound.test.ts` (5 tests): no workflow module (`src/workflow/**`, `workflow-*.ts`) imports a network module or calls `fetch`, a socket or a beacon, none and not `config.ts` names a mail, SMS or voice client, and the only file of the service that imports `request` from `node:http` or `node:https` is the webhook egress `control-plane/webhook-egress.ts`; with the delivery test above (every request left through the connector of the egress proxy, to the subscription's host only) and `packages/authority/test/frw-036.no-mail-path.test.ts` (no mail client in any package). Criterion 5: 05 §7 now has a row naming the 13 workflow events and their data (`docs/spec/05-protocol.md`); the kit's check of the prose against the artifacts, `packages/tck/test/sync.test.ts` ("has the same resources and methods as the OpenAPI document, and the same webhook events", PRO-117), no longer leaves the workflow events out, so the kit asserts that each of the 13 is in both the prose and `dep-1.registry.json`; `packages/protocol/test/prose.test.ts` compares the union of 05 §7 and 12 §10 with the definition.

**Notes:** 12 §10 names the first event `dep.workflow.sent` and the rest bare; the prefix is applied to all (Open questions). `field_completed` is read as raised after a fill or sign commit for a participant's field is stored; its trigger is inferred. Lane FRW-027-039, 2026-11-13: criteria 2 and 4 were ticked for the data only, then unticked in review (`packages/authority/src/workflow/events.ts`, tested in `workflow.events.test.ts`). Criterion 1 stays open: nothing raises an event, signs or delivers a webhook, and the `seq` and chain head come from the control commit (FRW-030), which is not built. Criterion 3 stays open: no test scans the service for a mail or SMS path, and the egress proxy is the service's. Criterion 5 stays open: the event table of 05 §7 and the conformance kit are not edited here (PRO, the kit). The data builder rejects a participant event without a participant, and the events list follows 12 §10. Lane U-FRW-019-036 (2026-11-13): criterion 3 is half tested: `packages/authority/test/frw-036.no-mail-path.test.ts` (Node.js, vitest, 4 tests) finds no mail, SMS or voice client in any package manifest or non-test source file under `packages/`, `services/` and `apps/`. The egress-proxy half and the service's configuration stay open, so the criterion is not ticked. Lane V-FRW-019-036, round 2 (2026-11-13): criterion 1 stays open. The envelope of `services/document-service/src/control-plane/webhook-envelope.ts` accepts only versioned types (`dep.<name>.v<n>`), and the workflow names of `events.ts` carry no version; no route raises a workflow event. Recorded in docs/adr/0340-lane-V-FRW-019-036.md (proposed).

**Notes (lane w4, 2026-11-18):** Criterion 1 stays unticked, because only five of the 13 events have a path that raises them: `sent` and `participant_activated` (the send and the resume), `corrected` (the correction), and, since FRW-033, `participant_declined` and `voided` (the decline and the void), the first three delivered once per occurrence as shown above (the two of FRW-033 are raised on the same event sink and tested in `frw-033.decline-void.test.ts`). `participant_viewed` and `participant_completed` and `completed` are returned by `recordFirstView` and `recordCompletion` (FRW-031), which no route or channel open calls yet (FRW-038 for the first view, FRW-047 for the completion); `field_completed` follows a fill or a sign commit (FRW-047); `auth_failed`, `reminder_due`, `expired` and `finalised` have no job or route in the service. The last test of the delivery file lists them, so that the gap is stated in code. The delivery guarantees themselves (retries up to 24 hours, at least once, the dedupe on `webhook-id`) are the dispatcher's (PRO-071) and are not repeated here. Criterion 5 asserts the lists, not a delivery to a live server: that is a scenario for the `workflow` profile of the kit (FRW-068). Decisions: the 12 §10 reading that each event carries `seq` and the chain head is kept; `chainHead` is the chain head after the control commit when the room wrote it in time, else the head at the request (ADR 0382 point 5). Outside the lane: `packages/protocol/src/definition/frw.ts` and the generated `spec/dep`, `docs/spec/05-protocol.md`, and the two tests that compared the lists (`packages/protocol/test/prose.test.ts`, `packages/tck/test/sync.test.ts`).


### FRW-037 Route by rules

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | L | could | Owner |

**Spec:** 12 §5.1 (routing effects), §6.1 (`routing`), §13 · **Requirements:** R13 · **Depends on:** FRW-015, FRW-031, FRW-047

As an owner, I want the workflow to add or skip a participant depending on field values, so that a lease above an amount automatically goes to an approver.

**Acceptance criteria**

- [ ] Given a routing rule in the workflow resource whose condition is `lease.total` greater than `"50000"` and whose effect is `addParticipant` with a role and an order, when the condition becomes true as evaluated by `packages/rules`, then a participant for that role is added at that order and activated according to the ordering rules.
- [ ] Given a `skipParticipant` effect whose condition holds, then that participant is skipped and the workflow proceeds to the next order.
- [ ] Given routing rules, then they are validated when the workflow is saved: keys exist and roles exist.
- [ ] Given a routing change, then a control commit is written and the relevant webhooks and `wf.changed` are sent.
- [x] Given a routing effect inside a `rule_def` in `defs`, then it is rejected (FRW-015).

**Evidence:** `packages/rules/test/routing.test.ts` "refuses a routing effect inside a rule_def (FRW-015)" (criterion 5, through `compileRules`); `packages/rules/test/document.test.ts` (the same refusal through `compileDocument`, existing).

**Notes:** Phase from 12 §13 (4). The points at which routing is evaluated, and who the person for an added role is, are not stated (Open questions). Lane rules-3, 2026-11-13: `packages/rules/src/routing.ts` adds `compileRouting` (the save-time validator: field keys, roles, boolean conditions, effect shapes, every problem with its path) and `evaluateRouting` (which routes apply, and the add and skip actions they name). Criteria 1 and 2 stay open: the package decides what applies, but the participant is not added or skipped, nor activated by order, until the workflow service applies the actions. Criterion 3 stays open: the validator is tested, but the workflow save that must call it is not built. Criterion 4 stays open: no control commit, webhook or `wf.changed` exists yet. Decisions taken in `routing.ts` (every route evaluated, no first match; null or failing conditions do not apply; order a positive integer; cap `LIMITS.rules`) are listed in `docs/adr/0159-rules-3-backlog-batch.md`.

## Participants, authentication and evidence (12 §7)

### FRW-038 Admit participants with host-minted tokens

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 12 §7 (first bullet); 05 §3.1; ADR 0013 · **Requirements:** R13, R10 · **Depends on:** FRW-007, FRW-025, FRW-026

As an integrating developer, I want to mint a token for a participant who is outside my user base, so that they can open one document, fill it and sign it without an account in my application.

**Acceptance criteria**

- [x] Given a token with the document role `filler` for one document, an opaque `sub`, the claim `wfp` set to a participant identifier and optionally `amr` and `auth_time`, when the participant opens a channel, then `access.fill.participant` is true and `access.fill.roles` are the roles of that participant in the workflow.
- [x] Given a token whose `wfp` names a participant of another document's workflow, or whose `sub` differs from the participant's `sub`, then the connection receives no fill capability.
- [x] Given `amr` and `auth_time`, then the service records them exactly as given and never validates or vouches for them; no response, certificate or evidence line presents them as verified identity.
- [x] Given the document service, then it offers no one-time passcode and no identity-verification endpoint; both stay with the host.
- [x] Given a refreshed token whose roles or `wfp` differ, then access is recomputed and `perm.changed` is sent (05 §3.1).
- [x] Given a participant of a workflow that is `declined`, `voided` or `expired`, then their token yields no fill capability even while it has not expired.

**Evidence:** `services/document-service/test/control-plane/frw-038.participant-token.test.ts` (`pnpm exec vitest run --project node <file>`, Node.js 22.18, 16 tests, memory and PostgreSQL in Podman, both ran and passed; lane w4, 2026-11-18): the real token service and data plane, a real WebSocket client, host-signed tokens with the role `filler`. Criterion 1: a token with only `sub` and `wfp` opens a channel after the send and gets `access.fill` `{ participant: 'p1', roles: ['tenant'], active: true }`, the roles being those of the participant in the workflow (no fill-roles claim in the token), and its commit is acknowledged; the second participant gets its own roles (`landlord`) with `active` false, and its commit is rejected. Criterion 2: a `wfp` that names no participant of the workflow, a `sub` that differs from the participant's, and the form-mode `wfr` claim beside an unbound `wfp` all give `fill` null and a rejected commit; a token of another document's workflow, whose participant has the same id, binds there and is refused a channel on this document; a draft gives no fill. Criterion 3: a token with `amr` `['made-up-method', 'pwd', '']` and `auth_time` in the year 2100 is accepted, the channel's record holds them exactly as given, and no frame sent to the client and no `GET /workflow` body carries them or the word "verified". Criterion 4: the published operations (`DEP1.operations`) hold no name or path with otp, passcode, one-time, identity, kyc or sms, the only one with `verify` is `participantVerify` (the access code of FRW-039), and GET and POST to six paths such a service would use answer 403, 404 or 405. Criterion 5: a refresh with the same claims sends nothing; a refresh whose `wfp` binds to no one sends `perm.changed` with `fill` null and the next commit is rejected; a refresh back to `p1` sends `perm.changed` with the participant's roles and the commit is acknowledged. Criterion 6: for a workflow that is declined (by the participant's route), voided (by the route) and expired (by the deadline sweep of FRW-034), the connected participant gets `perm.changed` with `fill` null and its commit is rejected, and a channel opened afterwards with a token that has not expired has `fill` null. At the room: `packages/authority/test/frw-038.token-binding.test.ts` (12 tests): the roles and the participant come from the workflow whatever the connection claims (`participantRoles: ['role_forged']` is ignored), the three kinds of failed binding, a document with no workflow, a connection with no `wfp` unchanged, refreshes between two participants of one `sub`, and the three ended states through `workflowChanged`. The pure binding is `packages/authority/test/workflow.binding.test.ts` (existing); the wording of certificates and bundles (as asserted by the host) is `workflow.certificate.test.ts`, `workflow.bundle.test.ts` and `workflow.language.test.ts` (existing). Code: `packages/authority/src/room/room.ts` (`withWorkflow` binds `Connection.participantClaim`), `permissions/model.ts`, `services/document-service/src/data-plane/room-host.ts` (`connectionOf` passes the raw `sub` and `wfp`).

**Notes:** Pitfall (12 §14): signer identity is only as strong as the host's authentication; record the host's assertion, never vouch for it. The `sub` binding check is inferred from the participant record (12 §6.1); confirm.

**Notes (lane FRW-027-039, 2026-11-13):** no criterion ticked. `packages/authority/src/workflow/binding.ts` holds the rule: `bindParticipant` binds a token's `wfp` and `sub` to a participant of the workflow (criterion 2, a `wfp` of another workflow binds to no one, a `sub` mismatch and an unrecorded `sub` bind to no one), and `tokenMayFill` yields fill only to a bound participant who is active in a `sent` or `in_progress` workflow (criterion 6). Tested in `packages/authority/test/workflow.binding.test.ts`. Not met: the token service (`services/document-service/src/control-plane/tokens.ts`) does not call it: it ignores `wfp` and sets `participantActive` to false, so no connection receives fill from a token yet. Criterion 3 (`amr` and `auth_time` recorded as given) is not met: the token path stores the claims but no verifier records them, and no test shows it. Criterion 4 (no OTP or identity endpoint) is not tested here. Criterion 5 (refresh and `perm.changed`) is not built. Decision recorded in docs/adr/0249-lane-FRW-027-039.md (decision 13, proposed).

**Notes (lane w4, 2026-11-18):** All six criteria are ticked. Decisions, none the owner's, in `docs/adr/0390-w4-FRW-038-participant-tokens.md` (proposed): a token with `wfp` fills only through the binding and never falls back to `wfr`; the room binds, so a workflow that is sent or ends after the token was issued changes access without a new token; `fill.participant` on the wire is the identifier ("is true" is read so); `amr` and `auth_time` stay a record of the channel (PRO-015), their durable record in the participant's evidence being FRW-040 and FRW-041, which are not built, so criterion 3 holds for everything the service sends today and the evidence line is still to be written. Outside the lane: `Connection.participantClaim` (`packages/authority/src/permissions/model.ts`) and the binding in `Room` (`room.ts`); `docs/spec/12` §7; `FRW-034`'s `activatedAt` joined the participant members of the published schema, so `frw-026.no-contact-detail.test.ts` lists it.

### FRW-039 Protect a participant's access with an access code

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Participant |

**Spec:** 12 §6.1 (`auth`), §7 (second bullet), §10; 05 §5.8 · **Requirements:** R13, R10, R11 · **Depends on:** FRW-038, FRW-040, FRW-036

As a participant, I want to prove I know an access code before I can fill, so that a forwarded link alone is not enough.

**Acceptance criteria**

- [x] Given a participant whose `auth.require` lists `access_code`, when they open the document, then the fields stay read-only and the ceremony unavailable until they submit the code to the participant's verify endpoint.
- [x] Given a correct code, then the verification is recorded in the evidence and the participant may fill and sign; given a wrong code, then the request is refused, `auth_failed` is raised and the failed attempt is recorded in the evidence.
- [x] Given the registered code, then it is stored only as a hash; no plaintext appears in tables, logs, evidence, webhooks or responses.
- [x] Given repeated wrong codes, then the endpoint is rate limited with `rate_limited` and `retryAfterMs`.
- [x] Given `auth.require` with a value other than `access_code`, then the workflow is rejected.
- [ ] Given the code input, then it accepts paste, has a visible label, announces errors through a live region and works from the keyboard.

**Evidence (lane w4, 2026-11-18, criteria 1 to 5):** `services/document-service/test/control-plane/frw-039.access-code.test.ts` (`pnpm exec vitest run --project node <file>`, Node.js 22.18, 12 tests, memory and PostgreSQL in Podman, both ran and passed): the real data plane, a real WebSocket client and the REST routes (`services/document-service/src/workflow/access-code-service.ts`, `access-code-store.ts`, `access-code-pg.ts`, migration `0077_frw_039_access_codes.sql`, routes `participantVerify` and `registerAccessCode` in `control-plane/workflow-routes.ts`). Criterion 1: a participant whose `auth.require` lists `access_code` opens the channel with `access.fill` `{ participant: 'p1', roles: ['tenant'], active: false }` and the participant state `unverified`, and their commit is rejected; after a wrong code it is still rejected; after the right code the participant gets `perm.changed` with `active` true and the commit is acknowledged (`fillActive` and `awaitingCode` in `packages/authority/src/workflow/order.ts`). Criterion 2: a wrong code is `forbidden`, `auth_failed` is raised once with the workflow, document and participant and no code, and a ledger row (`access_code`, `ok` false) is written; a right code stores `verifiedAt`, writes a row with `ok` true, the address and the `amr`, and a repeat changes nothing; the owner, the host's credential and a token with another `sub` cannot prove the code. Criterion 3: the test registers a code and submits a wrong one and the right one, then looks for both strings in every REST answer, every log line, every event, the ledger rows, the commit log, the memory store and, on PostgreSQL, as text in every table of the database through the admin role: none holds them; the stored row has a 32-digit salt and a 64-digit hash. Criterion 4: five attempts are `forbidden`, the sixth (the right code) is `429` `rate_limited` with `retryAfterMs` in the problem (at most 15 minutes) and `Retry-After` its whole seconds, not recorded as a wrong attempt and raising nothing; after the window the right code works; of 12 concurrent attempts 5 are `forbidden` and 7 `rate_limited`. Criterion 5: `auth.require` of `sms_otp`, of `access_code` with another method, of a non-string and of `access_code` with another member of `auth` are each `validation_failed` when the workflow is saved (`checkAuthRequire` in `packages/authority/src/workflow/resource.ts`); `['access_code']` is saved. The pure functions are tested in `packages/authority/test/frw-039.access-code.test.ts` (existing).

**Notes:** How the code is registered and how the participant receives it is not specified (the resource example shows only `require`), and neither is a lockout policy (Open questions). The `/verify` meaning is inferred from the access-code sentence in 12 §7.

**Notes (lane U-FRW-037-054, 2026-11-13):** `packages/authority/src/workflow/access-code.ts` holds the stored form (`registerAccessCode`: salt and SHA-256 of salt then code, in hex; no plaintext field), the check (`verifyAccessCode`, whole-hash comparison) and the `auth` check (`checkAuthRequire`: only `require: ["access_code"]`, other methods and other members refused). Tested in `packages/authority/test/frw-039.access-code.test.ts` (9 tests, Node.js 22.18, property tests included, pass). Criterion 3 stays open: no table, log, evidence, webhook or response exists yet to be checked for the absence of plaintext. Criterion 5 stays open: the refusal is the check; the workflow save that must reject with it is not built. Criteria 1, 2 and 4 stay open: the verify endpoint, the read-only gating, the evidence record of a failed attempt, and the rate limit with `retryAfterMs` (the attempt limit and lockout policy are open, not decided). Decisions are in `docs/adr/0341-lane-U-FRW-037-054.md` (proposed).

**Notes (lane w4, 2026-11-18):** Criteria 1 to 5 are ticked; criterion 6 stays open: the code input (paste, a visible label, a live region for errors, the keyboard) is a component of the editor (`packages/ui`, the guided bar), which this lane did not build; the service gives it the word `unverified` for the participant's state (`wf.changed`, `ch.opened`) and the two routes. Criterion 1 reads "the ceremony unavailable" as the same gate (`fillActive`), since the signing ceremony is not built (FRW-044 to FRW-047). Decisions, none the owner's, in `docs/adr/0393-w4-FRW-039-access-code.md` (proposed): the host registers the code with `POST .../participants/{pid}/access-code` (`manage`, hash only, no body back); only the participant's own token verifies, not the host's credential or the owner; 5 attempts in 15 minutes for each participant (design values, counted before the comparison so concurrent attempts cannot pass the limit), the correct one counted and a refused one not recorded; verification is once for the workflow; an attempt is a ledger row `access_code` (`ok`, time, `amr`, address and agent under the tenant's capture setting). Outside the lane: `awaitingCode` (the gate in `fillActive`) and the `unverified` status word (`packages/authority`, `packages/protocol` `common.ts`); `ApiError.retryAfterMs` and the `retryAfterMs` member of `ProblemDetails`; the operations `participantVerify` (now a real body and success) and `registerAccessCode`, the generated `spec/dep`, `spec/permissions`, the matrix, `packages/tck/test/pending.ts`, `tests/security/test/sec-045-route-sweep.test.ts` (`participantVerify` is no longer unoffered); migration 0077 with the purge list and `schema.pg.test.ts`; `docs/spec/12` §7.

### FRW-040 Record evidence per participant

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Relying party |

**Spec:** 12 §7 (evidence bullet); ADR 0013; review S-10 · **Requirements:** R13, R4 · **Depends on:** FRW-038, FRW-041

As a relying party, I want the record of what each participant saw, consented to and did, so that I can judge the process behind a signed document.

**Acceptance criteria**

- [ ] Given a participant session, then the service records per participant: the session, the IP address, the user agent, `amr`, the consent text identifier, version, hash and time, the times the document was first viewed, signed and completed, the `seq` and chain hash at signing, and how the signature was adopted with the hash of its image.
- [ ] Given each item, then the server captures it from the connection and the server clock; the client cannot supply an IP address, a user agent, a time or a hash.
- [ ] Given the signature image, then its hash is computed by the server from the stored asset and not declared by the client.
- [x] Given a participant of kind `approver` or `cc`, then only the items that apply to them are recorded and none is invented.
- [ ] Given a participant with several signature or initials fields, then each signing is recorded as its own event with its own `seq` and chain hash.
- [x] Given IP and user agent capture is switched off for the tenant (FRW-042), then those two items are absent and the rest is recorded.

**Evidence (lane w4, 2026-11-18, criteria 4 and 6):** `services/document-service/test/control-plane/frw-040.participant-evidence.test.ts` (`pnpm exec vitest run --project node <file>`, Node.js 22.18, 8 tests, memory and PostgreSQL in Podman, both ran and passed): the real token service and data plane and a real WebSocket client with a host-signed token that carries `wfp` (`services/document-service/src/workflow/participant-view.ts`, called from the session through `DataPlaneDeps.participantOpened`). The first view of a filler writes one ledger row (`item` `viewed`): the session id of the connection, the time of the service clock, `amr` as the token gave it, the socket's address (a loopback address; the client's `X-Forwarded-For` of `198.51.100.9` appears nowhere) and the `User-Agent` of the upgrade request; the workflow is `in_progress`, `firstViewedAt` is set, `participant_viewed` is raised once with identifiers only, and a second connection of the same participant adds no row and no event. Criterion 4: an approver and a `cc` each get a row whose items are `session` and `viewedAtMs` and nothing else, and the ledger (`EvidenceLedger.record`, which takes the participant's kind) refuses with `RangeError` a completion for a `cc`, a consent for a `cc` or an approver, signings for an approver, and a member that is no item; it accepts the items that apply (`applicableItems`, `packages/authority/src/workflow/participant-evidence.ts`, whose own tests are `packages/authority/test/participant-evidence.test.ts`). Criterion 6: with the tenant's capture setting off (memory: the ledger's setting; PostgreSQL: `PgCaptureSettingsStore.change`, table `tenant_capture_settings`), the row of a first view has no `ipAddress` and no `userAgent` member and the string of the agent is nowhere in it, while `session`, `viewedAtMs` and `amr` are there. A token that binds to no one (another `sub`, a `wfp` that names nobody, no `wfp`), a draft and a voided workflow record nothing.

**Notes:** The evidence is personal data and is stored by FRW-041. Lane FRW-040-052, round 1 (2026-11-13): `packages/authority/src/workflow/participant-evidence.ts` builds the record. `applicableItems` gives approvers no consent and no signing, and cc no completion (spec default read from 12 §6.1 and §8.1; ADR 0250 item 1). `buildParticipantEvidence` invents no item and takes network identity through `captureEvidence` (FRW-042). `signatureImageHash` hashes the stored bytes and takes no hash argument. `signingEvents` gives one event per signing and refuses a repeated `seq`. Tested in `packages/authority/test/participant-evidence.test.ts` (17 tests, property tests included). No criterion ticked: the record is not stored (FRW-041); no connection or server clock supplies the facts (criterion 2); the asset store is not built (criterion 3); and no endpoint writes a signing commit (criterion 5). Criterion 4 and 6 hold at the builder only.

**Notes (lane w4, 2026-11-18):** Criteria 4 and 6 are ticked; 1, 2, 3 and 5 stay open because the events they name are recorded by routes that are not built. Criterion 1: the session, address, user agent, `amr` and the first view time are recorded when a participant's channel first opens; the consent (FRW-044), the signing time, the `seq` and chain hash at signing, the adoption (FRW-045, FRW-046) and the completion time (FRW-047) have no route that records them, so the record is not whole. Criterion 2: the items that exist are taken from the connection and the server clock (tested, including that a forwarded address is not read), and no message of the protocol carries any of them; "each item" waits for the routes. Criterion 3: `signatureImageHash` takes the stored bytes only (authority tests), but no signing route reads a stored asset. Criterion 5: `signingEvents` gives each signing its own `seq` and chain hash (authority tests); no route writes a signing commit. Decisions, none the owner's, in `docs/adr/0392-w4-FRW-040-participant-evidence.md` (proposed): the first view is recorded at the channel open, not at a route; the address is the socket's and a forwarded-for header is not trusted; `auth_time` is not evidence; the ledger refuses an item that does not apply to the kind. Effects outside the lane: the first view now moves a `sent` workflow to `in_progress` when a participant's channel opens (FRW-031 had built the function and nothing called it), so the tests of FRW-033, FRW-034 and FRW-038 that connect a participant first start from `in_progress`; `DataPlaneDeps.participantOpened` and `ParticipantOpened` (`seams.ts`), `session.ts`, `data-plane/index.ts`; `EvidenceLedger.record` takes `kind` and an optional `origin`; the test client of the data plane takes request headers; `applicableItems` is exported from `@docedit/authority`; `docs/spec/12` §7.

### FRW-041 Keep evidence outside the commit log

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Operator |

**Spec:** 12 §7 (last bullet), §14; 08 §2; 10 §3.6; ADR 0013 · **Requirements:** R13, R10 · **Depends on:** FRW-030, BE-049, HIS-002, HIS-033

As an operator, I want evidence stored in workflow tables with its own retention and only salted hashes of it in the chain, so that privacy duties and tamper evidence can both be met.

**Acceptance criteria**

- [x] Given evidence, then it is stored in workflow tables scoped by tenant, never in the commit log, checkpoints, exports, webhooks or search entries.
- [ ] Given a control commit for a signing or a completion, then it carries only salted hashes of the evidence, never the evidence itself.
- [ ] Given the evidence and its salts, when a verifier recomputes the hashes, then they match the chain; given the evidence has been purged, then the chain still verifies.
- [ ] Given the data-minimisation rule of 08 §2, then the documentation records this as the one deliberate exception, with the location of the tables and the retention setting.
- [x] Given a tenant's evidence, then another tenant's credential cannot read it (tenant isolation tests).

**Evidence:** `packages/authority/test/evidence.test.ts`, "a control commit carries only salted hashes of its evidence": `controlCommitEvidence` (`packages/authority/src/workflow/evidence.ts`) returns exactly the origin and the SHA-256 over the salt and the canonical evidence text; the payload never contains the evidence or the salt. A property checks the hash against Node's SHA-256 over the same bytes; a verifier recomputes it with `verifyEvidence`, which refuses other evidence and other salts (criterion 3, partly). Criterion 2 unticked by the round 1 review: `controlCommitEvidence` is imported only by its own test and no control commit is built from it, so no commit yet carries the hash. Lane V-FRW-019-036: criterion 5 is met on PostgreSQL in Podman. Evidence: `services/document-service/test/postgres/v-frw-019-036.evidence-tenant.pg.test.ts` (3 tests, `pnpm vitest run` on that file, database named for the lane and dropped afterwards): tenant B sees none of tenant A's rows by document or by tenant column; an insert under tenant A's identifier is refused with SQLSTATE 42501; a delete by tenant B removes none of A's rows; the service role has no UPDATE on the table (42501). Isolation is the row-level security of BE-011 on one database role; a separate database credential per tenant is not tested.

**Evidence (lane w4, 2026-11-18, criterion 1):** `services/document-service/test/control-plane/frw-041.evidence-outside-log.test.ts` (`pnpm exec vitest run --project node <file>`, Node.js 22.18, 8 tests, memory and PostgreSQL in Podman, both ran and passed): the composed service with the real data plane. A workflow is sent with an owner connected (so the room writes the control commit), then two events of evidence with marker values (an address, a user agent, a consent text) are recorded through the new ledger (`services/document-service/src/workflow/evidence-ledger.ts`, `evidence-ledger-pg.ts`, `ServiceParts.evidence`). The ledger lists both, with the network identity the capture setting allows. The marker is in none of: the commits read from the log and the log's head, every object of the object store (the objects that hold checkpoints, versions and exports; the key list is not empty), every event the service raised (the events the dispatcher turns into webhooks); and on PostgreSQL the marker, searched as text in every base table of the database through the admin role, is in `workflow_evidence` and in no other table, in two rows of the one tenant. A source scan finds the name `workflow_evidence` in only the evidence modules (`evidence-ledger.ts`, `evidence-ledger-pg.ts`, `evidence-store.ts`, `capture-settings-pg.ts`) and the document purge, and the ledger in no module of an export, a checkpoint, a webhook or a search entry. Criterion 5 is the earlier evidence below. The payload for a control commit, the verifier and the purge are tested in the same file and are not ticked here (criteria 2 and 3, see Notes).

**Notes:** Authority side, lane authority-4: the commitment only. Not met: criterion 1 (the evidence tables, tenant scoping and the commit log's exclusion are not built), criterion 3 (the chain and the purge are not built; `verifyEvidence` is the recomputation only), criterion 4 (the documentation of the exception is not written) and criterion 5 (tenant isolation needs the workflow tables). Pitfall (12 §14): evidence retention against erasure rights; personal data outside the chain, commitments inside it, legal hold already exists. Lane V-FRW-037-054 (2026-11-13): criterion 1 is tested in part on PostgreSQL by `services/document-service/test/postgres/frw-041.v-frw-037-054.evidence-only-in-workflow-table.pg.test.ts` (1 test, run with `pnpm vitest run` on that file): a marker written as evidence is found, as text, in table `workflow_evidence` and in no other base table of the database, with a commit log beside it (the test writes no sealed-PDF record; corrected by the reviewer). Not shown, so criterion 1 stays unticked: the object store (exports, checkpoints kept as objects) and the commit log's use of the evidence commitment, which no control commit yet makes. Criterion 2 is unchanged.

**Notes (lane w4, 2026-11-18):** Criteria 1 and 5 are ticked; 2, 3 and 4 stay open. Criterion 2: the ledger returns the payload (`{ origin, evidenceHash }`, tested: two members, a 64-digit hash, none of the evidence and not the salt, a fresh salt giving another hash for the same evidence), but a control commit has no member for it and the routes that write the commit of a signing or a completion are FRW-047 and FRW-048, not built; no stored commit carries a hash yet. Criterion 3: a verifier recomputes the hash of each stored row (`recomputeCommitment`, `verifyAgainstChain`: altered evidence, another salt and another participant do not match), and after a purge of the rows the commit log, its head and the chain verify as before (the PostgreSQL log's `verify` is run); what is not shown is a match against hashes held in stored commits, for the reason above. Criterion 4: 08 §2 now records the evidence as the one deliberate exception, with the table (`workflow_evidence`, migration 0060), its tenant scoping and the rule that the chain holds only the salted hash; the retention setting it must name does not exist (FRW-043 criterion 5) and its default is the owner's (FRW-084), so the paragraph says so and the criterion is not ticked. Decisions, none the owner's, in `docs/adr/0391-w4-FRW-041-evidence-ledger.md` (proposed): the row form (`data.commit`), what the hash covers (participant, item and evidence), a salt for each row, the service clock, the 4096-byte limit, the scan of the table's users. Outside the lane: `ServiceParts.evidence` and the two stores in `server.ts`; `readCaptureState` exported from `capture-settings-pg.ts`; `docs/spec/08` §2.

### FRW-042 Switch off IP address and user agent capture

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Tenant administrator |

**Spec:** 12 §7 (last sentence); 13 §10 · **Requirements:** R13, R10 · **Depends on:** FRW-040, UX-076

As a tenant administrator, I want to stop IP address and user agent capture for my tenant, so that I collect only the evidence my legal basis supports.

**Acceptance criteria**

- [ ] Given the tenant setting is off, when participants view, consent, sign and complete, then no IP address and no user agent is stored in their evidence; the other evidence items continue to be recorded.
- [ ] Given I change the setting, then the change is written to the audit trail with actor and time and applies to events after the change; evidence already stored is not rewritten.
- [ ] Given the setting is on (the default), then both items are recorded.
- [ ] Given the setting is set through the administration API, then a caller without the tenant-administration credential is refused.

**Evidence (criterion 2; unticked in review 2026-11-13, re-ticked by the V2 fixer the same day):** the change path is now product code. `PgCaptureSettingsStore` (`services/document-service/src/workflow/capture-settings-pg.ts`, table `tenant_capture_settings` from migration `0067_frw_042_capture_settings.sql`) changes the setting and, in the same tenant transaction, builds the entry with `captureChangeAudit` and inserts it into `audit_events`; `recordEvidence` stores each event's evidence in `workflow_evidence` under the setting read in its own transaction, and nothing updates stored evidence. `services/document-service/test/postgres/v-frw-019-036.capture-audit.pg.test.ts` (PostgreSQL in Podman, `pnpm vitest run` on that file, 2 tests, database named for the lane and dropped afterwards) builds no audit record and inserts no evidence row itself: it records an event with the setting on, changes the setting through `change` as `admin-surrogate-7`, records a later event, and reads back one `capture.setting.changed` entry with that actor and the change time; the later row has no IP address and no user agent; the earlier row is unchanged. It also shows that a stale version is refused, a change to the value in force is not audited, and a change without an actor writes neither the setting nor an entry. The change is not driven by an endpoint: the administration API is criterion 4.

**Notes:** The default value of the setting is not stated; "tenants can switch off" is read as on by default. The effect on the certificate's wording is left to FRW-050. Authority side, lane authority-4 (round 2, 2026-11-13): `packages/authority/src/workflow/capture.ts` (`captureEvidence`, `settingsAt`, `captureChangeAudit`) keeps no IP address and no user agent while the setting is off, applies a change to later events only, and writes the audit entry with actor and time; tested in `packages/authority/test/capture.test.ts`. Not met, so nothing is ticked: criteria 1 and 3 name the participant endpoints (view, consent, sign, complete), which do not exist, and the evidence store is not built; criterion 2 needs the audit trail store; criterion 4 needs the administration API and its credential. Lane V-FRW-019-036: the audit trail store now exists (`PgAuditStore`), so criterion 2 can be tested on PostgreSQL, but it was unticked in review because no product path changed the setting; the V2 fixer added that path (`PgCaptureSettingsStore`, see Evidence) and re-ticked it. Criterion 1 and criterion 3 still need the participant endpoints (`recordEvidence` is the storage step they would call), and criterion 4 still needs the administration API. Evidence audit (2026-11-13): criterion 2 unticked again, because `PgCaptureSettingsStore` (`capture-settings-pg.ts`) is imported by its own test only (it is not exported from `services/document-service/src/index.ts` and no route or job calls `change` or `recordEvidence`), so no actor can change the setting yet; the PostgreSQL test passes (2 tests) and shows the store's behaviour, and the tick waits for the administration API of criterion 4.

### FRW-043 Remove evidence at the end of its retention

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Tenant administrator |

**Spec:** 12 §7, §14; ADR 0011 (consequences); 08 §11, §13 · **Requirements:** R13, R10 · **Depends on:** FRW-041, FRW-084, HIS-031, HIS-040

As a tenant administrator, I want evidence removed when its retention ends or when a lawful erasure request arrives, so that I keep personal data no longer than I may, without breaking the proof that the process happened.

**Acceptance criteria**

- [x] Given the retention period of a workflow's evidence has passed, when the purge job runs, then the evidence rows are deleted, the commit log, the chain and the sealed PDF are untouched, and chain verification still passes.
- [x] Given a legal hold on the document, then the purge does not remove its evidence until the hold is lifted.
- [ ] Given an erasure request for one participant and no legal hold, then that person's evidence rows are removed and their field values in commit payloads are replaced by tombstones, and the chain stays verifiable.
- [ ] Given a purge or an erasure, then an audit entry records what was removed without holding the personal data.
- [ ] Given the retention period is a tenant setting, then it defaults to the value decided in FRW-084 and is changed through the administration API.

**Evidence:** `services/document-service/test/postgres/frw-043.purge.pg.test.ts` (PostgreSQL in Podman, run with `pnpm vitest run` on that file; lane U-FRW-037-054): "holds every row while a legal hold is in force" and "removes expired rows once the hold is lifted" run `runEvidencePurge` (`packages/authority/src/workflow/evidence-purge-job.ts`) over table `workflow_evidence` (migration `services/document-service/migrations/0060_workflow_evidence.sql`, adapter `services/document-service/src/workflow/evidence-store.ts`) and read the `audit_events` row, which holds only `removedCount`, `keptCount` and `legalHold`. Criteria 2 and 4 are ticked on that evidence. The hold is still the caller's input: no document-level hold is stored yet.

**Evidence (criterion 1, lane V-FRW-037-054, 2026-11-13):** `services/document-service/test/postgres/frw-043.v-frw-037-054.purge-sealed.pg.test.ts` (1 test, PostgreSQL and the Object Lock bucket of the Versity S3 Gateway in Podman, run with `pnpm vitest run` on that file, database and bucket named with V-FRW-037-054 and removed afterwards): three commits verify before and after a purge that removes two expired `workflow_evidence` rows; the commit log, the head and `logs.verify` are unchanged; the sealed PDF written by `storeAndRecordSealedPdf` reads back with the recorded hash, the record is unchanged, and an overwrite and a delete are still refused.

**Notes:** Phase inferred (evidence arrives in phase 2). The default retention period is an open owner question (FRW-084). ADR 0011 consequence: erasing one value means tombstoning commit payloads. Authority side, lane authority-4 (round 2, 2026-11-13): `packages/authority/src/workflow/retention.ts` (`planPurge`) decides which rows a purge may remove, keeps all rows under a legal hold, and writes an audit entry of counts and the instant only; tested in `packages/authority/test/retention.test.ts`. Not met, so unticked: criterion 1 (the chain check and the untouched commit log and sealed PDF are not tested; the PDF is not built) and criterion 3 (the erasure with tombstones is not built); criterion 5 waits for FRW-084, so no default is set and the caller passes `retentionMs`. Open, not decided: the instant the retention clock starts from. Lane U-FRW-037-054 (2026-11-13): the purge job now runs over PostgreSQL (criteria 2 and 4, see Evidence). The purge is not scheduled; the caller runs it. `test/postgres/schema.pg.test.ts` lists the tables and counts of the migrations and fails on them: it does not list 0050's `threads` and `versions`, and now not `workflow_evidence` either. That file is not this lane's, so it is left as it is and reported. Lane V-FRW-019-036: criterion 1 is tested in part on PostgreSQL in Podman by `services/document-service/test/postgres/v-frw-019-036.purge-chain.pg.test.ts` (1 test): a purge removes the two expired evidence rows, and the commit log, its head and `logs.verify` are the same as before. The sealed PDF is not built (FRW-049, FRW-050), so criterion 1 stays unticked; criterion 3 (erasure with tombstones) is not built. Lane V-FRW-037-054 (2026-11-13): the sealed PDF of FRW-054 now exists in the store, so criterion 1 is ticked on the evidence above; the sealed PDF step is the store's, not the export's. Criterion 3 is still not built. Evidence audit (2026-11-13): criterion 4 was unticked because its erasure half has no code and no test (only the purge writes an audit entry, with counts and no identifiers), so it is met for a purge only; criterion 2 stays ticked on the job's `legalHold` input, but the stored holds of `control-plane/holds.ts` are not read by the purge and nothing yet calls `runEvidencePurge` in a service.

## Signing ceremony (12 §8.1)

### FRW-044 Accept the consent text before signing

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Participant |

**Spec:** 12 §6.1 (`consent`), §7, §8.1 step 1, §10 · **Requirements:** R13, R11 · **Depends on:** FRW-025, FRW-038, FRW-040

As a participant, I want to read and accept the consent text before I sign, so that I know what I am agreeing to and my acceptance is on record.

**Acceptance criteria**

- [ ] Given I begin the ceremony, then the consent text named by the workflow's `consent` (`textId` and `version`) is shown before any signing action, and signing is unavailable until I accept it by an explicit action that is not pre-selected.
- [ ] Given I accept, when the client calls the participant's consent endpoint, then the service records the text identifier, the version, the hash of the text it holds and the server time, and the client cannot supply the hash.
- [ ] Given a sign request from a participant with no recorded acceptance, then it is refused.
- [ ] Given a screen reader or keyboard only, then the text is readable in full and the accept control is reachable and named.
- [ ] Given I do not accept, then I can decline instead (FRW-033).

**Notes:** Where consent texts are stored, authored and localised is not specified, and nor is enforcement of consent at the sign endpoint (inferred from "the acceptance is recorded"); see Open questions. Authority side, lane authority-4 (round 2, 2026-11-13): `packages/authority/src/workflow/consent.ts` gives `recordConsent` (the hash is computed on the server from the held text; the function takes no client hash) and `checkConsentForSign` (refuses without an acceptance, for another participant, version or text). Tested in `packages/authority/test/consent.test.ts`. Not met, so nothing is ticked: criteria 1 and 5 are the client's, criterion 2 and 3 need the consent and sign endpoints, which are not built, and criterion 4 is the client's. Proposal, not decided: a changed text refuses an earlier acceptance (ADR 0148, item 1).

### FRW-045 Adopt a signature

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Participant |

**Spec:** 12 §8.1 step 2, §3.3, §11; 05 §6.2 · **Requirements:** R13, R11 · **Depends on:** FRW-044, PRO-061, PRO-062

As a participant, I want to adopt a signature by typing it, drawing it or uploading it, so that I can sign in the way that suits me, and never have to draw.

**Acceptance criteria**

- [ ] Given the adoption step, then "typed" is selected by default and works from the keyboard; "drawn" and "uploaded" are offered as alternatives.
- [ ] Given I choose "uploaded", then the image goes through the asset worker like any other upload (quarantine, validation, re-encoding, hashing, storage) and cannot be used until `asset.ready`; given `asset.failed`, then it is refused with a message.
- [ ] Given I adopt a signature, then it becomes an asset attached to the document and the value that will be written is `{ asset, mode }` with `mode` `typed`, `drawn` or `uploaded`; the hash of the image is recorded in the evidence (FRW-040).
- [ ] Given I also need initials, then the same step adopts them separately.
- [x] Given a participant with `fill`, then they may upload the asset (upload needs `edit`, `suggest` or `fill` somewhere in the document).
- [ ] Given the typed signature, then the preview is shown in text form to assistive technology.

**Evidence:** `packages/authority/test/matrix.test.ts`, "reads "somewhere in the document" as at least one scope": a connection whose role grants `fill` on an inherit region is allowed `asset.upload`, and a commenter is refused. The row is `asset.upload` (row 6) in `packages/authority/src/permissions/matrix.ts`.

**Notes:** How a typed name becomes the `asset` the value requires (which font, rendered by whom) is not specified (Open questions). Authority-4 (2026-11-13): criterion 3 is partly met (the value shape `{ asset, mode }` is validated in `packages/model/src/fields/values.ts`), but the image hash in the evidence needs FRW-040 and the asset store, so it stays open. Criteria 1, 2, 4 and 6 are the editor's and the asset worker's.

### FRW-046 Sign signature and initials fields

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Participant |

**Spec:** 12 §8.1 step 3, §3.3, §4.2 (P7, P8), §10, §14; ADR 0013 · **Requirements:** R13, R10 · **Depends on:** FRW-009, FRW-022, FRW-044, FRW-045

As a participant, I want to sign each of my signature and initials fields, so that the signature is written by the server and cannot be forged or backdated.

**Acceptance criteria**

- [ ] Given I have accepted the consent and adopted a signature, when I activate a signature or initials field assigned to my role, then the component calls `POST /documents/{id}/fields/{fid}/sign`.
- [ ] Given the call, then the service checks the P7 conditions for that field (the assignee is one of my roles, I am active, the field is visible and enabled) and that its kind is `signature` or `initials`; given any condition fails, then the request is refused.
- [ ] Given the checks pass, then the service writes the field's `{ asset, mode }` in a server-authored commit with origin `sign` and, in the same commit, sets every `dateSigned` field assigned to the same role to the current date in the workflow's `timeZone`, taken from the server clock and never from the client.
- [ ] Given the signing, then the evidence records the `seq` and chain hash of the signing commit (FRW-040), and `field_completed` is raised.
- [ ] Given the same request is repeated with the same `Idempotency-Key`, then one commit is written.
- [ ] Given a field of another role, a participant who is not active, or a field hidden by a rule, then the request is refused and nothing is written.
- [ ] Given a `dateSigned` date near midnight where the workflow's time zone differs from the server's, then the stored date is the date in the workflow's time zone.

**Evidence:** `packages/authority/test/sign.test.ts`, "a dateSigned value is the date in the workflow time zone (FRW-046 criterion 7)": `signedDate` (`packages/authority/src/permissions/sign.ts`) gives 2026-11-07 for 2026-11-06 23:30 UTC in Asia/Tokyo and 2026-11-06 in America/Los_Angeles; a property over 1970 to 2100 checks the UTC case against the ISO date. The write of the value by the signing commit is not built (see Notes). Unticked by the round 1 review: `signedDate` is imported only by its own test, no commit stores the date, so the criterion about the stored date is not met yet.

**Notes:** Authority side, lane authority-4: `checkSign` (P7 conditions with the signature and initials kinds), `fieldsToDateSign` (the dateSigned fields of the role) and `signedDate` are in `packages/authority/src/permissions/sign.ts`, tested in `packages/authority/test/sign.test.ts`. Not met: criteria 1 to 6, because the sign endpoint, the server-authored commit with origin `sign`, the refusal response, the `seq` and chain hash in the evidence and the idempotency of a repeated request are not built; criterion 2 and criterion 4 are checked by `checkSign` only. Pitfall (12 §14): time. P7's kind exclusion applies to fills, so the sign endpoint checks the other P7 conditions. When a role has several signature fields, each sign commit sets the `dateSigned` fields of that role; confirm whether a later signing overwrites the date.

### FRW-047 Complete my part of the workflow

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Participant |

**Spec:** 12 §5.3, §6.2, §8.1 step 4, §10 · **Requirements:** R13 · **Depends on:** FRW-022, FRW-030, FRW-031, FRW-035, FRW-036, FRW-046

As a participant, I want to complete my part, so that the workflow moves on and the document keeps only valid values.

**Acceptance criteria**

- [ ] Given I am active and call the participant's `/complete` endpoint, then the service checks the required fields (static `required` and the `require` effects) and the validations (static limits, patterns and `validate` effects) of the fields visible to my roles; given any fails, then completion is refused with a problem listing each field key and the rule or validation, and I stay active.
- [ ] Given every check passes, then in one server-authored commit with origin `rules` the service writes the formula results and clears the values of hidden fields, and then marks me completed with `completedSeq` and a control commit.
- [ ] Given a hidden field that holds a value, then after completion its value is null.
- [ ] Given I complete, then `participant_completed` is raised, the next order is activated if any, and the last participant's completion moves the workflow to `completed`.
- [ ] Given the `rules` commit is retried or the process stops in between, then it is applied exactly once.
- [ ] Given I have already completed, then a second call changes nothing.
- [ ] Given a participant of kind `approver`, then completing is approving; there are no fields to check.

**Notes:** Lane FRW-040-052, round 1 (2026-11-13): `packages/authority/test/completion.approver.test.ts` checks criterion 7's check: an approver role that owns no field passes while a tenant's required field is empty, and the tenant still refuses. No criterion ticked, because the `/complete` endpoint and the approve action are not built. Authority side, lane authority-4: `completionCheck` (required, static validation and `validate` messages of the participant's visible fields, through `@docedit/rules`) and `hiddenValuesToClear` are in `packages/authority/src/workflow/completion.ts`, tested in `packages/authority/test/completion.test.ts`; no criterion is ticked because the `/complete` endpoint, the `rules` commit that writes the formula results and clears hidden values, the refusal response, the `participant_completed` event and the exactly-once retry are not built. 12 §5.3 says the check covers "required fields and validations" and does not say whether that means the participant's fields or all fields; the criteria read it as the participant's own fields, because later participants' fields are still empty. A `completed` version is created at the final `completedSeq` (08 §4). The code of the refusal problem is not named by 12 (the registry has `validation_failed`).

### FRW-048 Sign without drawing or a pointer

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Participant |

**Spec:** 12 §11 (accessibility), §14; PRODUCT (accessibility) · **Requirements:** R13, R11 · **Depends on:** FRW-044, FRW-045, FRW-046, FRW-047

As a participant who uses only a keyboard or a screen reader, I want to complete the whole ceremony without drawing or using a pointer, so that signing does not exclude me.

**Acceptance criteria**

- [ ] Given only a keyboard, when I read and accept the consent, choose a typed signature, sign every signature and initials field and complete, then every step is reachable and operable, focus is visible and never trapped, and Escape leaves the editing surface.
- [ ] Given a screen reader, then each step announces its result through a live region (consent accepted, "signed 2 of 3", completed), and every control has an accessible name.
- [ ] Given the default signature mode is typed, then no step requires drawing and the drawing canvas has a typed alternative.
- [ ] Given a signed, unsigned, required or other-role field, then its state is conveyed by text or icon as well as colour, and in `forced-colors` mode system colours are used.
- [ ] Given one-time or access-code inputs that the component hosts, then they accept paste.
- [ ] Given every ceremony screen, then axe reports no violations, controls meet the target-size criterion, and the layout reflows at 200 per cent zoom in the web view.

**Notes:** Host-side one-time passcode pages are the host's responsibility (12 §7).

## Final PDF and sealing (12 §8.2)

### FRW-049 Produce the final PDF at completion

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Owner |

**Spec:** 12 §8.2 step 1, §6.1 (`finalisation`), §6.2, §12 · **Requirements:** R13, R5 · **Depends on:** FRW-047, EXP-033, EXP-004, EXP-070

As an owner, I want the final PDF produced automatically when the last participant completes, so that the result is the document exactly as it stood at completion.

**Acceptance criteria**

- [ ] Given the workflow reaches `completed`, when finalisation triggers, then an export job is created at `completedSeq`, pinned to that `seq`, with field values flattened into the text and, when `finalisation.certificate` is true, certificate pages appended.
- [ ] Given the job, then it is the document at `completedSeq` that is typeset, not a later head, and a `completed` version points at it.
- [ ] Given the compile fails, then the workflow stays `completed` and not `finalised`, the failure and its diagnostics are visible to the owner and the operator, and `finalised` is not raised.
- [ ] Given `completed` is reached, then `completed` is raised; given the sealed PDF is stored, then `finalised` is raised (FRW-054).
- [ ] Given `finalisation.certificate` is false, then no certificate pages are appended.

**Evidence:** `packages/authority/test/workflow.finalisation.test.ts`, "raises completed and then finalised when every step succeeds" (criterion 4 at the gate: `completed` is always raised first, `finalised` only once the sealed bytes are stored), and the property "finalised iff compile, seal (timestamped) and store all succeed". The gate is `packages/authority/src/workflow/finalisation.ts` (`finaliseWorkflow`), exported from `packages/authority/src/index.ts` (round 3 fix); the test imports it from the package entry.

**Notes:** Lane FRW-040-052, round 1 (2026-11-13): `packages/authority/src/workflow/final-export.ts` (`finalExportRequest`) gives the export request: pinned to `completedSeq`, fields flattened, profile `final`, certificate pages only when `finalisation.certificate` is true. An absent option reads as false (ADR 0250 item 2; the spec gives no default). Only a `completed` workflow yields a request. Tested in `packages/authority/test/final-export.test.ts`. No criterion ticked: the export job is not created (criterion 1), the typesetting of `completedSeq` and the `completed` version are the export's and the workflow service's (criterion 2), and the certificate pages are EXP's (criterion 5). Evidence audit (2026-11-13): criterion 4 unticked, because no code raises `dep.workflow.completed` or `dep.workflow.finalised` (`finaliseWorkflow` only returns a `raised` list, and only tests call it), and FRW-054 criterion 2, which holds the same "`finalised` is raised" clause, is rightly unticked for that reason. Round 3 review: nothing yet acts on `raised` (`['completed', 'finalised']`); the workflow service that raises the events from it is not built. Criterion 4 is met at the gate only (`finaliseWorkflow` in `packages/authority/src/workflow/finalisation.ts`); the compile, the seal and the store are the export's, the signing service's and the store's. Not met: criteria 1, 2 and 5 (the export job, the pinned `seq`, the certificate pages) and the visibility part of criterion 3 (the diagnostics are returned; showing them is the service's). Failure handling and retry are not specified; the gate stops at the first failed step and returns no retry (Open questions 26; ADR 0148). Compile cost with tagging on is unmeasured (spike S4). Second review (2026-11-06, SPK-027), SR-M3: under ADR 0019 one final PDF with every value flattened would show participants what is hidden from them; the review recommends one sealed full PDF for the owner, a sealed rendering of each participant's projection for that participant, and evidence that records the projection each signer saw (owner decision) ([review](../review/2026-11-06-second-review.md)).

### FRW-050 Add a certificate of completion

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Relying party |

**Spec:** 12 §8.2 step 1, §1.1, §7; 09 §4, §9.1 · **Requirements:** R13, R5, R11 · **Depends on:** FRW-040, FRW-049, FRW-058, EXP-002, EXP-005, EXP-033, EXP-042, EXP-043

As a relying party, I want certificate pages that list the identifiers, the sequence numbers, the chain-head hash and each participant's events, so that I can match the PDF to the evidence.

**Acceptance criteria**

- [ ] Given a completed workflow, then the certificate shows the document and workflow identifiers, `sentSeq`, `completedSeq`, the chain-head hash and, for each participant, their events (viewed, consent, signed, completed, declined) with server times.
- [ ] Given the option `certificate`, when the final export of a completed workflow runs, then certificate pages are appended after the body, the body's pagination does not change, and the export uses `completedSeq`, `fields` set to `flatten` and the `final` profile.
- [ ] Given the certificate is generated LaTeX built from the evidence, then it is produced only through the typed emitters of 09, with no raw interpolation.
- [ ] Given a participant name or any evidence string that contains TeX control sequences or markup, then the certificate compiles and prints it literally.
- [ ] Given a tenant has switched off IP address and user agent capture, when the certificate is generated, then those items are absent.
- [ ] Given the certificate pages, then they are tagged and accessible like the body.
- [ ] Given the certificate, then its wording follows the rules of FRW-058 and describes the authentication of a participant as asserted by the host, never as verified identity.

**Notes:** Evidence is personal data (12 §7); what the certificate shows is this epic's decision, and the typesetting rules of the pages are EXP's. This story absorbed EXP-080 during the cross-check. Authority-4 (2026-11-13): `buildCertificateFacts` (`packages/authority/src/workflow/certificate.ts`) gives the facts the pages print, checked and ordered, with the network identity absent while the capture setting is off, and `CERTIFICATE_STATEMENT` gives the fixed sentences; tested by `packages/authority/test/workflow.certificate.test.ts`. Not met: (1) and (6) need the pages, which are EXP's and are not built, so they stay open; the data half is met only. (2) to (4) are the export's (option `certificate`, the `final` profile, typed emitters, escaping of TeX). (5) is the pages' tagging. (7) is met for the fixed sentences only; the wording of the pages is not built and counsel's review (FRW-087) has not taken place.

> FRW-051 (Compare two independent compiles before sealing) was merged into EXP-079 during the cross-check of 2026-11-06.

### FRW-052 Run a signing service that holds the keys

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | L | must | Operator |

**Spec:** 12 §8.2 step 3, §8.3; ADR 0013; 10 §1, §3.6 · **Requirements:** R13, R10 · **Depends on:** SPK-021

As an operator, I want a signing service that is separate from the document service and every worker and that uses keys held in a hardware security module or a cloud key service, so that a stolen worker or a stolen database cannot seal a document.

**Acceptance criteria**

- [ ] Given the deployment, then the signing service runs as its own service in its own trust boundary, and no export or LaTeX worker has a credential for it or access to its keys.
- [ ] Given the signing keys, then they are held in a hardware security module or a cloud key service, are not exportable, and no private key material is present in the service's images, disk or logs.
- [ ] Given a request to seal, then only the document service can make it, the request is authenticated, bound to a document, `seq` and PDF hash, rate limited and written to an audit log.
- [ ] Given a tenant, then the key used for sealing is selected per tenant from configuration (the operator's key or the tenant's own key).
- [ ] Given the signing service is unavailable, then finalisation waits and retries, the workflow stays `completed`, and the operator is alerted.

**Notes:** Who the sealing party is (operator or tenant) is an owner decision (SPK, 11 §10 item 11). The key-management details for tenant-owned sealing keys are open (10 §3). Authority-4 (2026-11-13): the pure rules are in `packages/authority/src/workflow/sealing.ts` (`selectSealingKey`, the operator's key unless the tenant has its own, with an empty key refused; `checkSealRequest`, the caller, document, `seq` and PDF hash binding), tested by `packages/authority/test/workflow.sealing.test.ts`. Not met: criterion 4 is the selection only, with no signing service to seal with it; criterion 3 needs the request's authentication, rate limit and audit, which are the service's; criteria 1, 2 and 5 need the service, the key store and the trust boundary, none of which is built here.

### FRW-053 Seal the final PDF with a time-stamp

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Relying party |

**Spec:** 12 §8.2 step 3, §6.1 (`finalisation.seal`), §14; ADR 0013 · **Requirements:** R13, R10 · **Depends on:** EXP-079, FRW-052, SPK-021

As a relying party, I want the final PDF sealed with a PAdES signature and an RFC 3161 time-stamp, so that any later change is detectable and the time is vouched for by a third party.

**Acceptance criteria**

- [ ] Given two identical compiles, when the signing service seals, then the PDF carries a PAdES signature of the profile chosen by spike S8 and the workflow's `finalisation.seal`, and an RFC 3161 time-stamp token.
- [ ] Given the sealed sample, then it validates in Acrobat and in an independent validator with the seal intact.
- [ ] Given any byte of the sealed PDF changed afterwards, then the validators report the signature as broken.
- [ ] Given the seal certificate, then it is the operator's or the tenant's, not a certificate for any signer, and no text in the PDF says otherwise.
- [ ] Given the time-stamping authority is unreachable, then no seal without a time-stamp is produced, the workflow stays `completed` and the operator is alerted.
- [ ] Given the evidence times and the seal, then evidence times come from the server clock and the seal's time from the time-stamp token.

**Notes:** Criterion 5 is partly met at the gate: `finaliseWorkflow` refuses a seal without a time-stamp and an unreachable time-stamping authority, and keeps the workflow at `completed` (`packages/authority/test/workflow.finalisation.test.ts`). The operator alert is the workflow service's, so criterion 5 stays unticked. Criteria 1 to 4 need the signing service and the PDF and are not met. 12 §8.2 names baseline B-LT or B-LTA at sealing, while 12 §13 puts long-term validation in phase 4; see Open questions and FRW-056. S8's exit criterion fixes the profile. Second review (2026-11-06, SPK-027), SR-K8: the review recommends B-LT at sealing from phase 2 (validation data collected while the certificates are current), and B-LTA archive time-stamps with their renewal in phase 4 (FRW-056); owner to decide ([review](../review/2026-11-06-second-review.md)).

### FRW-054 Store the sealed PDF immutably and anchor the chain head

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Operator |

**Spec:** 12 §8.2 step 4, step 5, §6.2; 06 §4.2; 08 §12 · **Requirements:** R13, R4, R10 · **Depends on:** FRW-053, FRW-030, BE-003

As an operator, I want the sealed bytes stored immutably and the chain head written to write-once storage, so that the result cannot be replaced and its place in the history can be proved.

**Acceptance criteria**

- [x] Given sealing succeeds, then the sealed bytes are stored in write-once storage under the tenant, overwriting or deleting them is refused for the retention duration, and their hash is recorded.
- [ ] Given the bytes are stored, then the workflow moves from `completed` to `finalised`, a control commit is written and `finalised` is raised; given the store fails, then the workflow stays `completed`.
- [ ] Given the chain head at completion, then a signed, time-stamped head is written to write-once storage.
- [ ] Given `GET /documents/{id}/workflow/final`, when an authorised caller asks, then it returns the sealed PDF (or a signed URL with an expiry) and its hash.
- [ ] Given the sealed PDF, then no operation rewrites it.

**Evidence:** `services/document-service/test/objects/frw-054-sealed-store.test.ts` (6 tests, Node.js 22.18 against the Versity S3 Gateway of the test environment, in Podman; bucket with Object Lock created and removed by the test, name includes U-FRW-037-054): the sealed bytes are written under `objectKeys.final` for the tenant with Object Lock (`storeSealedPdf` in `services/document-service/src/objects/sealed-pdf.ts`), an overwrite (403) and a delete (403) are refused while the retention lasts, a second write for the same workflow is refused, and a store to a missing bucket gives `store_failed`, which `finaliseWorkflow` turns into `completed` with `raised` `['completed']` (criterion 2, at the gate). Criterion 1 end to end (fixer V-UX-031-045, V group 3 round 1, after the reviewer unticked it): `storeAndRecordSealedPdf` (`services/document-service/src/workflow/sealed-pdf-finalise.ts`) stores the sealed bytes, reads them back, hashes what was read and records that hash with `recordSealedPdf`; `services/document-service/test/postgres/frw-054.v-ux-031-045.store-and-record.pg.test.ts` (4 tests, run with `pnpm vitest run --project node` on that file on 2026-11-13, PostgreSQL and the Versity S3 Gateway in Podman, none skipped; own database and Object Lock bucket named with V-UX-031-045, removed afterwards) shows the record read back from PostgreSQL equals the hash of the original bytes and of the bytes read from the store, with the object key and retention end, that an overwrite and a delete are refused (403), and that nothing is recorded, and the gate stays at `completed`, when the store fails, when the stored bytes differ from the sealed hash, or when the record is refused. No workflow service calls it yet (criterion 2). The table test is `services/document-service/test/postgres/frw-054.v-frw-037-054.sealed-record.pg.test.ts` (5 tests, PostgreSQL in Podman, run with `pnpm vitest run` on that file; lane V-FRW-037-054): table `workflow_sealed_pdf` (`services/document-service/migrations/0061_workflow_sealed_pdf.sql`, `services/document-service/src/workflow/sealed-pdf-pg.ts`) records the hash of the stored bytes once per workflow, refuses a record whose stored hash differs from the sealed hash, keeps one tenant's record from another tenant's reads, and gives the service role no update and no delete. Criteria 2 and 5 stay unticked: no control commit records the hash or raises `finalised` (criterion 2), and no read endpoint exists (criterion 4).

**Notes:** Lane U-FRW-037-054 (2026-11-13): criteria 1 and 2 are partly proven, at the store and the gate (see Evidence). Criterion 3 (signed, time-stamped chain head written once) is not built. Criterion 4 (`GET /documents/{id}/workflow/final`) waits for the document service's workflow routes, and the caller policy is open (Open questions). Who may call `/workflow/final` is not stated (Open questions). Criterion 2 is met at the gate only: `finaliseWorkflow` (`packages/authority/src/workflow/finalisation.ts`) keeps the workflow at `completed` when the store fails, and raises `finalised` only when the stored hash equals the sealed hash (`packages/authority/test/workflow.finalisation.test.ts`). The control commit and the write of `finalised` are the workflow service's, so criterion 2 stays unticked; criteria 1, 3, 4 and 5 are the store's and the service's (see ADR 0148).

### FRW-055 Export an evidence bundle for third-party verification

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Relying party |

**Spec:** 12 §8.2 step 4, §10; 08 §12; 11 §5 (exit criteria) · **Requirements:** R13, R4 · **Depends on:** FRW-041, FRW-053, FRW-054, HIS-002, HIS-033

As a relying party, I want an evidence bundle that I can verify without the operator's help, so that I can check the history and the seal for myself.

**Acceptance criteria**

- [ ] Given a finalised workflow, when an authorised caller requests `GET /documents/{id}/workflow/evidence`, then the response is a bundle holding the log segment, the control commits, the evidence record and verification instructions.
- [ ] Given only the bundle and the sealed PDF, when a third party follows the instructions with the verification tool, then they can confirm the chain over the segment, that the chain-head hash in the certificate matches, that the PDF's signature and time-stamp are valid, and that the salted evidence hashes match the chain.
- [ ] Given a bundle with one commit or one evidence item altered, then verification fails and names the item.
- [x] Given a segment with erased payloads (tombstones), then it still verifies.
- [x] Given the instructions, then they state what the evidence proves and what it does not, and make no claim of verified identity.
- [ ] Given a retrieval, then it is audited and requires the credential the authorisation matrix assigns, because the bundle holds personal data.

**Evidence:** `packages/authority/test/workflow.bundle.test.ts`, "the bundle names every evidence item that does not verify" (criterion 3, for evidence items only: an altered item or commitment fails and is the one named; the commit half is the history service's, so the criterion stays open) and "the instructions state what the evidence proves and what it does not" (criterion 5). Source: `packages/authority/src/workflow/bundle.ts`, `packages/authority/src/workflow/language.ts`.

**Evidence (lane V-FRW-055-072, criteria 3 and 4, 2026-11-13):** `packages/history/test/frw-055.bundle-tamper.test.ts` (run with `pnpm vitest run packages/history/test/frw-055.bundle-tamper.test.ts packages/history/test/tombstone.test.ts`, 9 of 9 passed, Node.js): an altered commit payload and an altered stored hash are named by the log verifier (`altered`, `firstBadSeq`), an altered evidence item is named by the evidence verifier (`failed`), and a segment with two tombstoned payloads still verifies with no problems. Criterion 3 stays unticked: there is still no single command that runs both verifiers, and the log segment's chain verification is the history service's. Criterion 4 is ticked.
**Notes:** Phase 2 exit: "a complete workflow ends in a sealed PDF that validates, with an evidence bundle that a third party can verify". The capability required to fetch the bundle is open (07 §12 has no row). Authority-4 (2026-11-13): `buildBundle`, `verifyBundle` and `BUNDLE_INSTRUCTIONS` (`packages/authority/src/workflow/bundle.ts`) cover the evidence items and the instructions only. Not met: (1) and (2) need the PDF, the signature and the time-stamp verification tool; (3) for commits needs the log segment and the chain (HIS, and ADR 0148 round 3 notes that `@docedit/authority` does not depend on `@docedit/history`); (4) tombstones are the history service's; (6) the endpoint and its audit are the workflow service's. The instructions use the phrase lists of FRW-058. Lane U-FRW-055-072, round 4 (2026-11-13): no criterion ticked. Criterion 3 for commits and criterion 4 need `@docedit/history` from `@docedit/authority`, which has no such dependency (`packages/authority/package.json`); a package.json change is the main session's. See docs/adr/0342-lane-U-FRW-055-072.md, item 1.

### FRW-056 Add long-term validation and renew time-stamps

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | L | should | Operator |

**Spec:** 12 §8.2 step 5, §13, §14; ADR 0013 · **Requirements:** R13, R10 · **Depends on:** FRW-053, FRW-054, SPK-021

As an operator, I want long-term validation data added and time-stamps renewed on a schedule, so that a sealed PDF stays verifiable after certificates and time-stamps expire.

**Acceptance criteria**

- [ ] Given a sealed PDF, when the long-term validation job runs, then validation data is added only as an incremental update appended after the sealed bytes; the original byte range is unchanged and the original signature still validates.
- [ ] Given a scheduled job, then it renews the time-stamp before the current one expires by appending a further time-stamp as an incremental update.
- [ ] Given an update, then the originally sealed object stays stored byte for byte, the updated file is stored as a further object that begins with those bytes, and `/workflow/final` returns the latest.
- [ ] Given each update level, then Acrobat opens it and shows it valid, and the certification levels are tested.
- [x] Given a renewal fails, then the failure is visible to operators while time remains and the job is retried; running twice does not add two time-stamps for one expiry.

**Evidence (criterion 5, lane V-FRW-055-072, 2026-11-13):** `services/document-service/test/control-plane/frw-056.renewal-handler.pg.test.ts`, four tests on PostgreSQL in the shared Podman container (`pnpm exec vitest run services/document-service/test/control-plane/frw-056.renewal-handler.pg.test.ts`: 4 passed, none skipped). The job queue runs the renewal through `JobRunner` (`services/document-service/src/control-plane/jobs/workflow-renewal.ts`, `renewalHandler`, which uses `planRenewal` and `applyRenewalResult`): one renewal for one expiry however often the job is enqueued, and the signer asked once; two runs racing for one expiry record one renewal (the compare and set on the expiry); a failed renewal is recorded on the job (`error.code` `renewal_failed`), the job is queued again and the second attempt renews, with the chain unchanged after the failure; no retry after the expiry, the job fails with `expired`. The operator alert is the failed job and its error, not a notification channel, which is not built. Review (round 2, V3 group 2): criterion 5 unticked. The compare and set that the test relies on is a table and an UPDATE written inside the test file, not product code, and the earlier note says the criterion holds only once the store enforces it atomically, which is not built. In the race test the signer is asked twice (both scripted answers are consumed) and only the recorded expiry is kept; in production the signer's call is what appends a time-stamp to the PDF, so two would be added. The handler needs a claim before the signer call (or an idempotent signer), and a real store. The handler and its four tests stand as evidence for the job wiring; tick criterion 5 when the store is the workflow service's and the signer is asked once per expiry. Fix (round 2, V3 group 2, 2026-11-13): criterion 5 ticked again. The handler now claims the expiry before it asks the signer (`RenewalStore.claim`, one atomic UPDATE), so only the claim's holder reaches the signer, and moves the expiry by a compare and set made by that holder (`swap`); a failed renewal releases the claim for the retry. The store is product code, `services/document-service/src/workflow/renewal-state-pg.ts` (`PgRenewalStore`), with migration `services/document-service/migrations/0068_frw_056_renewal_state.sql` (table `workflow_renewal_state`, row-level security, the test database gets it from the migrations). The same test file now holds six tests (`pnpm exec vitest run services/document-service/test/control-plane/frw-056.renewal-handler.pg.test.ts`: 6 passed, none skipped, on PostgreSQL in the shared Podman container, 2026-11-13). The race test runs six handlers at once against one expiry, holds the winner at the signer until every claim has been answered, and asserts `signer.calls === 1` and code `stale` for each of the five losers, refused while the winner held the claim. Further tests: a failed renewal releases the claim and the retry asks again with the same idempotency key; a claim left by a run that died keeps the signer away until it lapses; another tenant can neither claim nor move the chain.

**Notes:** Pitfalls (12 §14): PDF signature validity after later changes; long-term validation. The seal profile is set by S8 (FRW-053). Lane authority-4, round 6: the renewal rules are a pure core in `packages/authority/src/workflow/renewal.ts` (`planRenewal`, `applyRenewalResult`), tested by `packages/authority/test/workflow.renewal.test.ts` (6 tests, fast-check). It covers the lead window (criterion 2 planning; the lead time is a parameter with no default, as the spec gives none), one time-stamp per expiry as a compare and set on the expiry, and a visible, retried failure while time remains (criterion 5). Not met: (1) and (3) the incremental update, the byte-for-byte prefix and `/workflow/final` are the export's and the store's; (2) the append itself and its Acrobat check need the PDF tooling and a browser-free viewer run; (4) the certification-level tests need the signing service; (5) the compare and set holds only once the store enforces it atomically, which is not built. Nothing ticked. Lane U-FRW-055-072, round 5 (2026-11-13): `services/document-service/test/control-plane/frw-056.renewal-queue.pg.test.ts` (PostgreSQL in Podman, 2 tests passed) shows that the job queue's `ifAbsent` enqueue keyed by document and expiry adds one renewal per expiry. That is the database's guarantee for one job, not the renewal: `planRenewal` is not wired to the queue, so criterion 5 stays open. Lane V-FRW-055-072, round 2 (2026-11-13): criterion 5 ticked (see its Evidence line); the renewal is wired to the queue. Its compare-and-set store is a PostgreSQL table made in the test only; the production store and its migration are the workflow service's and are not built. Criteria 1 to 4 are unchanged. Fix, round 2 (V3 group 2): the store and migration 0068 are now built (see the Evidence line). Open: a claim lapses after `claimMs` (a setting with no default; the spec gives none), and a run that asks after a lapse sends the same idempotency key (`renewalJobId` of document and expiry), so one time-stamp per expiry in that case also depends on the signing service honouring the key. That service is not built; its port `RenewalSigner` states the rule. The schema test `services/document-service/test/postgres/schema.pg.test.ts` lists every table by name and count and already failed before this lane's table was added (other lanes' tables); it now also lists `workflow_renewal_state` as unexpected.

### FRW-057 Show visible signature appearances at the field positions

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 3 | M | could | Relying party |

**Spec:** 12 §12 (PDF), §13 (phase 3); 09 §3.1, §7.1, §9.3 (rule 7) · **Requirements:** R13, R5 · **Depends on:** FRW-053, EXP-058

As a relying party, I want visible signature appearances placed where the signature fields are on the page, so that the sealed PDF shows who signed where.

**Acceptance criteria**

- [ ] Given a PDF export of a document with fields, then `layout.json` holds an entry for every field with its identifier, key, page and rectangle.
- [ ] Given the rectangles, when a document is sealed, then the signing service draws a visible appearance inside the rectangle of each signature and initials field.
- [ ] Given `layout.json`, then it is validated against its schema before use, and a rectangle outside the page bounds is not used.
- [ ] Given visible appearances are added, then the two-compile comparison of EXP-079 is unaffected, because the appearances are added after the compile.

- [ ] Given the appearance, then the sealed PDF still validates in Acrobat and in an independent validator.
- [ ] Given a field with no rectangle in `layout.json`, then the seal is still applied and the missing appearance is reported as a diagnostic.

**Evidence:** none ticked. Review (round 3): `packages/authority/test/workflow.appearance.test.ts` shows that `planAppearances` reports a missing rectangle as a diagnostic (the second half of the last criterion), but "the seal is still applied" is asserted only against the constant `sealApplies: true`, and nothing calls the planner. The criterion stays open until the signing service applies the seal. Fix (round 3): the constant `sealApplies` field is removed from `AppearancePlan`; the tests now cover only what the planner does: "gives each field with a rectangle its appearance and each field without one a diagnostic (property)" (300 runs over 8 fields) and "never throws and draws only signature and initials fields, whatever the layout holds (property)" (each wanted field is drawn or reported, never both, never neither). `planAppearances` and `validateLayout` are exported from `packages/authority/src/index.ts`, and the test imports them from there.

**Notes:** Criterion 3 is met for its rectangle clause only: `validateLayout` checks the `fields` part of `layout.json` and drops a bad entry; the whole file is validated against its schema by the export (09 §9.3), which is not built here, so the schema clause stays unticked (`packages/authority/test/workflow.appearance.test.ts`). Criteria 1, 2, 4 and 5 are the export's and the signing service's. Phase 3 by 12 §13. What an appearance shows (the adopted image, the name, the date) and whether it belongs to each participant or to the seal is not specified (Open questions). `layout.json` precision depends on spike S4.

## Legal stance (12 §8.3)

### FRW-058 Keep signing language within the legal stance

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | S | must | Maintainer |

**Spec:** 12 §8.3; ADR 0013; PRODUCT (brand commitments); 11 §9 (risk 15) · **Requirements:** R13 · **Depends on:** none

As a maintainer, I want a check that no interface text, document, certificate or marketing copy over-claims what a signature means, so that the product never says more than a simple electronic signature with evidence and a seal.

**Acceptance criteria**

- [ ] Given all interface strings, documentation, API descriptions, the certificate template and marketing copy in the repository, when CI runs the wording check, then none contains "qualified" in the sense of a signature level, "legally binding everywhere" or similar phrases from a maintained list, and a match fails the build.
- [x] Given the product describes what it provides natively, then the text says: a simple electronic signature with an audit trail and a tamper-evident seal applied by the operator or by the tenant's own key.
- [x] Given the integration guide, then it states that advanced and qualified signatures are reached through a `SignatureProvider` adapter, and that whether a use is valid in a jurisdiction is a legal question for the operator and its customers.
- [x] Given the documentation, then it states how the ceremony and the evidence record address intent, consent and retention (ESIGN and UETA) without claiming validity.
- [x] Given any text that mentions a participant's authentication, then it says "as asserted by the host" and never "verified".

**Evidence (lane w4, 2026-11-17):** `packages/authority/test/frw-058.integration-guide.test.ts` (vitest, Node.js 22.18, 5 of 5 passing): the signing section of `apps/reference-host/docs/integration-guide.md` ("Signing and identity (FRW-058; 12 section 8.3)") carries the native description of `NATIVE_SIGNING_DESCRIPTION` (criterion 2), names `SignatureProvider`, the hash-only send and the operator's legal question (criterion 3), names ESIGN and UETA with intent, consent and retention and no validity claim (criterion 4), says "as asserted by the host" with no "verified" participant wording (criterion 5), and `findOverclaims` finds no phrase of the list in it. Criterion 1 not run here, see Notes.

**Notes:** Phase inferred (it must hold before the first signing language ships, which is phase 2). The 12 §8.3 sentence about how Microsoft and others describe comparable features is background, not copy. Counsel review is FRW-087. Authority-4 (2026-11-13): `findOverclaims` and `isWithinLegalStance` (`packages/authority/src/workflow/language.ts`, tested by `packages/authority/test/workflow.language.test.ts`) check text against a maintained phrase list, and the native description and the "as asserted by the host" phrase are constants there. Not met: (1) the repository-wide CI run needs root configuration (`.github/`, `package.json`), which is the main session's, and a decision on existing spec text that uses "qualified" as a term (ADR 0148 round 4); the owner has not decided that term, so the check is not wired into CI. Lane w4 (2026-11-17): criteria 2 to 5 ticked by adding the signing section to the integration guide, which had no such text. Criterion 3 asks the guide to name "advanced and qualified" signatures; the phrase list matches "qualified signature" as a substring, so the guide says "the advanced and the qualified levels" instead, which keeps the same meaning and passes the list. The guide's wording is a proposal written here from spec 12 section 8.3; the owner has not reviewed it, and counsel review (FRW-087) is still open. Criterion 4 describes what the ceremony and the evidence record are designed to address; it does not show that the ceremony records intent or consent in the code.

### FRW-059 Sign through a signature provider

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | L | could | Integrating developer |

**Spec:** 12 §8.3, §13 (phase 4), §1.1; ADR 0013 · **Requirements:** R13, R6 · **Depends on:** FRW-053, PRO-091, PRO-092

As an integrating developer, I want a `SignatureProvider` adapter that signs document hashes remotely, so that a deployment can reach advanced or qualified signatures through a provider without the platform becoming a trust service provider.

**Acceptance criteria**

- [ ] Given a `SignatureProvider` interface with the Cloud Signature Consortium API as its target, when a workflow is configured to use it, then at finalisation only the document hash is sent to the provider and the returned signature is embedded in the PDF.
- [ ] Given a workflow without a provider, then the native seal of FRW-053 is used unchanged.
- [ ] Given the provider, then the signature level and signer identification it reports are recorded in the evidence as asserted by the provider, and the platform's language still follows FRW-058.
- [x] Given a provider failure, then the workflow stays `completed`, the failure is visible, and nothing is half-signed.
- [x] Given a mock provider, then contract tests for the adapter pass.

**Evidence:** `packages/authority/test/workflow.provider.test.ts`, "the signature provider contract (FRW-059 criterion 5)": five adapter behaviours (signs with a time-stamp, unreachable, refuses, invalid response, throws) run against the mock through `sealWithProvider`, and the seal succeeds exactly when it should. Criterion 4, "a provider failure", is tested in "a provider failure leaves nothing half-signed and visible": no sealed outcome, no asserted facts and no embedding after any failure, and `finaliseWorkflow` stops at the seal with `completed`, `alert` true and `signing_unavailable`. Source: `packages/authority/src/workflow/provider.ts`.

**Notes:** `SignatureProvider` is not in the port list of 05 §8.3; adding it is a PRO change. Native advanced or qualified signatures, identity verification and notary roles stay out of scope (12 §13). Authority-4 (2026-11-13): the adapter and its contract are `packages/authority/src/workflow/provider.ts`, proposed in ADR 0148 round 4 as a PRO-level port, not yet in 05 §8.3. Not met: (1) the PDF embedding of the returned signature and the hash-only check on the wire (the request type carries the hash alone, and the test shows it); (2) the native seal is the signing service's, and `sealWorkflow` only chooses it without a provider; (3) the asserted facts are returned by `sealWithProvider` as `assertedBy: 'provider'`, but the evidence tables that record them are the workflow service's. (4) and (5) are ticked above.

## Templates, prefill and bulk send (12 §9)

### FRW-060 Read fields and field values

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 12 §9, §10 (control plane), §3.2 (`key`); 05 §6.1; 07 §8 · **Requirements:** R13, R6 · **Depends on:** FRW-003, FRW-007, PRO-040, PRM-041

As an integrating developer, I want to list a document's fields and read their values by key, so that my application can extract the answers.

**Acceptance criteria**

- [x] Given `GET /documents/{id}/fields`, then it returns the derived list of fields (identifier, `key`, `kind`, `label`, `assignee`, `required`, `readOnly`) as `{ items, nextCursor }` with an `ETag`, and a `limit` of at most 200.
- [x] Given `GET /documents/{id}/field-values`, then it returns the current values by key, as stored (decimal strings stay strings).
- [x] Given `GET /documents/{id}/field-values?seq=N`, then it returns the values as they were at `seq` N, and the response is immutable and cacheable like a pinned content read.
- [x] Given a `seq` below the caller's `minVisibleSeq`, then the request is refused as for content at a `seq`.
- [x] Given a key that does not exist, then the request fails with `not_found`.
- [x] Given a caller who cannot view the document, then the request is refused with `forbidden`; values the caller may not read (ADR 0019) are redacted, and every other value is returned.

**Evidence:** `services/document-service/src/control-plane/fields.test.ts` (memory store; the PostgreSQL run skips without a database). "lists the derived fields as a cursor list with an ETag, at most 200 a page" (criterion 1: eight fields, two a page to the end, `limit` 201 refused); "returns the values by key as stored, decimal strings unchanged, and filters by key" (criterion 2); "answers not_found for a key that does not exist" (criterion 5); "serves a pinned read at the head as immutable, answers 304 to a repeat, and refuses a seq above the head" (the head and `seq` above it only); "refuses a caller who cannot view the document with forbidden" (criterion 6, refusal part). Criteria 4 and 6 (redaction part): `services/document-service/test/control-plane/field-values-gate.test.ts` (memory; PostgreSQL skips without a database; 2026-11-13, passes): "redacts a value the caller may not read and returns every other value" (a non-owner reads `{ redacted: true }` for the hidden field and the number unchanged, the owner reads both, a key read stays redacted) and "refuses a seq below the caller gate as forbidden, and serves the head and the gate above it" (one commit after creation, a viewer of an editors-only document gets 403 at seq 0 and 200 at the head). Criterion 3: `services/document-service/src/control-plane/field-values-seq.test.ts` (memory; PostgreSQL skips without a database; 2026-11-13, passes): a commit with the prefill steps of a text field is appended to the log; the head then shows the new value, and `?seq=` at the earlier seq still shows the old one, twice identically, with `private, max-age=31536000, immutable` and a 304 to its ETag.

**Notes:** Packet C (2026-11-13, round 9): criterion 3 is ticked on `field-values-seq.test.ts`, which pins a read before a value change. Lane FRW-053-065 (2026-11-13): criteria 4 and 6 are ticked on `test/control-plane/field-values-gate.test.ts`, which hides a value by field identifier (the ADR 0019 value class). Hiding a whole region, and the omission of fields inside it from the list, is not tested here. The capability these resources require is not in the authorisation matrix (07 §12); `view` is assumed here and must be confirmed. The values are not a second source of truth: they are read from the tree. Cross-check: reads pinned to a sequence number pass the history-visibility gate of PRM-042 from phase 2; phase 1b serves the head.

### FRW-061 Prefill field values by key

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 12 §9, §10, §14; 04 §10; 06 §2.2; 05 §6.1 · **Requirements:** R13, R10 · **Depends on:** FRW-003, FRW-009, FRW-060, SYN-030

As an integrating developer, I want to set field values by key before a document is sent, so that known data is already in the document when the participant opens it.

**Acceptance criteria**

- [x] Given `PATCH /documents/{id}/field-values` with keys and values, when every key and value is valid, then one server-authored commit with origin `prefill` sets them, attributed to the user named in `DEP-Actor` or to `system`.
- [x] Given a key of kind `signature`, `initials`, `dateSigned` or `formula`, then the request is refused and nothing is applied.
- [x] Given an unknown key or a wrongly typed value, then the request is refused with `field_invalid`, the problem names the key, and nothing is applied (the request is atomic).
- [ ] Given a value that contains TeX control sequences, markup or spreadsheet formula characters, then it is stored as typed data and reaches the PDF only through the same emitters and escaping layer as any other text.
- [x] Given the document is not open in a room, then a transient authority loads it, applies the commit, stores it and exits, without subscribers or timers.
- [ ] Given the same request is repeated with the same `Idempotency-Key`, then one commit is written.
- [x] Given a participant's fill commit based before the prefill and changing the same field, then it is rejected with `conflict` (FRW-010).

**Evidence:** `services/document-service/src/control-plane/fields.test.ts` (memory store). "refuses a prefill of a signature field, and of a field the document does not have, and applies nothing" (criterion 2: signature, initials, dateSigned and formula each refused by key; criterion 3: `field_invalid` naming `/values/<key>` for an unknown key and for a number that is not a decimal, a choice outside its options, and a mixed request applied not at all); "requires If-Match on a prefill and refuses an empty prefill" (guard rails).

**Evidence (lane U-FRW-055-072, 2026-11-13):** criterion 1 on `services/document-service/test/control-plane/frw-061.prefill-applied.test.ts`, run against PostgreSQL in Podman and against memory storage with the real data plane (`realDataPlane: true`, not the stub), both pass: the prefill answers 200 with the stored values, the commit log holds one `prefill` commit attributed to `system` (no DEP-Actor header is sent), and `?seq=` before it still shows the old values. Review (round 1, U3 group 2): criterion 1 unticked. The branch "attributed to the user named in `DEP-Actor`" has no test; tick it when a prefill with a `DEP-Actor` header is shown to give a commit by that user. Fix (round 1, U3 group 2, 2026-11-13): criterion 1 re-ticked. The same file adds "a prefill sent with DEP-Actor is one prefill commit attributed to the user it names": a service credential sends the PATCH with a `DEP-Actor` sub unique to the run, the answer is 200, and the commit log holds one `prefill` commit whose `author.user` is that sub (not `system`; the pipeline resolved the sub to a surrogate, which the log answers as the sub). `pnpm exec vitest run services/document-service/test/control-plane/frw-061.prefill-applied.test.ts`: 4 of 4 passed (2 cases on memory storage, 2 on PostgreSQL in the shared Podman container), none skipped.

**Evidence (lane U-FRW-055-072, round 2, 2026-11-13):** criterion 5 on `services/document-service/test/data-plane/frw-061.transient-prefill.test.ts` (memory stores with a `setTimeout` spy, and PostgreSQL in the shared Podman container; `pnpm exec vitest run services/document-service/test/data-plane/frw-061.transient-prefill.test.ts`: 2 of 2 passed, none skipped): a prefill applied by `host.apply` on a document with no room open stores one commit at seq 1 with origin `prefill`, leaves no room and no transient run, and the memory run sets no timer (the PostgreSQL run does not check timers, because the driver's pool keeps its own). `host.apply` is the call the outbox makes (`data-plane/outbox.ts`). Criterion 7 on `packages/authority/test/permissions.room.test.ts`, "rejects a fill after a server-authored change of the same field (FRW-010)": a prefill-origin commit at seq 1, then a fill made on base 0 of the same field is refused with `conflict` (Node, `pnpm exec vitest run packages/authority/test/permissions.room.test.ts -t "server-authored change of the same field"`, 1 passed). That test drives the room directly, not the HTTP route.

**Notes:** Lane U-FRW-055-072 (2026-11-13): criterion 1 is ticked on the evidence above; the `DEP-Actor` branch of the attribution is not exercised (fixed in round 1 of U3 group 2: both branches are now tested). Round 2: criteria 5 and 7 are ticked (see the Evidence line above). Criterion 4 (TeX and markup escaping on the PDF) stays open: `packages/export-latex` has `form_field` attribute handling but no tested emitter of a field value, so it is not shown here (not decided silently; needs the PDF emitter path). Criterion 6 stays open (see below). Packet C (2026-11-13): criteria 5 and 6 stay open: the accepted path needs a room or a transient authority to apply the commit, and the harness runs neither in the tests that refuse before the outbox. Criterion 4 (TeX and markup escaping on the PDF) is not tested here; criterion 7 was not tested at that point (ticked in round 2, see above). Pitfall (12 §14): prefill as an injection path. Who may call this (a service credential or a user with a capability) and whether prefill is allowed after send are not stated (Open questions). Lane FRW-053-065 (2026-11-13): `services/document-service/src/control-plane/frw-061.prefill-outbox.test.ts` (memory, passes) checks the accepted request as it reaches the outbox: one `prefill` commit, one `value` attr step per key, the base, and the typed text (TeX, markup and formula characters) kept as written. This is the first half of criterion 1 and a part of criterion 4 only; the commit is not applied or stored, and nothing reaches a PDF, so both stay unticked. Criterion 6 is blocked: the protocol definition of `prefillFieldValues` (`packages/protocol/src/definition/frw.ts`) sets no `idempotencyKey`, so the pipeline's Idempotency-Key store does not apply to this route (owner PRO; a root or protocol change, not made here). Lane V-FRW-055-072, round 2 (2026-11-13): criterion 4 stays unticked. The Node part is in place (the prefill's typed value is kept as written, and `form-fields.flatten.test.ts` criterion 5 writes a field value that holds TeX control sequences only through `text`), but nothing in the chain shows a PDF: `packages/export-latex/src/exp-033-field-value.compile.test.ts` skips here because `sandboxReady()` reports that the sandboxed compile cannot run on this machine (run took about five minutes and skipped), so the compile-level proof needs the export image built (needsFromOthers: export worker owner).

**Notes (lane V-FRW-055-072, 2026-11-13, criterion 6 not ticked):** `services/document-service/test/control-plane/frw-061.prefill-idempotent.test.ts` applies a prefill through the real data plane, then repeats it with the same `Idempotency-Key` and the same If-Match. It passes in memory and on PostgreSQL (2 passed, not skipped): the repeat is refused with `precondition_failed` (412) and the log holds one commit with origin `prefill`. The key is not replayed, because the protocol definition of the prefill route does not accept `Idempotency-Key` (`packages/protocol/src/definition/frw.ts`; the `idempotencyKey` flag is set only on POST routes, 05 §6.1). The criterion names the key, so it stays open until the owner or the protocol owner decides whether prefill accepts it (proposed, in docs/adr/0342-lane-V-FRW-055-072.md). Criterion 4 (TeX and markup escaping on the PDF) is unchanged.

**Notes (lane w4, 2026-11-17, checked again, nothing new ticked):** criterion 4 still needs a PDF compile, and there is no TeX image here (`podman images` lists only small stub images; the compile test of EXP-033 skips). Criterion 6 is not an owner decision of 2026-11-15 and 05 §6.1 gives `Idempotency-Key` to `POST` routes that create something, while this route is a `PATCH` with a required `If-Match`: today a repeat is refused with 412 and one commit exists, but the key is not accepted or replayed. Making `prefillFieldValues` accept the key is a change to the protocol definition and to 05 §6.1, so it stays with the owner of the protocol (proposed in docs/adr/0342-lane-V-FRW-055-072.md); no code was changed for this story.

### FRW-062 Create a document from a template

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | L | should | Owner |

**Spec:** 12 §9, §10, §14; 05 §6.2 (`/documents`, `/fork`) · **Requirements:** R13 · **Depends on:** FRW-025, FRW-061, UX-099

As an owner, I want to start a document from a template, so that I can reuse role placeholders, fields and rules for every new case.

**Acceptance criteria**

- [ ] Given a template, being a document with role placeholders, fields and rules and no participants, when it is instantiated, then a new document is created as a fork at a pinned `seq` and the `seq` is recorded.
- [ ] Given the instantiation, then participants are bound to the roles and values may be prefilled in the same call.
- [ ] Given the template changes after instantiation, then existing instances are unaffected.
- [ ] Given a template that carries participants or a workflow in a non-draft state, then instantiation refuses or removes them and the new document starts as a draft.
- [ ] Given the `/templates` resource, then it supports listing, creating and reading templates, with the schema published in `spec/`.
- [ ] Given instantiation, then it needs a service credential, as forking does.

**Notes:** Pitfall (12 §14): a template changed after sending: packets are forks pinned to a template `seq`. The shape of the `/templates` resource and how a document becomes a template are not defined; whether grants are copied is not stated (Open questions).

### FRW-063 Send a template to many recipients

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | L | could | Owner |

**Spec:** 12 §9, §3.3 (consequences), §10 · **Requirements:** R13, R9 · **Depends on:** FRW-062, BE-049, BE-092

As an owner, I want to send one template to a list of recipients, so that each gets their own document to fill and sign.

**Acceptance criteria**

- [ ] Given `POST /bulk-sends` with a template, a pinned `seq` and recipient rows, when the job runs, then it creates one fork per row at that `seq`, binds the row's participants and applies the row's prefill values.
- [ ] Given a row that fails (an invalid value, an unknown key), then that row is reported with its reason and the other rows are not affected.
- [ ] Given the same job request is repeated with the same `Idempotency-Key`, then no fork is created twice.
- [ ] Given tenant quotas, then a request beyond them is refused with `quota_exceeded`.
- [ ] Given the job finishes, then its result lists each row with the new document identifier or the failure.

**Notes:** The row format, the limits and whether each fork is also sent are not stated. Each fork is a full document, so the cost sheet (06 §10) must count it.

### FRW-064 Neutralise spreadsheet formula characters in field exports

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | cond | S | should | Integrating developer |

**Spec:** 12 §9 (prefill bullet), §14 · **Requirements:** R13, R10 · **Depends on:** FRW-060

As an integrating developer, I want any spreadsheet-format output of field values to neutralise leading formula characters, so that a value typed by a participant cannot run as a formula when opened.

**Acceptance criteria**

- [ ] Given a field value whose first character is `=`, `+`, `-` or `@`, when it is written to a spreadsheet-format output, then the cell is not interpreted as a formula by the spreadsheet applications in the test matrix.
- [ ] Given a value with none of those characters, then it is written unchanged.
- [ ] Given a `number` field with a negative value, then the output is a number or is neutralised in a way the integrating developer can read back; the behaviour is documented.
- [ ] Given the same value read through `GET /documents/{id}/field-values`, then it is returned unchanged, because neutralisation applies only to the spreadsheet output.

**Notes:** Condition: only if the platform produces a spreadsheet-format output of field values. 12 §9 mentions "exported spreadsheets" but no such export is specified in 12, 05 or 09 (Open questions). Phase `cond`.

## Protocol additions (12 §10)

### FRW-065 Announce the fields features

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | must | Maintainer |

**Spec:** 12 §10 (features); 05 §2, §5.8, §8.3, §9 · **Requirements:** R13, R6 · **Depends on:** FRW-007, PRO-006, PRO-008, PRO-091, PRO-092

As a maintainer, I want the features `fields`, `rules`, `workflow`, `sign` and `seal` announced only when they are really supported, so that clients show a feature only when the server can enforce it.

**Acceptance criteria**

- [ ] Given a server that implements the outcome check for fills, prefill and the field resources, then it announces `fields`; given a server in relay mode, then it never announces `fields`.
- [ ] Given a server that implements the rules fixtures, the workflow resource, the signing ceremony or sealing, then it announces `rules`, `workflow`, `sign` and `seal` respectively and not otherwise.
- [ ] Given a backend without the optional `fields` or `workflow` port, then the component shows no field authoring or workflow control that needs it.
- [x] Given a client that requires a feature the server does not announce, then the channel fails with `unsupported_feature`.
- [ ] Given the mock backend, then it implements the `fields` port and announces `fields` from phase 1b.

**Evidence (lane U-FRW-055-072, 2026-11-13):** criterion 4 on `packages/tck/test/frw-065.feature-announcement.reference.test.ts`, run against the reference service (in-memory storage, started by `packages/tck/test/targets/reference.ts`): the kit scenario `core.channel.rejected.feature` passes, and `fields.announce` passes with the reference service announcing `fields`. Run: `pnpm exec vitest run packages/tck/test/frw-065.feature-announcement.reference.test.ts`, 2 of 2 passed. Criterion 1's relay half (a relay never announces `fields`) and criterion 5 (the mock backend implements the fields port) stay open: the relay half is the `core-relay` profile, not run here, and the mock does not announce `fields` (`packages/backend-mock/src/service.ts`).

**Notes:** Phase inferred for the feature negotiation (12 §13 places the profile `fields`, not the flag). Each later feature flag is switched on by the story that delivers it; the conformance kit checks the mapping from profile to feature. Packet K, 2026-11-06: the kit checks the mapping (packages/tck/src/profiles/fields.ts fields.announce; core.discovery.shape refuses fields from a relay; core.channel.rejected.feature asks for an unannounced feature). The criteria are the server's and the component's: the mock backend does not announce fields (criterion 5, backend-mock), and the reference service opens a channel that asks for an unannounced feature (criterion 4, reported). Since 2026-11-06 the reference service announces fields without offering GET /documents/{id}/fields or PATCH /documents/{id}/field-values (packages/tck/test/reference.test.ts), which criterion 1 forbids. Lane w4 (2026-11-17), no tick: criterion 2 is not met. The reference service announces `supportedFeatures()` of the CDM definition (`services/document-service/src/data-plane/settings.ts`, `packages/model/src/definition/features.ts`), so it announces `rules`, `workflow`, `sign` and `seal` whether or not it implements them. Making the announcement follow the implementation is a change to the feature negotiation of every profile, not a story-sized edit. Criterion 3: the built-in gating test (`packages/ui/test/pro-092-feature-controls.test.ts`) covers the built-in commands only; the field-insert commands in `packages/ui/src/commands/builtin.ts` are gated by `sign` and `rules`, not by `fields`, so the criterion is not shown for them. Criterion 1 (relay half) needs a run of the relay discovery against a real relay, which is not in this lane. Criterion 5 needs the mock backend to implement the fields port (`packages/backend-mock`), which it does not.

### FRW-066 Prove fill permissions with a property test

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Maintainer |

**Spec:** 12 §10 (conformance), §13 (phase 0); 07 §5.1; 10 §6; 11 §2 (S3), §4 · **Requirements:** R13, R3, R10 · **Depends on:** FRW-008, FRW-009, FRW-010, SPK-016, PRO-108

As a maintainer, I want a property test in which a fill-only participant can change nothing but the values of the fields assigned to their roles, so that the security boundary of the fill permission is proved, not argued.

**Acceptance criteria**

- [x] Given random commit sequences from a fill-only participant (steps of all seven types, crafted `replaceAround`, attribute, mark and node-mark steps, pasted signed fields, random bases, reconnects, failed writes), when run against the authority, then in every accepted commit the only scopes that differ are `value` attributes of fields assigned to the participant's roles that P7 allows.
- [x] Given two participants filling the same fields concurrently, then P9 holds: no accepted commit overwrote a value that was changed after its `base`.
- [x] Given a rejected commit, then the document is unchanged.
- [x] Given a deliberately weakened check (for example one that reasons about step shapes, as the first draft did), then the test fails, which shows the oracle can catch the review's critical finding.
- [ ] Given the test is packaged as the conformance profile `perm-fill`, then it runs black-box against a server through DEP with minted tokens and a candidate that fails can see the failing sequence.
- [x] Given a fuzzing run, then no crash or stall is found.

**Evidence:** packages/tck/test/fill.property.test.ts: random commits of all seven step types, crafted replaceAround, attribute, mark and node-mark steps and pasted fields from a fill-only participant, judged by an oracle written apart from the outcome check (only the values P7 allows may differ), with more than ten accepted fills so the property is not vacuous; P9 with two participants and random bases; a check that trusts step shapes is caught by the oracle; 200 further runs find no crash or stall (FRW066_RUNS raises the count); the last describe block drives the authority's Room with the same generator and checks that every refused fill leaves the head and the document unchanged (criterion 3). Lane w4 (2026-11-17), criterion 1: the last describe block, "random bases, reconnects and failed writes through the room", drives the authority's `Room` with two connections (the fill-only participant and a second filler) and a generated sequence of operations: fills built over the document at a random base behind the head with the same step generator (all seven step types, crafted `replaceAround`, attribute, mark and node-mark steps, pasted fields), the other participant's fills, `writeCompleted` with `ok` and with `failed`, and reconnects that resume with a commit in flight. Each stored commit is replayed from the write request alone and judged by the independent oracle (only values P7 allows differ) and by P9 against the fields changed after its own base; a failed write leaves head and document as before; the block counts stored, stale-base, conflicting, failed, reconnecting and resumed cases and asserts that none is zero. `pnpm exec vitest run --project node packages/tck/test/fill.property.test.ts`: 6 passed at the default 300 runs and at `FRW066_RUNS=1000`, on Node.js 22.18 on the development machine, 2026-11-17.

**Notes:** Lane w4 (2026-11-17): criterion 1 is ticked (the generator now adds random bases, reconnects and failed writes, which the audit asked for). Criterion 5 stays unticked. The reason given before (G95, no way to activate a participant) no longer holds, because the owner settled form mode without a workflow (decision 5 of `docs/owner-decisions-2026-11-15.md`) and a filler now gets fill roles from the `wfr` claim (FRW-007 criterion 6). What is missing is work in the protocol and the kit: `TokenRequest` (`packages/protocol/src/definition/resources.ts`) has no member for that claim, so `POST /tokens` cannot mint a filler with roles (a definition change that regenerates `spec/`), and the `perm-fill` scenario in `packages/tck/src/profiles/fields.ts` is still a skip; it then needs the black-box run over a sync channel with the failing sequence in its report. That is a larger change to shared protocol files and was not made in this lane. Earlier note: 12 §13 phase 0 extends spike S3 with P7 and P9; the spike is SPK's, and this story is the lasting test. Phase 1b exit: a fill-only participant works for an hour under fault injection and the documents end identical. Review S-01. Packet K, 2026-11-06: criterion 3 needs the room (a rejected commit leaves the stored document unchanged), which S3's simulation in the authority covers; the pure property here cannot show it. Round 1 (tck): criterion 3 is now ticked from the room-level test in fill.property.test.ts. Criterion 5 waits for the workflow actions that activate a participant (G95): perm-fill is skipped with that reason. Audit (2026-11-13): criterion 1 is unticked because `fill.property.test.ts` generates the seven step types, crafted `replaceAround` and pasted fields and judges them with an independent oracle (passes, also at 1000 runs), but it generates no random bases (the outcome check is given an empty changed-since-base set and the room run always submits at the head), no reconnects and no failed writes (`writeCompleted` is always `ok`), which the criterion names; tick it when the generator adds them.

### FRW-067 Publish the fields conformance profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 12 §10 (conformance); 05 §11 · **Requirements:** R13, R6 · **Depends on:** FRW-005, FRW-008, FRW-010, FRW-060, FRW-061, FRW-065

As a maintainer, I want the profile `fields` in the conformance kit, so that a backend written by someone else can prove it handles fields the same way.

**Acceptance criteria**

- [ ] Given the profile, then it covers the invariants I13 to I15, the outcomes of P7 to P9 with their codes (`permission_denied`, `field_invalid`, `conflict`), prefill, the field resources and the feature announcement.
- [x] Given the mock backend and the reference service, when the profile runs, then both pass.
- [x] Given the machine-readable definitions, then the JSON Schema for `form_field` and `role_def`, the OpenAPI paths for fields and field values and the AsyncAPI reject codes are generated and checked by the kit.
- [x] Given a failing candidate, then the report names the failing scenario.
- [x] Given the profile maps to the feature `fields`, then a server announcing `fields` must pass it.

**Evidence:** packages/tck/test/sync.test.ts checks that spec/cdm/cdm-1.schema.json defines form_field and role_def, spec/dep/dep-1.openapi.json the paths of fields and field values, the AsyncAPI document the reject codes permission_denied, field_invalid and conflict, and that the fields profile (packages/tck/src/profiles/fields.ts) maps to the feature fields, so that a server announcing it is held to the profile (packages/tck/src/runner.ts). packages/tck/src/report.ts names every failing scenario of the fields profile with its identifier, the expectation and what the server did (the run against the reference service in packages/tck/test/reference.test.ts; packages/tck/test/kit.test.ts).

**Evidence (lane U-FRW-055-072, 2026-11-13, criterion 2, reference half):** `packages/tck/test/frw-067.fields-profile.reference.test.ts` runs the `fields` profile against the reference service (in-memory storage): six scenarios, `fields.announce`, `fields.i13.keys`, `fields.i15.values`, `fields.p8.server-only`, `fields.p9.conflict` and `fields.prefill`, all passed (`pnpm exec vitest run packages/tck/test/frw-067.fields-profile.reference.test.ts`, 2 of 2 passed). Criterion 2 stays unticked: the mock backend half is not met, because `packages/backend-mock` does not implement the fields port and does not announce `fields` (`packages/backend-mock/src/service.ts`), and `packages/tck/test/mock.test.ts` skips `fields` on the mock. Criterion 1 stays open for I14 (rules, FRW-020); the reference run did not include `rules`.

**Evidence (lane w4, 2026-11-17, criterion 2, mock half; criterion 1, I14):** the mock backend now offers the fields port and announces `fields`: `packages/backend-mock/src/fields.ts` (the derived list, values by key, all-or-nothing prefill steps), `MockDocument.fieldList/fieldValues/prefill` in `packages/backend-mock/src/document.ts` (prefill is a server-authored commit with origin `prefill` through `Room.author`), `MockBackend.fields` and the `fields` feature in `packages/backend-mock/src/service.ts`; the test target serves `GET /documents/{id}/fields`, `GET` and `PATCH /documents/{id}/field-values` (`packages/tck/test/targets/mock-server.ts`). `packages/tck/test/mock.test.ts` runs the whole kit against it: the seven scenarios of `fields` (`announce`, `i13.keys`, `i14.targets`, `i15.values`, `p8.server-only`, `p9.conflict`, `prefill`) all passed, and `packages/tck/test/frw-067.fields-profile.reference.test.ts` shows the same scenarios passing on the reference service (in-memory storage). `packages/backend-mock/test/fields.test.ts` checks the port itself. The new scenario `fields.i14.targets` (`packages/tck/src/profiles/fields.ts`) refuses a `formValue` field aimed at a key no field has and accepts one aimed at an existing key.

**Notes:** Lane w4 (2026-11-17): criterion 2 is met. Criterion 1 stays unticked for two things. P7 needs a participant who may fill: outside a workflow that is the host-signed `wfr` claim (05 §3.1), and the kit's token route has no way to ask for it; with a workflow the actions that activate a participant are undefined (G95), so `perm-fill` is skipped with that reason on both targets. The rules half of I14 (a rule reading an unknown key, a cycle) needs a `rule_def`, which needs `structure` on the definitions (12 §5.4), and the profile `rules` of FRW-020 is where its fixtures belong; this story's scenario covers the `formValue` half only. Earlier note, Packet K, 2026-11-06: criterion 1 stays open for I14 (rules, FRW-020) and for P7, which needs a workflow participant (perm-fill is skipped until the workflow actions are defined, G95); I13, I15, P8, P9, prefill and the field resources are in packages/tck/src/profiles/fields.ts. Criterion 2 stays open: the mock backend does not announce fields, and the reference service announces fields since 2026-11-06 but has not yet been run with the corrected fields document of the kit. Lane V-FRW-055-072, round 2 (2026-11-13): not taken. Criterion 2 needs the fields port in `packages/backend-mock` (its service, documents and discovery announce no fields, and the TCK mock test skips `fields`), a change of several resources and of the mock's document model; that is larger than this round allowed, and the reference run above is unchanged.

### FRW-068 Publish the workflow, sign and seal conformance profiles

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | L | must | Maintainer |

**Spec:** 12 §10 (conformance); 05 §11; 07 §12 · **Requirements:** R13, R6 · **Depends on:** FRW-027, FRW-031, FRW-032, FRW-033, FRW-034, FRW-046, FRW-047, FRW-053, FRW-055

As a maintainer, I want the profiles `workflow`, `sign` and `seal` in the conformance kit, so that the state machine, the ceremony and the sealed result are checked black-box.

**Acceptance criteria**

- [ ] Given the profile `workflow`, then it covers every transition of the state diagram, the refusal of every illegal transition, the send checklist, ordering, correction and resume, decline, void, expiry (with the test-mode switch shortening timers), `wf.changed` and the webhooks.
- [ ] Given the profile `sign`, then it covers consent, sign and complete, the server-set values, the `dateSigned` time zone, and the refusals for fields of other roles and inactive participants.
- [ ] Given the profile `seal`, then a conforming server produces a sealed PDF that validates in the validator named by spike S8, and an evidence bundle that verifies; a tampered copy is detected.
- [ ] Given each resource of 12 §10, then the kit holds negative tests for its row in the authorisation matrix.
- [ ] Given each profile maps to its feature (`workflow`, `sign`, `seal`), then a server announcing it must pass it.

**Notes:** The `rules` profile is part of FRW-020 and `perm-fill` is FRW-066. The kit cannot observe durability or the chain from outside; the optional fault-injection profile covers them. Lane FRW-066-078, round 3 (2026-11-13): no profile is written and no criterion ticked. The `workflow`, `sign` and `seal` profiles need a conforming server that runs the workflow (FRW-027 to FRW-034), the ceremony (FRW-046, FRW-047) and the signing service (FRW-053, FRW-055), none of which is built, and the workflow actions that activate a participant are not defined (G95, see `packages/tck/src/profiles/fields.ts`, `perm-fill`). `packages/tck/src/profiles/registry.ts` marks `workflow_active` as unreachable until these profiles exist. A profile with no server to run it against would be a hollow test. See docs/adr/0252-lane-FRW-066-078.md, finding 7.

### FRW-069 Drive fill mode through the embedding API

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 12 §10 (embedding API); 05 §8.1; 13 §3 · **Requirements:** R13, R2, R6 · **Depends on:** FRW-007, FRW-076, PRO-077

As an integrating developer, I want the attribute `mode="fill"` and the fill methods, so that my page can open a document for filling and read and set values.

**Acceptance criteria**

- [x] Given `<doc-editor mode="fill">`, then the body is read-only and only the fields the user may fill are editable; the server's permissions still apply whatever the attribute says.
- [x] Given `nextField()` and `focusField(key)`, then they move focus to the next fillable field or to the field with that key, and for an unknown key they do not throw and report that nothing was focused.
- [x] Given `getFieldValues()`, then it returns the current values by key.
- [x] Given `setFieldValue(key, value)`, then it submits a normal fill as the current user, subject to P7; a rejection is reported to the caller with the code (`permission_denied`, `field_invalid`, `conflict`).
- [x] Given `validateFields()`, then it returns the required-and-empty and invalid fields with keys and reasons, and changes nothing.
- [ ] Given the properties and methods are called before the element is upgraded, then they take effect when it is (the lifecycle rules of PRO).

**Evidence (lane w4, 2026-11-17):** the methods are `nextField`, `focusField`, `getFieldValues`, `setFieldValue` and `validateFields` of `DocEditorElement` (`packages/element/src/doc-editor.ts`), over `HostApi` (`packages/element/src/host-api.ts`) and the core (`fieldValues`, `fillField` in `packages/engine/src/core.ts`; `focusFieldByKey`, `nextFillableField` in `packages/engine/src/view/web.ts`; the types `FieldFillOutcome` and `FieldsApi` in `packages/engine/src/api.ts`). `packages/engine/test/frw-069.field-api.test.ts` (Node.js, the real authority of backend-mock, 7 passed): values by key; a fill by a participant stored by the service; `permission_denied` for a field of another role (P7); `field_invalid` for a value that does not fit, the stored value kept; `conflict` for a field someone else changed first (P9), with the room holding its writes; `not_found` for an unknown key; `validateFields()` reports required-and-empty and invalid fields with keys and codes and changes no content. `packages/element/test/frw-069-methods.test.ts` (Node.js): with no document the methods answer that nothing applies and throw nothing. `packages/element/e2e/frw-069-fill-api.spec.ts` runs the real element in Chromium, Edge, Firefox and WebKit (`pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-069-fill-api.spec.ts`, 7 tests in each, 28 of 28 passed in one run): criterion 1, `mode="fill"` gives a read-only body, editable controls for the participant's role only, and a viewer who asks for the fill mode gets the effective mode `view` and no editable control; criterion 2, `focusField('tenant.email')` focuses the control, an unknown key answers false and throws nothing, `nextField()` goes amount, name, e-mail and then answers false; criteria 3, 4 and 5 through the methods on the element, including the codes `permission_denied`, `field_invalid` and `conflict` (the author's fill held in the room while the participant's is made from the older base) and a `validateFields()` that stores nothing.

**Notes:** `mode="fill"` is placed in 1b by 12 §13; phase inferred for the methods, which are assumed to ship with it. `completeFilling()` and `decline(reason)` are FRW-071. Lane FRW-066-078, round 1 (2026-11-13): none of the methods exists in `packages/element/src`, and the core's optional `focusField(id)` takes an identifier, not a key (criterion 2 asks for a key). No criterion ticked. See docs/adr/0252-lane-FRW-066-078.md, finding 3. Lane U-FRW-055-072, round 4 (2026-11-13): still no criterion ticked. FRW-076 is not met, so the fill methods wait for it; the core's fill summary still has no field `key`. See docs/adr/0342-lane-U-FRW-055-072.md, item 6. Lane w4, 2026-11-17: criteria 1 to 5 are met and tested (see the Evidence); FRW-076 is met for the criteria that matter here. Choices the spec leaves open, recorded here for the owner: (a) `nextField()` goes to the next fillable field after the one that last had focus, the first when none had, and answers false after the last: it does not wrap round; (b) `focusField(key)` reaches any field that has a control, also a read-only one of another role, while `nextField()` stops only at fields the user may fill; (c) `setFieldValue` resolves and does not reject: `{ ok: true, confirmed }` or `{ ok: false, code, message }` with `permission_denied`, `field_invalid`, `conflict`, `not_found` (no field has the key) or `unavailable` (no document is loaded), and `confirmed: false` when the service gave no answer in 15 seconds and the change stays queued; (d) `getFieldValues()` reads the values the document holds now, including a fill that is not yet confirmed. Criterion 6 stays unticked: a method cannot be called on an element that is not yet upgraded, because the method does not exist until the class is defined, so "called before the element is upgraded" has no meaning for the methods; what the code does is give every method a defined answer when the element is upgraded but no document is loaded (nothing is focused, the values are empty, `setFieldValue` resolves `unavailable`), and attributes and the captured properties (`backend`, `getToken`) take effect on upgrade (FE-003; PRO-075). Proposed rewording, for the owner: "Given the properties are set, and the attribute `mode` is present, before the element is upgraded, then they take effect when it is; given the methods are called before a document is loaded, then they answer that nothing applies and do not throw." 05 §8.1's table of methods does not list these five; 12 §10 does.

### FRW-070 Report field and fill progress as events

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Integrating developer |

**Spec:** 12 §10 (embedding API events); 05 §8.1 · **Requirements:** R13, R10 · **Depends on:** FRW-069

As an integrating developer, I want events when a field changes and when progress changes, without the values in them, so that my page can react without personal data leaking through the event stream.

**Acceptance criteria**

- [x] Given a user changes a field, then `de-field-change` is raised with `{ fieldId, key, valid, empty }`.
- [x] Given the event detail of `de-field-change`, then it contains no value; a test serialises the detail and finds none.
- [x] Given progress in the guided bar changes, then `de-fill-progress` is raised with the progress the bar shows (for example filled and total required fields).
- [x] Given the events, then they cross the shadow boundary as the embedding contract specifies and carry the `de-` prefix.

**Evidence:** Lane w4 (2026-11-15). The core reports each entry a person submits (`FieldEntries.onChange`, `DocumentCore.onFieldChange`, `packages/engine/src/field-entries.ts`) and lists the fields without their values (`fillFields`); the element turns them into the two events (`packages/element/src/fill.ts`, `FillEvents`, wired in `session.ts` and `editor.ts`, named in `events.ts`). Node.js: `packages/element/test/frw-070-fill-events.test.ts` (8 tests) on plain views and on the real headless core with a participant's access: the detail has exactly the four members, also when the source hands over a value; valid, not valid, empty and required-and-empty entries; the same entry again raises nothing; an entry the guard refuses raises nothing; every raised detail is serialised and holds none of the entries (criteria 1 and 2); the progress is raised when the bar first shows a count and when the count changes, and not otherwise (criterion 3). Browser, the real element with the shell's guided bar and the mock backend on the embed page (`packages/element/demo/embed-page.ts`, form document and `fillBackend`): `packages/element/e2e/frw-070-fill-events.spec.ts` (2 tests), run on this Windows machine with `DOCEDIT_DEMO_PORT=47914 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-070-fill-events.spec.ts` in Chromium, Edge, Firefox and WebKit, 8 passed. Listeners on `document` hear both events with the element as target, `composed` and `bubbles` true (criterion 4); the typed entries are in no recorded event (criterion 2); the detail of `de-fill-progress` equals the count the bar's text shows at each step (criterion 3).

**Notes:** Lane w4 (2026-11-15): all four criteria ticked. Choices made where the spec is silent, proposed and not decided: (a) `de-field-change` is raised for an entry this person submitted (through a field control, and through any later caller of the core's `enterFieldValue`), not for a change that arrives from someone else, because the criterion says "a user changes a field"; a host that wants remote changes has `de-change`. (b) The detail of `de-fill-progress` is `{ filled, total }`: the required fields of this participant that are filled and valid, and the required fields they must fill, computed by the bar's own function (`fillProgress`, reached as `@docedit/ui/fill`, a new export of the ui package). It is raised once when the bar first shows a count, then on each change of the count; while the participant is not active the bar shows no count and none is raised. (c) `valid` is false for an entry with a static problem and for a required field left empty. To raise the progress the element now gives the shell its fill summary (`CoreApi.fill`, `focusField`), so the guided bar shows in `mode="fill"`; the rest of FRW-076 and the fill methods of FRW-069 are not built by this story. Earlier notes follow. Phase inferred. The payload of `de-fill-progress` is not specified; the criterion reads it as what the bar shows. Whether remote changes also raise `de-field-change` is not stated. Lane FRW-066-078, round 1 (2026-11-13): no event of this story is raised by `packages/element` yet, and `FillField` (packages/ui/src/core-api.ts) has no `key`, which `de-field-change` needs. No criterion ticked. See docs/adr/0252-lane-FRW-066-078.md, finding 2. Lane U-FRW-055-072, round 5 (2026-11-13): still no criterion ticked; the events need the fill methods of FRW-069, which wait for FRW-076 (docs/adr/0342-lane-U-FRW-055-072.md, item 6).

### FRW-071 Finish or decline filling through the embedding API

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 12 §10 (embedding API); 05 §8.1 · **Requirements:** R13, R6 · **Depends on:** FRW-047, FRW-033, FRW-069

As an integrating developer, I want `completeFilling()`, `decline(reason)` and the signing and completion events, so that my page can drive and observe the end of a participant's work.

**Acceptance criteria**

- [ ] Given `completeFilling()`, then it runs `validateFields()` first; if anything fails it moves focus to the first problem and resolves with the failures without calling the server; otherwise it calls the participant's `/complete` endpoint and resolves with the result.
- [ ] Given `decline(reason)` with a reason, then it calls `/decline`; given no reason, then it rejects without calling the server.
- [ ] Given a participant starts to sign a field, then `de-sign-request` is raised with the field's identifier and key.
- [ ] Given `wf.changed` shows the workflow `completed`, then `de-workflow-complete` is raised.
- [ ] Given the methods are called by a user whose participant is not active, then they reject with the reason.

**Notes:** The payload and any host veto of `de-sign-request`, and whether `de-workflow-complete` fires for one participant's completion or only for the workflow's, are not specified (Open questions). What `completeFilling()` does in form mode without a workflow is FRW-083. Lane U-FRW-055-072, round 4 (2026-11-13): no criterion ticked. `packages/protocol/src/definition/frw.ts` defines the participant `complete` and `decline` actions, but `services/document-service/src` serves neither route and no workflow service runs them. See docs/adr/0342-lane-U-FRW-055-072.md, item 7.

## Frontend for authors (12 §11)

### FRW-072 Insert fields from a palette

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 12 §11 (authors), §3.2 · **Requirements:** R13, R14 · **Depends on:** FRW-002, FRW-005, FRW-074, UX-003

As an author, I want to insert fields of each kind from a palette, so that I can mark where the blanks go while I write.

**Acceptance criteria**

- [x] Given the caret in a body paragraph or table cell and `edit` in that scope, when I choose a kind from the palette, then an inline field of that kind is inserted with a fresh identifier and a `key` that is unique in the document.
- [x] Given a release in which only some kinds exist, then the palette lists exactly those: `text`, `number`, `date`, `checkbox` and `choice` in phase 1b; `signature`, `initials`, `dateSigned` and `formula` appear with the features `sign` and `rules`.
- [x] Given the caret is in a header, footer or footnote sub-editor, then the palette's insert commands are unavailable.
- [x] Given the document already holds 2,000 fields (target limit), then the insert commands are disabled with a stated reason.
- [x] Given the palette, then it is driven by the command registry, is operable from the keyboard and command search, and uses external strings.
- [x] Given a user without `edit`, then the palette is absent or disabled with a reason.

**Review (round 2, group 3):** criteria 2, 3, 4 and 6 were unticked. `shell/fields.ts` is called by nothing except its own test, and it repeats the kinds, features and gating that `commands/builtin.ts` already holds (`insert.field.<kind>` with `feature` and `enabled: 'canInsertField'`). The tests below show the rule set of an unused module, not the behaviour a user or the command registry has. `fieldPalette` does not read the scope, so the header case rests on a reason that a test passes in. Tick them when the tests drive the registry's commands (or the palette is wired to `fields.ts` and the duplicate `FIELD_KINDS` is removed).

**Evidence:** packages/ui/test/field-commands.test.ts drives the `insert.field.<kind>` commands of packages/ui/src/commands/builtin.ts through `createCommandRegistry`, `state` and `exec` (criterion 2: the five kinds of 1b, the signing kinds with `sign`, the formula with `rules`, a property over features, a change of features at run time, no commands for a core that cannot insert fields; criterion 3: every command unavailable with `reason.query.subeditor` in the footnote and header or footer sub-editors, a `story:` scope and the `story` context, with a core that would allow the insert, from `fieldInsertSource` in packages/ui/src/commands/queries.ts; criterion 4: the 2,000th field is inserted, then every command is disabled with `reason.query.fieldLimit` and nothing runs, also for the core's code `limit`; criterion 6: view, comment, locked and suggest-only access disable every command with the access reason or `reason.query.noEdit`, and a property over capabilities). Browser: packages/ui/e2e/regions.spec.ts 'the palette offers the kinds of this release, through the registry' passed in Chromium, Firefox and WebKit (Playwright, `DOCEDIT_BROWSERS`, 2026-11-13). Criterion 5 (lane U-FRW-055-072, 2026-11-13): packages/ui/e2e/frw-072-palette-keyboard.spec.ts focuses `insert.field.text` and `insert.field.number` with the keyboard and invokes them with Enter and Space, with the calls checked through the harness; it passed in Chromium, Firefox and WebKit (`pnpm exec playwright test -c playwright.config.ts`, `DOCEDIT_BROWSERS=firefox,webkit`). Command search is packages/ui/test/field-palette-search.test.ts; the labels are i18n keys (`command.insert.field.*`, packages/ui/src/i18n/en-GB.ts). Criterion 1 stays open: the field is inserted by the core. Lane w4 (2026-11-15), criteria 1 and 4, with the real core. Node.js: `packages/engine/src/frw-072.form-fields.test.ts` (12 tests): each of the five kinds of phase 1b is inserted at the caret with its own 16-character identifier and a key no other field has, in a body paragraph and in the paragraph of a table cell, and the document stays valid (criterion 1); with 1,999 fields the query `canInsertField` is true and the 2,000th field is inserted, then the query is false, `queryReason` is `fieldLimit`, every kind's command is disabled and running one inserts nothing (criterion 4; `formFieldCount` and `FIELD_LIMITS.fields` in `packages/engine/src/frw-072-form-fields.ts`, `queryReason` in `core.ts`). Browser, the real element with the shell and the mock backend on the embed page: `packages/element/e2e/frw-072-insert-fields.spec.ts` (2 tests), run on this Windows machine with `DOCEDIT_DEMO_PORT=47917 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-072-insert-fields.spec.ts` in Chromium, Edge, Firefox and WebKit, 8 passed. An editor puts the caret in a body paragraph and chooses each of the five kinds by the command search; the five fields are read back from the confirmed document, inline in that paragraph, each with a fresh identifier and a key unique among the nine fields, and each is drawn as a control (criterion 1). In a document with 1,999 fields the 2,000th is inserted and stored; after that each kind is listed disabled with "The document already has the largest number of fields it may have.", Enter inserts nothing and the count stays 2,000 (criterion 4).

**Notes:** Lane w4 (2026-11-15): criteria 1 and 4 are ticked (see Evidence), so all six are. Two things the ticks rest on. (a) The form kind `date`: ADR 0342 item 2 left open how the palette's `date` is told from the page date of FE-136. This lane takes its option (a), proposed in docs/adr/0367-w4-FRW-072-form-date-in-the-palette.md: `insertField` takes `form: true` from a caller that asks for a form field, and the element's palette command sets it; without it `date` is the page date as before. The owner may still prefer a distinct name. (b) The limit is counted by the core on each query (a walk of the document), and refused before the authority would refuse the commit; the browser test of the limit uses the table-cell-free spike document, and the table cell case of criterion 1 is tested in Node.js only. Earlier notes follow. Phase inferred: 12 §13 names no authoring interface for 1b, but form mode needs fields to exist; an API-only start is possible if the owner prefers it (FRW-083). Round 2 (packet U, 2026-11-13): the decision of what the palette offers is `shell/fields.ts`; the core must answer `canInsertField` with a reason from `CoreApi` (`subeditor`, `limit`, `none`). The field count is taken from the core when it is known, else the core's own limit applies (ADR 0113, round 2). Round 2 fix (group 3, 2026-11-13): the palette rules of `shell/fields.ts` and its second `FIELD_KINDS` were removed. The palette is the registry's `insert.field.*` commands; the shell's own rules (no field in a sub-editor or a `story:` scope, as 12 §3.2 says; `edit` needed) are the query source `fieldInsertSource`, asked before the core. The shell holds no field count, so the 2,000 limit is the core's answer; the core's code `limit` or `fieldLimit` is stated as `reason.query.fieldLimit`. A suggest-only user gets `reason.query.noEdit` (criterion 1 names `edit`); proposed, for the owner to confirm. Lane ui-4, round 2 (2026-11-13): packages/ui/test/field-palette-search.test.ts shows the field kinds are found by command search by their translated labels, listed runnable under `edit` and not runnable under `view`, and a kind the release does not offer is not listed. Criterion 5 stays open: keyboard operability of the palette is a browser run, not run here. Lane V-FRW-055-072 (2026-11-13), criterion 1 not ticked: the engine now inserts a form field of kind `text`, `number`, `checkbox` or `choice` at the caret (`packages/engine/src/frw-072-form-fields.ts`, routed from `insertField` in `packages/engine/src/fields-toc.ts`; key `<kind>_<n>` for the least free `n`, label such as `Text 1`, identifier from the identifier plugin; the document must require `fields`; not in a sub-editor). Tested in Node: `packages/engine/src/frw-072.form-fields.test.ts` (7 passed). The palette is wired to it: the query `canInsertField` and `runNamed('insertField', { kind })` in `packages/engine/src/core.ts` and `packages/element/src/editor.ts`. No browser run proves the path yet: the element's spike page (`packages/element/demo/s1-page.ts`) has no Insert tab and its document requires no `fields`, so the insert is refused there, and a browser run needs a demo page with the full shell and a document that requires `fields` (needsFromOthers, element demo owner). The kind `date` stays the page date (FE-136); a form date needs a decision, see docs/adr/0342-lane-V-FRW-055-072.md. Evidence audit (2026-11-13), criterion 4 unticked: the 2,000 limit in packages/ui/test/field-commands.test.ts is answered by `FakeCore` (`fieldLimit = 2000`, `queryReason('canInsertField')`), while the real core (packages/engine/src/core.ts `canInsertField`, `insertFormField`) counts no fields and has no `queryReason`, so with the real core the insert commands stay enabled at 2,000 fields; only the shell's pass-through of a core's answer is tested.

### FRW-073 Edit a field's properties in a panel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 12 §11 (authors), §3.2, §4.3 · **Requirements:** R13, R11 · **Depends on:** FRW-002, FRW-004, FRW-074, UX-019

As an author, I want a properties panel for the selected field, so that I can set its key, kind, label, role and limits without editing JSON.

**Acceptance criteria**

- [x] Given a selected field, then the panel shows and edits `key`, `kind`, `label`, `assignee` (chosen from the roles), `required`, `readOnly`, `default`, `placeholder`, `options` (for `choice`), `format`, `validation` and `width`; `sensitive` is not offered because it is reserved.
- [x] Given an invalid entry (a duplicate `key`, an assignee that is not a role, duplicate option identifiers, a bad validation limit), then the panel shows the reason and does not commit.
- [x] Given a change, then it is committed as ordinary attribute changes, can be undone and appears in history.
- [ ] Given a user without `edit`, or a workflow in `sent` or `in_progress`, then the panel is read-only.
- [x] Given each control, then it has a label, is operable from the keyboard, announces errors and uses external strings.

**Evidence (criteria 2 and 4, lane V-FRW-073-089, 2026-11-13, component level):** `packages/ui/src/components/FieldPropertiesPanel.svelte` is the panel, on the form model `packages/ui/src/shell/field-form.ts` and the gate `packages/ui/src/shell/field-properties.ts`. Browser, Playwright in Chromium, Firefox and WebKit: `packages/ui/e2e/frw-073-panel.spec.ts` (6 tests, 18 runs; `DOCEDIT_UI_PORT=57433 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-073-panel.spec.ts`), served from the harness page `packages/ui/e2e/harness/field-properties.html`. Criterion 2: a duplicate key, a bad validation limit and a value that is not a JSON object each show their reason in a live region, set `aria-invalid`, and commit nothing. Criterion 4: with the panel read-only, every control and Apply are disabled; the mapping from the user's state is `fieldPanelReadOnly` (`packages/ui/test/field-properties.test.ts`). Not shown in the browser: the assignee and duplicate-option reasons (in the Node gate test). Criteria 1, 3 and 5 stay open: the panel is not yet wired into the app (no selected-field source, no commit through the core, so no undo or history), and keyboard operation of each control, beyond the path to Apply, is not tested.

**Evidence (lane w4, 2026-11-17, criteria 1, 3 and 5; the panel is wired into the app):** `packages/element/e2e/frw-073-field-properties.spec.ts` runs the real element (shell, core, in-memory backend with the real authority) in Chromium, Edge, Firefox and WebKit (`pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-073-field-properties.spec.ts`, 3 tests in each, 12 of 12 passed). Criterion 1: an editor selects a field (its control takes focus) and opens the pane (`packages/ui/src/panes/FieldsPane.svelte`, the service `packages/element/src/field-properties.ts` over `editField` and `fieldProperties` of the core); one labelled control is shown for each of the twelve properties, the assignee list offers the document's roles by name, and no control for `sensitive` exists; key, kind, label, assignee, required, read-only, default, placeholder, options (one per line), format, validation and width are edited, and the confirmed document holds each as an attribute of the field (a text field made a choice, with its options and a default that is an option id; a number field given a format). Criterion 3: each Apply is one commit (the confirmed sequence number goes up by one) of attribute steps; one undo takes all of it back as one more commit; the content at the earlier sequence number, read from the service, still holds the old key. The History pane was not opened: the mock backend offers no `history` feature, so "appears in history" is shown as the log's content at the sequence numbers. Criterion 5: every control has a label from the string catalogue (`field.prop.*`, `field.problem.*`, `field.panel.*` in `packages/ui/src/i18n/en-GB.ts`), Tab visits them in order and then Apply, a text field, a select, a checkbox and a text area are operated with the keyboard, the reasons are in a `role="alert"` with `aria-invalid` on the control, and axe finds no WCAG 2.2 A or AA violation on the pane with the reasons shown (not run in Firefox: axe crashes Playwright's Firefox build on that state, noted in the spec).

**Notes:** Phase inferred (see FRW-072). What happens to the value when the `kind` changes or an option that is the current value is removed is not specified (Open questions). Round 7 (packet U, 2026-11-13): the panel's gate is built as plain functions in `packages/ui/src/shell/field-properties.ts` and tested in `packages/ui/test/field-properties.test.ts`: `validateFieldDraft` gives the reasons for a duplicate key, an assignee that is not a role, duplicate or empty option identifiers, a choice without options, a bad validation limit and a bad width; `fieldPatch` gives only the changed attributes; `fieldPanelReadOnly` gives read-only without `edit` or in `sent` or `in_progress`. Lane V-FRW-073-089, round 4 (2026-11-13): the panel component is built (`packages/ui/src/components/FieldPropertiesPanel.svelte`, form model `packages/ui/src/shell/field-form.ts`, harness `packages/ui/e2e/harness/field-properties.html`), and criteria 2 and 4 are ticked on its browser run (see the Evidence line). Still open: the panel is not yet registered in `App.svelte` and has no selected-field source (criterion 1 needs both), the commit is not yet sent through the core, so the undo and history of criterion 3 are not checked, and criterion 5 needs each control's keyboard use tested, not only the path to Apply. The app wiring edits the shared `App.svelte` and the core, which this lane does not own (needsFromOthers). Open choices made in the gate, to confirm: an empty `key` is refused (the spec states no key grammar; CDM-002 may decide one); `validation` limits are decimal strings and `minLength`/`maxLength` are non-negative integers, as 12 §3.2 example shows; `pattern` and `preset` are not checked yet; `format` is not checked, since its members (decimals, prefix, suffix, date pattern) are not fixed in 12 §3.2 beyond their names. Error text keys are not added to the strings yet. Audit (2026-11-13): criterion 4 is unticked because nothing connects a user's `edit` capability or the workflow state to the panel: `fieldPanelReadOnly` is imported only by its own Node test and the panel is mounted only by its test harness with a hand-set `readOnly` flag, so "a user without `edit`" is never exercised; tick it when the panel is wired to the user's access and the workflow state and a test shows it. Stabilisation (2026-11-13): the panel moved from `src/panes/` to `src/components/`, since it takes its own props, not `PaneProps`, and is not a pane of the pane table (UX-070's check covers every component in `src/panes/`); when it is wired in, it is the content of the `fields` pane or a dialog, loaded on demand. Lane w4, 2026-11-17: the panel is registered as the `fields` pane, has a selected-field source and commits through the core (criteria 1, 3 and 5 are ticked, see the Evidence). Criterion 4 stays unticked for its second half: a user without `edit` gets the pane read-only (tested with a commenter), but the workflow state that makes it read-only in `sent` and `in_progress` has no source: `fieldPanelReadOnly(canEdit, workflow)` takes it from the service's optional `workflow()`, which the element does not provide because no workflow runs yet (FRW-025 onwards), and the mock backend has none to show. What happens to the value when the kind changes is the proposed rule recorded in `packages/engine/test/frw-073.field-edit.test.ts` (a value of the old kind is cleared), still to be confirmed.

### FRW-074 Manage roles with colour and icon

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 12 §11 (authors), §3.1, §3.6 (I13); PRODUCT (accessibility) · **Requirements:** R13, R11 · **Depends on:** FRW-001, FRW-005

As an author, I want to create, rename and recolour roles and see each role marked by colour and an icon, so that I can tell roles apart without relying on colour.

**Acceptance criteria**

- [x] Given the roles manager and `structure`, when I create, rename or recolour a role, then a `role_def` is added or changed; given a role that fields still reference, when I try to delete it, then the delete is refused and the references are listed (I13).
- [x] Given every role, then it is shown with its colour and a distinct icon, never colour alone, in the manager, in field markers and in the legend.
- [x] Given the light, dark and high-contrast themes and `forced-colors`, then role markers meet non-text contrast and use system colours with the icon or outline when forced.
- [x] Given a role, then every field marker carries the role's name as text for assistive technology.
- [x] Given a user without `structure`, then the manager is read-only.

**Evidence (criteria 1, 2 and 5, lane w4, 2026-11-15):** The roles manager is `packages/ui/src/panes/RolesPane.svelte`, the pane `roles` of the pane table, opened by the command `view.roles`; it reads and changes roles through `CoreApi.roles` (`RolesService`), which the element builds over the core (`packages/element/src/roles.ts`), and the core's `editRole` makes each change as a transaction on the definitions (`packages/engine/src/role-edit.ts`). Node.js: `packages/engine/test/frw-074.role-edit.test.ts` (7 tests) on the real headless core: a role is added as a `role_def` after the others and the document stays valid; a rename and a recolour change one attribute each; a value its grammar refuses is reported by attribute and nothing changes; deleting a role that fields name is refused with those fields, deleting an unused one removes it (criterion 1); a participant who may only fill and a user who may edit the body but not the definitions get `read-only` for every change and the document is unchanged (criterion 5). Browser, the real element with the shell and the mock backend on the embed page: `packages/element/e2e/frw-074-roles-manager.spec.ts` (3 tests), run on this Windows machine with `DOCEDIT_DEMO_PORT=47916 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-074-roles-manager.spec.ts` in Chromium, Edge, Firefox and WebKit, 12 passed. An editor opens the manager by the command search, adds a role with the keyboard, renames and recolours one, is refused the deletion of a role in use and sees its field listed, and deletes an unused role; each change is read back from the confirmed document, so it went through the log (criterion 1). Each role in the manager has a shape in its colour, its name as text and the shape's name as text, and the shapes of the three roles differ; in the fill pane each field marker has the role's shape and the role's name, and the legend lists each role once by shape and name (criterion 2). A commenter sees the list and the manager holds no button and no form control (criterion 5). axe reports no violation of WCAG 2.2 A or AA in the manager.

**Evidence (criterion 3, lane V-FRW-073-089, 2026-11-13):** Browser, Playwright in Chromium, Firefox and WebKit (`DOCEDIT_UI_PORT=56435 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-074-markers.spec.ts packages/ui/e2e/frw-074-dark-contrast.spec.ts`). `packages/ui/e2e/frw-074-markers.spec.ts` passes the light and high-contrast themes (3:1 measured from the computed colours) and the forced-colours check (Chromium only; the other browsers skip it). `packages/ui/e2e/frw-074-dark-contrast.spec.ts` passes the dark theme: the dark theme now lightens the marker shape towards white with `color-mix` (`packages/ui/src/styles/shell.css`, `.de-shell[data-theme='dark'] .de-role-icon`, only when `forced-colors` is not active), which gives about 8:1 against the dark surface. The lightening is a proposed design choice, recorded in docs/adr/0343-lane-V-FRW-073-089.md. The dark test with `test.fail` in `frw-074-markers.spec.ts` is now stale: its parser does not read the `color(srgb …)` form, so it still reports a ratio of 0 and does not reach the real value; the owner or the lane that wrote it should retire that `test.fail`.

**Evidence (criterion 4):** packages/ui/test/fields.test.ts, "gives every marker that names a role the role colour and an icon, and the role name as text (FRW-074 criterion 4)" (property over fields: the marker's accessible name contains the role's name, and its colour and icon are the role's). Node run 2026-11-13 by lane ui-4: `pnpm vitest run packages/ui/test/fields.test.ts`, 11 passed. The markers are drawn by packages/ui/src/panes/FillPane.svelte, and the FRW-077 browser run (packages/ui/e2e/regions.spec.ts) checked the drawn names; that run is cited from FRW-077 and was not repeated here.

**Notes:** Lane w4 (2026-11-15): criteria 1, 2 and 5 are ticked (see Evidence), so all five are. What the ticks rest on, and what is proposed and not decided: (a) the icon is still the shell's default of ADR 0113, derived from the role's place in the list over eight shapes, so the icons are distinct for the first eight roles of a document and repeat after that; the manager also writes the shape's name as text. A document with more than eight roles needs the owner's answer on where the icon comes from. (b) "Field markers" are the markers of the fill pane (as for criterion 4); the field controls in the editing surface carry no role marker of their own. (c) The legend is in the fill pane, built from the roles of the fields the reader is shown; the manager's own list is the legend for an author. (d) A new role gets the identifier `role_<n>` for the least free `n`; an identifier is never changed. (e) The colour grammar of the CDM takes upper-case digits, so the element writes the colour control's value in upper case. (f) The pane is offered whenever the element is, whatever features the backend lists; in a document that does not require `fields` adding a role is refused with a stated reason. Earlier notes follow. Phase inferred (roles must exist before fields can be assigned in 1b). `role_def` has `id`, `name` and `color` but no icon attribute; where the icon comes from (derived from order, or a stored extension) is open (Open questions). Round 2 (packet U, 2026-11-13): `shell/fields.ts` derives the icon from the role's order over a fixed set of eight icon names (`roleIcon`), so the first eight roles have distinct icons. This is the shell's default, not a decision the spec makes; it goes to the owner in ADR 0113 (round 2). Lane ui-4 (2026-11-13): criterion 4 ticked (see Evidence). Criteria 1, 2, 3 and 5 stay open: the roles manager, its legend and its delete refusal are not built, and the forced-colours and high-contrast check (criterion 3) was not run in a browser. Lane U-FRW-073-089, round 2 (2026-11-13): criterion 3 measured in Chromium, Firefox and WebKit by `packages/ui/e2e/frw-074-markers.spec.ts` (WCAG ratio of each marker against its surface). Light and high-contrast pass the 3:1 check; the dark theme does not: the author colour `#0d47a1` gives about 1.8:1 on the dark surface, recorded as `test.fail` and in docs/adr/0343-lane-U-FRW-073-089.md. Criterion 3 stays unticked until the dark-theme colour rule is decided (owner or UX); forced colours pass in Chromium. Criteria 1, 2 and 5 are unchanged.

### FRW-075 Preview the document as a role

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Author |

**Spec:** 12 §11 (authors), §5.3 · **Requirements:** R13 · **Depends on:** FRW-016, FRW-023, FRW-076, FRW-074

As an author, I want to preview the document as a given role would see it, so that I can check which fields and messages that role gets before I send.

**Acceptance criteria**

- [ ] Given I choose a role to preview, then the editor shows the document as in fill mode for a participant holding only that role: read-only body, that role's fields fillable, other roles' fields labelled, rules evaluated with that role for the `role` operand.
- [ ] Given I enter values in the preview, then no commit is submitted and the document's values are unchanged when I leave.
- [ ] Given I leave the preview, then the caret returns to where I was.
- [ ] Given the preview is active, then the mode is announced to assistive technology and the control to leave it is always reachable by keyboard.

**Notes:** Phase inferred (it depends on rules and roles in the workflow context). Lane U-FRW-073-089, round 3 (2026-11-13): not taken. Criterion 1 needs the fill mode for a role (FRW-069, outside this range), and the other three need the preview wired to the core and the shell. Lane FRW-066-078, round 3 (2026-11-13): `packages/ui/src/shell/role-preview.ts` is the model of the preview (start and end, the role's fields only, an overlay of typed values that is never a commit, the caret kept), tested in `packages/ui/test/role-preview.test.ts` (fast-check, 5 passed in Node). No criterion ticked: the editor does not draw fill mode for a role (FRW-069 is not built), the core does not evaluate rules with a role operand in a preview, and nothing announces the preview or puts a keyboard control on screen (criterion 4). The model is not wired to the core, so the no-commit and caret criteria are not met in the editor. Messages and the announcement string are not added to `en-GB.ts` yet.

## Frontend for participants (12 §11)

### FRW-076 Fill a document with a guided bar

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Participant |

**Spec:** 12 §11 (participants), §10 (`mode="fill"`); PRODUCT (users); 07 §7; 02 §3 · **Requirements:** R13, R3, R11 · **Depends on:** FRW-007, FRW-008, FRW-079, FE-036, FE-008, FE-010

As a participant, I want a read-only document with a bar that takes me from field to field, so that I fill what is mine and nothing else and know when I am done.

**Acceptance criteria**

- [x] Given I open a document in fill mode, then the body is read-only, only the fields assigned to my roles are editable, and the region guard refuses every other local transaction, so I normally never see a rejection.
- [x] Given the guided bar, then it shows "n of m" (the required fields I have filled out of those I must), a control that moves to the next required unfilled field and a control to finish.
- [x] Given Tab and Shift+Tab, then they move between my fillable fields in document order; Escape leaves the editing surface and Ctrl+F6 cycles the main regions.
- [x] Given a rejected fill (`conflict`, `field_invalid` or `permission_denied`), then the control shows the current value or the message and a live region announces it; nothing is dropped silently.
- [ ] Given I type a value and close the tab before it is acknowledged, when I return, then the value is offered as a recovered edit.
- [x] Given another participant or the author changes the document, then I see the change without a reload and the counts update.
- [ ] Given my participant is not active (waiting for an earlier order, or paused), then the bar says so and my fields are read-only; when I become active, `wf.changed` makes them fillable without a reload.
- [ ] Given I type into a field of a 100-page document, then keystroke-to-paint stays inside the budget (16 ms median, 50 ms at the 95th percentile, targets).

**Evidence (lane w4, 2026-11-17):** `packages/element/e2e/frw-076-guided-bar.spec.ts` runs the real element (shadow root, embed page, in-memory backend) in Chromium, Edge, Firefox and WebKit (`pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-076-guided-bar.spec.ts`, 7 tests in each, 28 of 28 passed). Criterion 1: a participant who may only fill (`vic`, role tenant) has editable tenant controls and a read-only landlord control, typing in the body changes nothing, and a value forced into the landlord's control is not stored; the core's own refusal is `packages/engine/src/frw-076.fill-guard.test.ts` (guard) with `fieldFillable` in `packages/engine/src/core.ts`. A control now follows the access when it arrives after the view is drawn (`accessChanged` of the view bridge in `core.ts` and `view/web.ts`); before, the landlord's control stayed editable in the real element. Criterion 2: "0 of 2 required fields filled", the control "Next field to fill" moves to the name and then the e-mail, "All required fields are filled." shows at 2 of 2, and Finish with fields left opens the summary pane (the bar is `packages/ui/src/components/FillBar.svelte`, the count `packages/ui/src/shell/fill.ts`). Criterion 3: Tab and Shift+Tab visit amount, name and e-mail in order and never the landlord's control (a control that may not be filled has `tabindex="-1"`, `form-field-view.ts`), Escape takes focus off the editing surface, and Ctrl+F6 moves focus to more than one part of the editor. Criterion 4: with the room holding its writes, the author's fill is stored first and the participant's fill of the same field is rejected with `conflict`; the control shows the author's value, the notice and the status live region say "This field was changed by someone else, so your entry was not saved. The field now shows the current value. Your entry is kept in recovered edits." (FRW-010 criterion 5); a `field_invalid` entry stays on screen with its message in a `role="alert"` element (`packages/engine/src/view/frw-004-field-control.universal.test.ts`); `permission_denied` is the guard's, which a participant does not meet (criterion 1). Criterion 6: the author's fill of the e-mail shows in the participant's control without a reload, the count goes from 0 of 2 to 1 of 2 and the next field becomes the name. Criterion 7, first half: a participant who is not active (`fillBackend(sub, roles, false)` in the embed page) sees "It is not your turn yet. Your fields open when it is.", read-only controls and no "next" control.

**Notes:** Phase from 12 §13 (`mode="fill"`). The fillable fields are derived on the client from `assignee` and the rules (`access.fill` lists no fields). Finish when there is no workflow is FRW-083. Page-view rendering of fields is FE's (phase 3, spike S9). Lane FRW-066-078, round 1 (2026-11-13): criterion 1 is not met locally. `checkChange` in packages/engine/src/guard.ts (around line 232) lets any access with `fill` pass a changed field value, whatever the field's `assignee`, so a participant can edit another role's field until the authority refuses it (P7, FRW-008). The guard needs the participant's roles and each field's assignee (engine owner). See docs/adr/0252-lane-FRW-066-078.md, finding 1. Lane V-FRW-073-089, round 3 (2026-11-13): the region guard (packages/engine/src/guard.ts, `fillMayChange` and `editsText`) now refuses, for a user with `fill` but neither `edit` nor `suggest`, every change outside a form field, and a field value change unless the field's `assignee` is one of `fill.roles`, the participant is active and the field is not `readOnly`. Tested in packages/engine/src/frw-076.fill-guard.test.ts (Node, 4 passed; the guard is called directly through `checkChange`), with packages/engine/test/guard.test.ts and nine related engine guard and suggestion test files (64 passed). Criterion 1 stays unticked: the core locks every local change in `fill` mode (packages/engine/src/mode.ts, `modeLocks`), so the core has no field fill path yet and the editor does not show a read-only body or the bar's refusal. The rule P7 check here is local and partial (no rule-based `enabled` check); the authority remains the boundary (decision recorded in docs/adr/0343-lane-V-FRW-073-089.md). Criteria 2 to 5 (the bar, Tab order, the rejection live region, the recovered edit, the live change) are not changed in this round. Lane w4, 2026-11-17: criteria 1 to 4 and 6 are met and tested (see the Evidence). Criterion 5 stays unticked and needs the owner: a value typed and not acknowledged is kept in the journal and is resubmitted, once, when the document is opened again (FE-009), so it is not lost, but it is not "offered as a recovered edit"; the journal offers a recovered edit only for work the server refused or that no longer applies (FE-010). Proposed rewording, for the owner: "I type a value and close the tab before it is acknowledged; when I return, the value is saved once, and offered as a recovered edit if it no longer applies." Criterion 7 stays unticked for its second half: `wf.changed` and a participant who becomes active belong to the workflow (FRW-025 and after), which is not built; the first half is tested. Criterion 8 stays unticked: no measurement of keystroke-to-paint on a 100-page document with a form was taken in this round, and a figure without one would be invented. Finish does nothing beyond opening the summary or announcing `fill.finishFailed`, because `finishFill` is not wired in the core: what it does without a workflow is FRW-083 and FRW-069.

### FRW-077 See which fields belong to other roles

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Participant |

**Spec:** 12 §11 (participants); PRODUCT (accessibility) · **Requirements:** R13, R11 · **Depends on:** FRW-074, FRW-076

As a participant, I want fields that belong to other roles labelled with the role's name, so that I understand why I cannot fill them.

**Acceptance criteria**

- [x] Given a field assigned to a role I do not hold, then it is shown read-only with the role's name as visible text and the role's colour and icon, and its accessible name includes the role and the label.
- [x] Given a field assigned to my role, then it is marked as mine.
- [x] Given a field with no assignee, then it is read-only for me.
- [x] Given `forced-colors` or the high-contrast theme, then the markers use system colours with the icon or outline.
- [x] Given the labels, then they are external strings.

**Review (round 2, group 3):** criteria 2 and 3 were unticked. Nothing calls `fieldMarker`, so no field is marked as mine and none is made read-only for the participant; criterion 1 is open for the same reason. Criterion 5 stays ticked on the strings alone. Also, a field of the participant's own role with no role information is named "<label>, A role you do not hold" (`field.name.mine` with `field.role.hidden`), which is wrong for their own role.

**Evidence:** packages/ui/src/panes/FillPane.svelte draws a marker for every field the core lists, from `fieldMarker` (packages/ui/src/shell/fields.ts), and the bar and the summary count and lead only to the participant's own fields (`ownFields` in `fillProgress`, packages/ui/src/shell/fill.ts). Browser: packages/ui/e2e/regions.spec.ts 'marks my fields as mine and keeps other roles’ and unassigned fields read-only (FRW-077)' passed in Chromium, Firefox and WebKit (Playwright, 2026-11-13): my field shows "Yours", is not read-only, is named "Income, Tenant, yours to fill in" and is the bar's next field; an unassigned field shows "No role" and "Read-only", has no icon and is not counted; a field of another role shows its name, icon, colour and "Read-only"; my field turns read-only while I wait. Node: packages/ui/test/fields.test.ts ('role markers for a participant') and packages/ui/test/fill.test.ts ('fields that are not the participant’s', with a property that the bar never leads to another role's or an unassigned field).

**Evidence (criterion 4, lane U-FRW-073-089, 2026-11-13):** packages/ui/e2e/frw-077-078.spec.ts, "keeps each shape visible as a system colour, not lost to the page background (FRW-077 criterion 4)". Chromium only (`forcedColors: 'active'` is emulated there; the test skips in Firefox and WebKit). Run with `DOCEDIT_UI_PORT=56431 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-077-078.spec.ts`: passed. The test checks that each role icon has a painted background that differs from its row, for the two roles in the list. It does not check that the colour is a named system colour (CanvasText or similar), and it does not check the high-contrast theme.

**Notes:** Phase inferred (it belongs to the fill-mode experience of 1b). Round 2 (packet U, 2026-11-13), criteria 2, 3 and 5 ticked on the marker model. Criterion 1 stays open: the marker model gives the read-only state, the role name, the colour and the icon, but the visible text and the markers are not drawn yet (FillPane and FillBar). Criterion 4 is the element's forced-colours work. The core must list every field of the document, not only the participant's own, for markers of other roles to exist; `FillSummary.fields` lists only the participant's fields today (needsFromOthers for the engine). Field and role data come through the optional `assignee` and `role` of `FillField`, and the participant's roles through `FillSummary.roles` (ADR 0113, round 2). Round 2 fix (group 3, 2026-11-13): criteria 2 and 3 re-ticked on the drawn pane. A field the core lists without `assignee` is the participant's own (a core that lists only those). A field of their own role with no role information is now named "<label>, yours to fill in". Read-only here is the shell's part: the pane marks the field and the bar never leads to it; refusing a change to it stays the core's region guard (FRW-076 criterion 1). Criterion 1 earlier waited for the engine to list every field with `assignee` and `FillSummary.roles`, and for the field node views to carry the marker (FRW-079); the shell's part is now drawn. Lane ui-4, round 4 (2026-11-13): criterion 1 ticked. The FillPane draws the role name as visible text, the colour and icon, and a read-only state, and the accessible name holds the role and the label; the Chromium test "marks my fields as mine and keeps other roles' and unassigned fields read-only (FRW-077)" in `packages/ui/e2e/regions.spec.ts` passed on this run (`-g "FRW-077" --project=chromium`, Playwright 4 passed on a rerun; one earlier attempt in the shared tree failed on a timing check and passed on the rerun). Criterion 4 (forced colours) is ticked by lane U-FRW-073-089 (see its Evidence line): Chromium only, and it checks visibility, not the system colour name.

### FRW-078 Review required and invalid fields in a summary

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Participant |

**Spec:** 12 §11 (participants) · **Requirements:** R13, R11 · **Depends on:** FRW-004, FRW-076

As a participant, I want a summary of what is still required or invalid, with links, so that I can finish without hunting through the document.

**Acceptance criteria**

- [x] Given I open the summary from the bar or by activating finish with problems, then it lists every required-and-empty and invalid field of mine with its label, the reason and a link.
- [x] Given I activate a link, then focus moves to the field and it scrolls into view.
- [x] Given I fix a field, then it leaves the list at once; given the list is empty, then a status says nothing is left and a live region announces it.
- [ ] Given the list, then its count matches the "n of m" shown in the bar.
- [x] Given a keyboard or a screen reader, then the summary is reachable, operable and returns focus to where I was when closed.

**Evidence (criterion 1, lane V-FRW-073-089, 2026-11-13):** Browser, Playwright in Chromium, Firefox and WebKit: `packages/ui/e2e/regions.spec.ts`, "the summary lists what is left, with links, and agrees with the bar" (`DOCEDIT_UI_PORT=56431 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/regions.spec.ts -g "summary lists"`). It opens the summary from the bar, checks each listed field's label and reason as rendered ("Required, not filled", "Out of the allowed range"), and checks that the link calls `focusField` with the field. Firefox and WebKit passed; Chromium passed on its retry (the first attempt failed while closing its browser context, a trace file write in the shared test-results folder, not an assertion). The "of mine" scope is covered by `packages/ui/test/fill.test.ts` (Node) and the FRW-077 browser run. Criterion 2 (focus and scroll) stays open: the harness stubs `focusField` and records the call, so focus movement is not observed. Unticked by the reviewer (group 1, round 1): the spec opens the summary from the bar only. The second entry the criterion names, activating Finish with something left (`finishFill` in `packages/ui/src/App.svelte`), is not tested: the comment "Finishing with something left opens the summary instead" in the spec precedes a step that first marks every field filled, so Finish then runs `finishFill`. Tick again when a test activates Finish with a required field empty and sees the summary open.

**Evidence (criterion 1, fixer V4 group 1 round 1, 2026-11-13):** the second entry is now tested. `packages/ui/e2e/regions.spec.ts`, "finishing with a required field empty opens the summary and does not finish (FRW-078)": with "Date of birth" required and empty and "Amount" out of range, activating Finish in the bar opens the fill pane (the "What is left" toggle is pressed), the pane lists both fields with their labels and reasons, `finishFill` is not run (`h.named()` is empty), "You have finished." is not announced, and the first link calls `focusField('f2')`. The misleading comment in the bar-entry test is corrected. Run: `DOCEDIT_UI_PORT=57431 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/regions.spec.ts -g "summary|Finish"`, 6 passed (both tests in Chromium, Firefox and WebKit).

**Evidence:** criterion 1 (round 2, 2026-11-13): packages/ui/test/fill.test.ts 'lists every required-and-empty field and every invalid field, in document order', 'why a field is listed' (each listed field has a label and a `fill.why.*` reason key, property test), and 'the list changes as fields are fixed' (a fixed field leaves the list at once; never lists a fixed field, property test). Criterion unticked in review (round 6): the tests cover the list and the reason keys only; the link (FillPane button calling focusField), the label and reason as rendered, and opening the summary from the bar or by finish are not tested (no test or e2e spec touches FillPane). Tick it when a component or browser test covers them.

**Evidence (criterion 3, lane U-FRW-073-089, 2026-11-13):** packages/ui/e2e/frw-077-078.spec.ts, "a fixed field leaves the list at once, and the empty status is a live region (FRW-078 criterion 3)". Run in Chromium, Firefox and WebKit (`DOCEDIT_UI_PORT=56431 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-077-078.spec.ts`): 4 passed. Fixing the invalid amount alone removes that row and leaves the other; fixing the last field empties the list, and the "Nothing is left to fill." text sits in a `role="status"` element. The live announcement is the status role's implicit polite live region, not checked with a screen reader.

**Evidence (criteria 2 and 5, lane w4, 2026-11-17):** `packages/element/e2e/frw-078-summary.spec.ts`, in the real element and its shadow root against the embed page's backend, run in Chromium, Firefox and WebKit (`DOCEDIT_DEMO_PORT=58478 pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-078-summary.spec.ts --project=chromium --project=firefox --project=webkit --retries=0`, 9 passed). Criterion 2: the field's paragraph is pushed 4,000 px down so its control is outside the viewport; activating the "E-mail" link in the summary focuses that control (`focusField` of the core, not a stub) and the control is then in the viewport; a second link does the same for "Name". Criterion 5: the "What is left" control is focused and opened with Enter and with Space; the pane is a named landmark (`aria-labelledby`), its links are buttons whose names begin with the field label and carry the reason; Enter on a link moves focus to the field; Escape in the pane, and its Close button, close it and focus returns to the "What is left" control.

**Notes (lane w4, 2026-11-17):** Criterion 4 stays unticked: the open question of ADR 0113 (an invalid optional field is listed by criterion 1 but not counted in the bar's "n of m") is not among the owner's decisions of 2026-11-15 or 2026-11-17, so the owner has not answered. The code keeps option (a) of ADR 0113 (the list shows required-and-empty and invalid fields; the bar counts required fields), and `test/fill.test.ts` pins it. Criterion 5 is shown with the keyboard and the accessible names and roles; no screen reader (NVDA, JAWS, VoiceOver) was run, and the criterion's "or" is read as keyboard or screen reader.

**Notes:** Phase inferred (it belongs to the fill-mode experience of 1b). Packet U, round 1 (2026-11-13): `shell/fill.ts` builds the bar's counts and the summary list from one function, and `test/fill.test.ts` checks it. Criterion 4 is not ticked, because it conflicts with criterion 1 for an invalid optional field: criterion 1 lists it, while the bar's "n of m" counts required fields only, so the list is then one longer than the bar's remainder. The test pins this case and it is an open question for the owner (ADR 0113). Criteria 1 to 3 need the summary view and the focus handling in FillPane and FillBar, not checked in a browser in this round. Round 2 (packet U, 2026-11-13): criterion 1 ticked on the list and reason tests above. Criterion 3 is ticked by lane U-FRW-073-089 (see its Evidence line): the browser run covers the list and the status region in three browsers. Criterion 2 (focus and scroll) is the core's `focusField` and the browser run; criterion 5 needs the browser run.

### FRW-079 Operate every field by keyboard and assistive technology

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Participant |

**Spec:** 12 §11 (accessibility, web view), §3.2 (`format`); 02 §10 · **Requirements:** R13, R11, R2 · **Depends on:** FRW-002, FRW-003

As a participant who uses a keyboard or a screen reader, I want every field to be a labelled, native control, so that I can fill the document without a pointer.

**Acceptance criteria**

- [ ] Given a field in the web view, then it is a node view containing a native control in the same shadow root, with an accessible name taken from `label`, `aria-required` when it is required (statically or by a rule) and `aria-invalid` with an associated message when it is invalid.
- [x] Given each kind, then `text` is a text input that honours `maxLength`, `number` accepts a decimal entry, `date` accepts and shows a calendar date, `checkbox` toggles with the Space key and `choice` offers the option labels while the stored value is the option `id`.
- [ ] Given a screen reader, then moving to a field announces its name, kind, required state, invalid state, value and the role it belongs to.
- [x] Given `format` (decimals, prefix, suffix, date pattern), then it changes only the display and the stored value is unchanged.
- [x] Given keyboard only, then focus is visible, there is no trap, and Escape leaves the editing surface.
- [x] Given axe, then it reports no violations on a form with every kind of field.

**Evidence (lane w4, 2026-11-17):** criterion 2: `packages/engine/src/view/form-field-view.ts` (the node view; the text control stops at `maxLength` counted in code points, a number is a decimal entry, a date a calendar control, a choice stores the option id) and `packages/engine/src/view/frw-079-field-controls.universal.test.ts`, run with real key presses in Chromium, Firefox and WebKit (`DOCEDIT_BROWSERS=chromium,firefox,webkit pnpm exec vitest run --project browser <file>`, 12 of 12 each): typing past the limit, a decimal entry, a date, Space on a checkbox, a choice. Criterion 4: `packages/engine/src/field-display.ts` and `field-display.test.ts` (decimals rounded half up in decimal, prefix, suffix, date pattern) and the same browser file: a formatted control shows the format only while nobody edits it, and the stored value and the entry are the unformatted ones. Criterion 5: `packages/element/e2e/frw-079-accessibility.spec.ts` in the real element and its shadow root (Chromium, Edge, Firefox and WebKit through `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/frw-079-accessibility.spec.ts`): every control has a computed outline when the keyboard focuses it (`.de-form-field-control:focus-visible` in `packages/element/src/styles/element.css`), Tab walks through the five controls, and Escape takes focus off the editing surface (the shell's FE-103 handling); the browser file checks Tab and Shift+Tab through the controls and out of them. Criterion 6: the same spec runs axe (`@axe-core/playwright`) on the editing surface of the embed page's document with a field of every kind (`kindsDocId` in `packages/element/demo/embed-page.ts`), empty and with an invalid entry, and finds no violation in the four engines. Criterion 3 (partly, see Notes): the same spec reads Chromium's accessibility tree through the protocol.

**Notes:** Phase inferred (fields are in 1b form mode). The input-method matrix of spike S1 (composition in text fields inside the shadow root) applies to these controls. Painted widgets in the page view and how assistive technology reaches them belong to FE and spike S9. Lane FRW-079-089, 2026-11-13: no node view or native control for `form_field` exists in `packages/engine/src` or `packages/element/src` (the engine schema declares the node; the layout, the model and the exporters handle its data). Criteria 1 to 6 need those node views and a browser run for the screen reader and axe checks, so none is ticked in this round. See docs/adr/0253-lane-FRW-079-089.md. Lane w4, 2026-11-17: the node view exists now (FRW-004, FRW-006), and this round adds what the criteria ask of it. Criterion 1 stays unticked: the name from `label`, `aria-required` for a static `required` and `aria-invalid` with a message are met (the FRW-004 tests), but "required by a rule" needs rules live in the editor, which is FRW-023 (it depends on this story); the control reads `required` from the field's entry state, which FRW-023 will make rule-aware. Criterion 3 stays unticked: the accessibility tree of Chromium holds the role, name, required and invalid state, value and a description that names the kind and the role ("Number field for Tenant", followed by the message when the entry is invalid), but no screen reader (NVDA, JAWS, VoiceOver) was run, and the criterion says what a screen reader announces. The description is text in `aria-description`, because no ID reference is set from script (FE-108); its words are English constants in `form-field-view.ts` (`KIND_NAMES`), not yet in the strings table. The WebKit build that Playwright runs on Windows has no calendar control (an input of type date is a text input there), so in that engine a date is typed as `YYYY-MM-DD`; the tests accept either. A date control has parts (day, month, year) that Tab visits before it leaves the control; that is the browser's, and it is not a trap. A date field with a `datePattern` shows the pattern in a text control until it takes focus, then the calendar control. The display code for a number repeats the rounding of `formatNumber` in `packages/export-latex/src/inline.ts` (EXP-033); sharing them is left to a later story.

### FRW-080 Keep line and page breaks stable while filling

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Participant |

**Spec:** 12 §3.2 (`width`), §14; 11 §10 (item 12) · **Requirements:** R13, R5 · **Depends on:** FRW-002, FRW-079, EXP-033

As a participant, I want filling a field never to move the text around it, so that the document I fill is the document that will be printed.

**Acceptance criteria**

- [x] Given a field with a `width`, then its box has exactly that width whatever it contains, and the line and page breaks of the surrounding text are identical before and after I enter a value (compared on the layout).
- [x] Given a value longer than the box, then the box does not grow and the surrounding text does not reflow.
- [x] Given a field without a `width`, then it takes a fixed default width declared with the schema.
- [x] Given `validation.maxLength`, then the control refuses characters beyond it, and a paste that exceeds it is cut at the limit and announced.
- [x] Given a PDF export of the same document with the field empty and filled, then the block-level page starts are the same.

**Evidence:** lane FRW-079-089 (2026-11-13): `packages/layout/src/frw-080.fill-breaks.test.ts`, "keeps the line and page breaks identical whatever the value is" (fast-check property, 100 runs; the breaks of a document with an empty field equal those with any filled value), "keeps the breaks for a value far longer than the box", and the control "is sensitive to the value when there is no width". Box part of criterion 1, at flow level: `packages/layout/src/frw-080.box-width.test.ts`, "draws one preserved inline box of exactly the width, with a value" (144 pt for `width` 2880 twips, fast-check, 100 runs) and "gives the same inlines for every value". Criteria 1 and 2 stay unticked: see Notes.

**Evidence (lane w4, 2026-11-17):** Layout, Node.js: `packages/layout/src/frw-080.fill-breaks.test.ts` (the line of a paragraph that holds only the field is exactly `width / 20` pt wide for any value, property of 100 runs, and for a value far longer than the box; the whole tree geometry, not only the breaks, is identical for an empty, a short and a long value; a field with no `width` is a box of `FIELD_DEFAULT_WIDTH[kind] / 20` pt for every kind; a control shows that a wider box moves the tree) and `frw-080.box-width.test.ts` (flow level). The line breaker now sets a form field's box at its width (`BreakRun.width` in `lines.ts`, `FlowInlineBox.exactWidth` in `flow.ts`); before, the layout measured every inline box as one character. Web view, `DOCEDIT_BROWSERS=chromium,firefox,webkit pnpm exec vitest run --project browser packages/engine/src/view/frw-080-field-box.universal.test.ts` (9 of 9 in each engine; the first run of WebKit timed out on three clicks under load and passed alone and again in the combined run): the field's box measures `width` in CSS pixels whatever the control holds, the control fills the box, a 40-character entry with a problem message moves no field and no line (geometry of every field and of the paragraph compared), every kind has the default width, a typed entry stops at `maxLength`, and a paste is cut at the limit in code points, replaces a selection, announces itself in a `role="status"` region that the next key clears, and is stored when the control is left. PDF, Podman sandbox: `packages/export-latex/src/frw-080-page-starts.compile.test.ts` (`DOCEDIT_PODMAN_MACHINE=podman-machine-default DOCEDIT_REQUIRE_SANDBOX=1 DOCEDIT_CONTAINER_CGROUPS=disabled pnpm exec vitest run --project node <file>`, 4 of 4, 129 s on 2026-11-17, Windows host): a document of 60 paragraphs over at least three pages with a field in the middle of one gives the same first block and offset of every page, and the same line starts of every block, with the field empty, with a short value, with a value three times the box and with no `width`; a control with a field of 1 inch against 6 inches moves a line start. The page starts and line starts are the class's own report (`layout.json`, EXP-055), not an estimate.

**Notes (lane w4, 2026-11-17):** All five criteria ticked. The default width is not in the spec: it is proposed in `docs/adr/0380-w4-FRW-080-default-field-width.md` as a table by kind (`FIELD_DEFAULT_WIDTH`, twips, in `packages/model/src/definition/fields.ts`), read through `fieldWidth` by the layout, the web view and the PDF export. The figures are round sizes, not measurements, and the owner may change any of them; criterion 3 asks for a fixed declared default and does not name the value, so it is ticked on that reading. The stored `width` stays null when the author gave none. Side effects: the digests of the form-fields document in `layout.universal.test.ts` were recorded again (the same in Chromium, Firefox and WebKit), and a signature or initials field with no `width` is now drawn as its picture at the default width in the PDF. The paste notice is an English constant in `form-field-view.ts` (like `KIND_NAMES`), not yet in the strings table. The problem message and the notice of a field are taken out of the flow (absolutely positioned under the box), so that showing them moves no line. A value wider than the box is cut by the box in the PDF (the class warns `field_too_wide` in the log); EXP-033 criterion 6 (the job's warning with the field's identifier) stays that story's. Earlier notes of this story follow.

**Notes:** Phase inferred (the 12 §14 response to "filling moves page breaks"). The default for owner decision 12 ("fixed width") is the basis; if the owner chooses reflowing fields, this story changes. The default width value, and what is shown when a value is longer than the box, are not specified (Open questions). Lane FRW-079-089, 2026-11-13: the layout (`packages/layout/src/flow.ts`, `form_field`) draws a field with a `width` as a fixed box and ignores its value, and the test above pins the breaks. Criteria 1 and 2 stay unticked: the test asserts the breaks, not that the box itself is exactly `width` wide, and the tree does not expose the box's width. Criterion 3 is open: the default width is an open question, and the schema (`packages/model/src/definition/fields.ts`) declares `width` as `null` with no default. Criterion 4 (refusing and cutting input at `maxLength`) is the editor's, not built. Criterion 5 is the PDF export (EXP-033). Round 3 (2026-11-13): `packages/layout/src/frw-080.box-width.test.ts` shows at flow level that a field with a `width` is one preserved box of that width for every value; the drawn box on the page is not measured, so criterion 1 stays open.

## Export of fields (12 §12)

> FRW-081 (Flatten field values into the PDF) was merged into EXP-033 during the cross-check of 2026-11-06.

> FRW-082 (Export fields to DOCX content controls) was merged into EXP-095 during the cross-check of 2026-11-06.

## Decisions the backlog waits on (12 §15)

### FRW-083 Decide whether form mode without a workflow is the first slice

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Maintainer |

**Spec:** 12 §13 (phase 1b), §15 (question 3); 11 §4 · **Requirements:** R13 · **Depends on:** none

As a maintainer, I want the owner to confirm that form mode without a workflow is the first slice, and to fix what that mode means, so that the phase 1b stories are not built on a guess.

**Acceptance criteria**

- [x] Given the owner decides, then the decision and its date are recorded; if yes, the 1b stories FRW-001 to FRW-011, FRW-060, FRW-061, FRW-065 to FRW-067, FRW-069, FRW-070, FRW-072 to FRW-074, FRW-076 to FRW-080 and EXP-033 stay in 1b; if no, they move to phase 2 and this epic is re-sequenced.
- [x] Given a yes, then the name of the token claim that carries fill roles outside a workflow is fixed, and 05 §3.1 names it.
- [x] Given a yes, then the meaning of `access.fill.active` and of "participant is active" without a workflow is fixed.
- [x] Given a yes, then what "finish" and `completeFilling()` do without a workflow is fixed (for example validate and raise events only).
- [x] Given a yes, then it is recorded whether fields are authored in 1b through the editor (FRW-072 to FRW-074) or only through the API.

**Evidence:** owner decision 5 to 5d of 2026-11-15 ([docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)). 12 §13 (new subsection "Form mode without a workflow (phase 1b)") records the yes, the date, the stories that stay in 1b, the meaning of "active", finish and `completeFilling()`, and authoring through the editor; 12 §15 questions 2 and 3 are marked decided; 12 §4 rule P7 names the meaning of "active" without a workflow; 05 §3.1 gains the `wfr` claim row (configurable per tenant, `wfr` the default). `pnpm stories:check` passes. This is a decision story: nothing in it is executable, so no test exists.

**Notes:** 11 §4 already places form mode in 1b; the question stays open in 12 §15. Second review (2026-11-06, SPK-027), SR-M27 recommends a claim listing role placeholders (for example `wfr`) and "active" meaning "while the document is not locked" ([review](../review/2026-11-06-second-review.md)). Lane U-FRW-073-089, round 2: the spec default (form mode stays in 1b) and the second review's proposal are recorded as proposed in docs/adr/0343-lane-U-FRW-073-089.md; the owner has not decided, so no criterion is ticked. Lane w4 (2026-11-15): still blocked on the owner. Every criterion asks for the owner's own word (the yes or no, the claim name, the meaning of "active", what "finish" does, how fields are authored). The spec default (11 §4: form mode in 1b) keeps applying and the proposal in ADR 0343 stands as proposed; no new record was needed and nothing was ticked. Lane w4 (2026-11-17): the owner decided (decision 5 to 5d): yes, form mode without a workflow is the first slice; the claim name is configurable per tenant with `wfr` as the default (the owner asked for configurability and did not reject the proposed name; the file records this as a reading); "active" means while the document is not locked; "finish" is configurable per document with a tenant default, the default validating and raising events only, the other setting also making that person's fields read-only; fields are authored in 1b through the editor. All five criteria are ticked. Left open on purpose, because the owner did not name them: the CDM attribute of the per-document finish setting, the tenant setting for the default finish behaviour, and the tenant setting that holds the claim name. The stories that build them (FRW-065 to FRW-070) fix those names. Nothing in the code reads `wfr` yet.

### FRW-084 Decide the default evidence retention period

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 2 | S | must | Maintainer |

**Spec:** 12 §7, §15 (question 7); 08 §11; 13 §10 · **Requirements:** R13, R10 · **Depends on:** none

As a maintainer, I want a default retention period for evidence, so that the purge and erasure stories have a value and tenants can override it knowingly.

**Acceptance criteria**

- [ ] Given the owner decides, then the default period, the range a tenant may choose, and the relation to legal hold are recorded.
- [ ] Given the decision, then it is recorded whether the period counts from `completedSeq`, from finalisation or from the last reminder of a stopped workflow, and what applies to declined, voided and expired workflows.
- [ ] Given the decision, then the legal basis and the tenant-facing wording are agreed with counsel (FRW-087).

### FRW-085 Decide whether comments are switched off during a workflow

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 2 | S | should | Maintainer |

**Spec:** 12 §15 (question 9), §6.2; 07 §6; review §3.7 · **Requirements:** R13, R8 · **Depends on:** none

As a maintainer, I want the owner to decide whether comments stay on while a workflow runs, so that FRW-029 states one behaviour.

**Acceptance criteria**

- [ ] Given the owner decides, then it is recorded whether comments always stay on (the current behaviour), or whether a workflow or tenant setting can switch them off while the workflow is `sent` or `in_progress`.
- [ ] Given a setting is chosen, then its place (the workflow resource or the tenant), its default and the behaviour of existing threads are recorded.
- [ ] Given the decision, then FRW-029 and the conformance profile `workflow` are updated to match.

**Notes:** Comments never change the document, so they are technically harmless; some signing processes want a quiet document.

### FRW-086 Decide how a role writes a long formatted answer in a locked document

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 2 | S | must | Maintainer |

**Spec:** 12 §3.4, §4.3, §6.2; 07 §4 (limit 1) · **Requirements:** R13, R3 · **Depends on:** none

As a maintainer, I want the contradiction between "a long answer is a region granted to a role" and "send locks the document" resolved, so that FRW-012 can be finished.

**Acceptance criteria**

- [ ] Given the options (a bound participant may edit a granted region while the workflow is `sent` or `in_progress`; long answers are written before send; or the region is not part of the freeze), when the owner decides, then one is recorded with its effect on rule P7, on 07 §4 limit 1 and on the freeze at `sentSeq`.
- [ ] Given the decision, then it states how an edit by a role-granted participant is attributed, checked by the outcome check and kept stable under a signature.
- [ ] Given the decision, then 12 §6.2 ("the authority accepts only commits allowed by P7 and P8") and 07 §4 are corrected to agree.

**Notes (lane w4, 2026-11-17):** Nothing is ticked: the owner has not decided. `docs/owner-decisions-2026-11-15.md` and the answers added on 2026-11-17 do not list this story, and Part B of `docs/owner-blockers-2026-11-17.md` gives the proposed default (the participant may edit their granted region, option (a)), which the owner is to review before it counts as settled. The default is written out in `docs/adr/0381-w4-FRW-086-long-answers-under-a-lock.md` (proposed): its effect on P7 (none), on 07 §4 limit 1 (proposed wording), on the freeze at `sentSeq` (compared outside the role regions), how an edit by a role-granted participant is attributed (a commit by their `sub`, origin `edit`), and what holds under a signature (the signature names its own `seq`; a checklist warning is proposed). It also gives the proposed correction of the row "While `sent` or `in_progress`" of 12 §6.2. The spec files 07 and 12 are not changed, because criterion 3 follows the owner's decision. FRW-012 stays blocked on it.

**Notes:** The contradiction is described under Open questions. Second review (2026-11-06, SPK-027), SR-M26 recommends the first option: limit 1 of 07 §4 keeps `edit` in regions granted to a role whose participant is active ([review](../review/2026-11-06-second-review.md)).

### FRW-087 Obtain legal review of the signing claims before launch

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 2 | S | must | Maintainer |

**Spec:** 12 §8.3, §14; ADR 0013 (status); 11 §2 (notes), §9 (risk 15), §10 (item 11); PRODUCT (evidence on hand) · **Requirements:** R13 · **Depends on:** SPK-024, SPK-011

As a maintainer, I want counsel to review the signing language, the consent text, the certificate wording and the evidence record before launch, so that no claim goes out that the platform cannot support.

**Acceptance criteria**

- [ ] Given counsel reviews the interface strings, the documentation, the consent text, the certificate template and the evidence record against the target jurisdictions, then a written outcome is recorded.
- [ ] Given the outcome asks for changes, then they are made and the maintained phrase list of FRW-058 is updated.
- [ ] Given the first jurisdictions and the sealing party are chosen by the owner, then they are recorded with the outcome.
- [ ] Given no review has taken place, then the sealing and certificate features are not announced as available for production use.

**Notes:** ADR 0013 says it needs legal review before launch. The absence of a legal review is stated in PRODUCT.md and must not be filled with invented assurance.

## Read restrictions (ADR 0019)

Added on 2026-11-06 from spike S12 (SPK-029; `docs/spikes/2026-11-06-s12-read-restrictions.md`), after the owner decided that version 1 can hide regions and field values from some readers (SPK-005). Every other story that serves content, steps, positions, history, search, exports, comments, presence or field values applies the requester's projection: README §2.2 rule 8.

### FRW-088 Mark a field value sensitive and choose its readers

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Owner |

**Spec:** ADR 0019; 12 §3.2, §4 · **Requirements:** R13 · **Depends on:** FRW-002, CDM-053

As an owner, I want to mark a field's value sensitive, so that only the people who must read it can.

**Acceptance criteria**

- [x] Given a field, when a user with `manage` marks it sensitive, then its value is readable only by the field's assignee role, users with `manage` and principals named by a grant, and everyone else sees the redaction marker.
- [x] Given a user without `manage`, when they change `sensitive`, then the change is refused.
- [x] Given a reader who cannot read a value, then they cannot change it, and the editor shows the field as redacted, not as empty.

**Evidence:** lane U-FRW-073-089 (2026-11-13), criterion 3, editor half: `packages/engine/test/frw-088.redacted-field.test.ts` (4 tests, Node.js, `pnpm exec vitest run`) reads the `form_field` `toDOM` in `packages/engine/src/schema.ts`. A redacted value is drawn as `[redacted]` with `role="img"` and `aria-label="Redacted value"`, and an empty value as `[field]`, so the two differ. The body view takes this spec directly (no other `form_field` view was found). Not run in a browser.

**Evidence:** lane FRW-079-089 (2026-11-13), criterion 3 authority half: `packages/authority/test/frw-088.unreadable-changes.test.ts`, "refuses every attribute change by Carol to a sensitive field she cannot read" (fast-check property, 200 runs over the string, boolean and number attributes of the field, refusal with `permission_denied` and the scope of the field) and its control, "lets a reader of the same value change it". Criterion 3 is ticked for its editor half in lane U-FRW-073-089 (see the Evidence above). FE-141 criterion 2 (the screen-reader announcement in the web view) is still FE-141's.

**Evidence (earlier):** `packages/authority/test/visibility.test.ts`, "a sensitive value reaches only its readers": after the owner marks the tenant name sensitive through the room, the projection gives the value to the owner, the assignee's participant and the principals with a grant on its region, and the redaction marker to everyone else, while the full document keeps it; an editor's change of `sensitive` is refused with `permission_denied`. `test/outcome.fields.test.ts`: setting, clearing, or inserting a field with `sensitive` needs `manage` (`field.sensitive`). The marker and the placeholder are the model's: `REDACTION_MARKER`, `isRedactionMarker()` and `HIDDEN_REGION` in `packages/model/src/definition/projection.ts`, and `projectionSchema()`; a stored document or a commit that holds either is I1 (`packages/model/src/definition/definition.test.ts`, "refuses a hidden_region or a redaction marker in a stored document or a commit").

**Notes:** The default readers are ADR 0019's proposal; owner to confirm. This replaces the reserved meaning of `sensitive`. ADR 0033 item 7 reads "principals named by a grant" as principals with a grant on the region that holds the field, since grants exist only on regions. Not met: (3) the authority refuses every change by a user who cannot read the value, to its value, default, assignee or any other attribute, or a move to another container, and allows deleting it (`packages/authority/test/outcome.fields.test.ts`); the gateway refuses value changes earlier (SYN-052); showing the field as redacted is the editor's (FE-141); lane U-FRW-073-089 (round 3) drew it in the `form_field` spec, so (3) is met as far as the body view goes. Lane FRW-079-089, 2026-11-13: the authority half of (3) is now property-tested (`packages/authority/test/frw-088.unreadable-changes.test.ts`); the attributes stored as null or as an object are not in that property, because a generic value cannot satisfy their schema, and the example test in `outcome.fields.test.ts` covers `default` and `assignee`.

### FRW-089 Hide values derived from hidden content

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** ADR 0019; 12 §3, §5, §8 · **Requirements:** R13 · **Depends on:** FRW-088, FRW-017

As a maintainer, I want every value computed from hidden content to be hidden as well, so that mirrors, formulas and labels do not reveal what they read.

**Acceptance criteria**

- [ ] Given a mirror of a sensitive value, a formula or rule that reads one, or a computed label or `cached` text whose target is hidden, then a reader without access sees the redaction marker or a placeholder, and the server evaluates them.
- [ ] Given numbering that runs across a confidential region, then the choice between counting hidden items or not is recorded with what each choice leaks.
- [ ] Given the sealed final PDF and the evidence bundle, then the decision whether each participant receives a redacted copy is recorded.

**Evidence:** lane FRW-079-089 (2026-11-13), criterion 1, rules part only: `packages/authority/test/frw-089.derived-hidden.test.ts`, "redacts the derived field once the rule closure of the hidden field is hidden", with its two controls (a reader with only the sensitive field hidden sees the derived value; a reader with no hidden set sees both). The closure is `derivedFromHidden` (`packages/rules/src/hidden.ts`, tested in `packages/rules/test/hidden.test.ts`). Criterion 1 stays unticked: mirrors, computed labels, `cached` text and the server evaluation are not covered.

**Evidence (criterion 1, rules part wired, lane V-FRW-073-089, 2026-11-13):** the authority's hidden set now includes the closure: `packages/authority/src/permissions/visibility.ts` (`hiddenSetOf` collects the keys a connection may not read, also inside hidden regions, and `addDerivedValues` hides every field whose key `derivedFromHidden(...).derived` names, from the document's own rules compiled with `compileDocument`; if the rules do not compile, every value is hidden). `packages/rules/src/index.ts` now exports `derivedFromHidden`. Tested in Node by `packages/authority/test/frw-089.closure-wiring.test.ts` (5 tests: the derived field is redacted for a reader with no `manage`, shown to the owner, shown when no rule reads a hidden key, shown with no rules, and redacted for every value when the rules fail to compile). Also run and passing: `visibility.test.ts`, `frw-089.derived-hidden.test.ts`, `projection.differential.test.ts`, `projection.test.ts`, `projection.property.test.ts`, `projection.steps.test.ts`, `projection.withheld-reason.test.ts`, `outcome.fields.test.ts`, `frw-088.unreadable-changes.test.ts`. Mirrors, computed labels and `cached` text are not built, so criterion 1 stays open. The outcome check does not yet refuse a change to a derived value a reader cannot see; that is not in the criterion's wording and is not added.

**Notes:** Criteria 2 and 3 record decisions; the second is an owner question of ADR 0019. Until they are made, nothing derived from hidden content is shown. Rules developer, 2026-11-13: `packages/rules/src/hidden.ts` (`derivedFromHidden`, `fieldsRead`) computes the closure of hidden keys under the rule set (formulas and `set` effects that read a hidden value, and rules whose condition reads one, with the fields such a condition conditions) and reports the fields whose visibility a hidden condition decides. Tested by `packages/rules/test/hidden.test.ts` (closure, monotonicity, idempotence and rule-order independence, fast-check). Not met: (1) the package finds the derived values, but the redaction marker, the reader's view and the server evaluation are the authority's and the editor's, not built here. Criteria 2 and 3 are owner decisions and stay open; lane U-FRW-073-089, round 2, records the options for them in docs/adr/0343-lane-U-FRW-073-089.md (proposed, not decided). The taint defaults (implicit flow counted; visibility reported, not hidden) are in `docs/adr/0119-rules-backlog-batch.md`, item 6. Lane FRW-079-089, round 3 (2026-11-13): the authority test imports `derivedFromHidden` by a relative path, because `packages/rules/src/index.ts` does not re-export `hidden.ts`; the export is the rules owner's change, not made here. Criterion 1 stays open for mirrors, computed labels, `cached` text and the server evaluation, which the authority's projection does not yet apply to derived values.

## Coverage

| Spec section | Stories |
|---|---|
| 12 §1 Purpose | FRW-003, FRW-030, FRW-049 |
| 12 §1.1 Native and integrated | FRW-036, FRW-038, FRW-059 |
| 12 §2 Concepts | none: informative; terms are used in FRW-001, FRW-025 |
| 12 §3.1 `role_def` | FRW-001, FRW-074 |
| 12 §3.2 `form_field` | FRW-002, FRW-004, FRW-072, FRW-073, FRW-079, FRW-080 |
| 12 §3.3 Values | FRW-003, FRW-009, FRW-029 |
| 12 §3.4 Mirrors and long answers | FRW-006, FRW-012, FRW-086 |
| 12 §3.5 `rule_def` | FRW-015, FRW-021 |
| 12 §3.6 Invariants I13 to I15 | FRW-005, FRW-019 |
| 12 §4.1 Capability, role and scope | FRW-007, HIS-016 |
| 12 §4.2 Rules P7 to P9 | FRW-008, FRW-009, FRW-010, FRW-022, FRW-066 |
| 12 §4.3 Interaction with other permissions | FRW-011, FRW-012, FRW-029 |
| 12 §5.1 Model | FRW-015, FRW-037 |
| 12 §5.2 Semantics | FRW-014, FRW-016, FRW-017, FRW-018, FRW-019, FRW-020 |
| 12 §5.3 Where rules are enforced | FRW-022, FRW-023, FRW-047 |
| 12 §5.4 Where rules live | FRW-021 |
| 12 §6.1 Resource | FRW-025, FRW-026, FRW-031 |
| 12 §6.2 States | FRW-027, FRW-029, FRW-030, FRW-031, FRW-032, FRW-033, FRW-034, FRW-049, FRW-054 |
| 12 §6.3 Who sends messages | FRW-036 |
| 12 §7 Participants, authentication and evidence | FRW-038, FRW-039, FRW-040, FRW-041, FRW-042, FRW-043 |
| 12 §8.1 Ceremony | FRW-044, FRW-045, FRW-046, FRW-047, FRW-048 |
| 12 §8.2 Final PDF | FRW-049, FRW-050, EXP-079, FRW-052, FRW-053, FRW-054, FRW-055, FRW-056 |
| 12 §8.3 Legal stance | FRW-058, FRW-059, FRW-087 |
| 12 §9 Templates, prefill, bulk send | FRW-060, FRW-061, FRW-062, FRW-063, FRW-064 |
| 12 §10 Protocol additions: features | FRW-065 |
| 12 §10 Real-time plane | FRW-008, FRW-010, FRW-035 |
| 12 §10 Control plane | FRW-025, FRW-027, FRW-032, FRW-033, FRW-034, FRW-039, FRW-044, FRW-046, FRW-047, FRW-054, FRW-055, FRW-060, FRW-061, FRW-062, FRW-063 |
| 12 §10 Webhooks | FRW-036 |
| 12 §10 Embedding API | FRW-069, FRW-070, FRW-071 |
| 12 §10 Conformance | FRW-020, FRW-066, FRW-067, FRW-068 |
| 12 §11 Frontend: authors | FRW-024, FRW-028, FRW-072, FRW-073, FRW-074, FRW-075 |
| 12 §11 Frontend: participants | FRW-023, FRW-048, FRW-076, FRW-077, FRW-078, FRW-079 |
| 12 §11 Frontend: page view | none: owned by FE (field widgets on the overlay layer) and SPK (spike S9) |
| 12 §12 Export | EXP-033, EXP-095, FRW-057 |
| 12 §13 Phasing | phase 0: none: owned by SPK (S3 extension, S8); FRW-066 is the lasting test; FRW-083 confirms phase 1b; phases 1b to 4 are carried in the phase of each story |
| 12 §14 Pitfalls | see the pitfall table below |
| 12 §15 Open questions | FRW-083, FRW-084, FRW-085, FRW-086; the rest under Open questions |

### Pitfalls of 12 §14

| Pitfall | Stories |
|---|---|
| Marketing language that over-claims | FRW-058, FRW-087 |
| Signer identity is only as strong as the host's authentication | FRW-038, FRW-050, FRW-058 |
| Evidence retention against erasure rights | FRW-041, FRW-043, FRW-084 |
| Time | FRW-046, FRW-053, FRW-016 |
| PDF signature validity after later changes | FRW-054, FRW-056 |
| Long-term validation | FRW-056 |
| Signing that excludes people | FRW-045, FRW-048 |
| An author correcting while someone fills | FRW-032 |
| Filling moves page breaks | FRW-004, FRW-080 |
| Template changes after sending | FRW-062 |
| Prefill as an injection path | FRW-061, FRW-064 |
| Client and server disagree about a rule | FRW-015, FRW-020, FRW-022, FRW-023 |
| Rule loops | FRW-019 |

## Open questions

Items from 12 §15 and 11 §10 that shape these stories, and gaps found while writing them. None is decided here.

| # | Question | Stories affected |
|---|---|---|
| 1 | Does the host alone deliver invitations and authenticate participants, or must the hosted service also send messages and host a signing page? 12 and ADR 0013 assume the host. This is owner decision 10 of 11 §10 `SPK-010` | FRW-036, FRW-038, FRW-039 |
| 2 | Which jurisdictions come first, and who is the sealing party, the operator or each tenant? (owner decision 11) `SPK-011` | FRW-052, FRW-053, FRW-058, FRW-087 |
| 3 | Must some values be hidden from other participants? Decided on 2026-11-06: yes (SPK-005). `sensitive` marks such a value (ADR 0019, proposed; FRW-088, FRW-089). Still open: who reads a hidden value by default, and whether the sealed PDF and the evidence bundle are redacted per participant | FRW-002, FRW-035, FRW-055, FRW-088, FRW-089, EXP-095 |
| 4 | Should fields be fixed width or reflow? The default is fixed width (owner decision 12) `SPK-012`. Also open: the default width value and what shows when a value is longer than the box | FRW-002, FRW-080, EXP-033 |
| 5 | Are repeating line items with totals needed early (12 §15 question 5)? Repeating sections are out of scope in 12 §13; no story until decided | none |
| 6 | Are packets of several documents needed (12 §15 question 6)? Out of scope in 12 §13; templates pin one document | FRW-062, FRW-063 |
| 7 | What is the default evidence retention period (12 §15 question 7)? | FRW-043, FRW-084 |
| 8 | Is form mode without a workflow acceptable as the first slice (12 §15 question 3)? | FRW-083 and all phase 1b stories |
| 9 | Should comments be switched off while a workflow is active (12 §15 question 9)? | FRW-029, FRW-085 |
| 10 | How can a role write a long formatted answer if send locks the document (12 §3.4 against §6.2 and 07 §4)? | FRW-012, FRW-086 |
| 11 | What token claim carries fill roles outside a workflow, and what does `active` mean there? | FRW-007, FRW-008, FRW-083 |
| 12 | What is the code for an oversize `text` value or a limit violation in a fill commit, and does the authority reject limit violations (min, max, length) at commit time or only at completion? | FRW-003, FRW-004, FRW-047 |
| 13 | Does P9 apply to a commit by a user holding both `edit` and `fill`, and what does the server do with a client-supplied reserved origin (`sign`, `rules`, `prefill`)? | FRW-009, FRW-010 |
| 14 | What does "active workflow" mean for `workflow_active`, the lock and role principals: is `correcting` active, and do `completed`, `finalised` and `expired` keep the lock? Which other operations return `workflow_active`? | FRW-012, FRW-025, FRW-029 |
| 15 | Which participants must complete before `completed` (are `cc` and a declining approver counted)? Can a workflow be voided or expire from `correcting`, and decline from `sent`? | FRW-031, FRW-033, FRW-034 |
| 16 | After `resume`, which participants are reset when `defs` change, and what happens to a reset participant's earlier signature values and evidence? | FRW-021, FRW-032 |
| 17 | Reference point of `firstAfterDays`, whether the `remind` action raises `reminder_due`, and the trigger of `field_completed` | FRW-034, FRW-036 |
| 18 | The 12 §10 webhook names: `dep.workflow.sent` is prefixed and the others are not; 05 §7's event table has no workflow events | FRW-036 |
| 19 | The capability each 12 resource requires (fields, field values, prefill, sign, evidence, final PDF, templates, bulk sends) is not in the authorisation matrix of 07 §12 `PRM-056`; who may read the workflow resource and what a participant sees of the others is not stated | FRW-025, FRW-035, FRW-055, FRW-060, FRW-061 |
| 20 | The identifier form of `role_def` and `rule_def` (the examples use `role_tenant` and `r_spouse`, while 03 §9 describes 16-character node identifiers); how a pasted field gets a unique `key`; the icon of a role, which `role_def` does not carry; the use of a field's `default` attribute (initial value on insertion, or something else) | FRW-001, FRW-002, FRW-074 |
| 21 | Rule language details left to fixtures: null handling per operator, decimal precision, the regular-expression subset, bounds on a rule tree, the definitions of the presets `email`, `phone` and `postcode`, and the unit of `minLength` and `maxLength` | FRW-004, FRW-014 to FRW-020 |
| 22 | Where evaluation of routing rules happens, and who the person is for a participant added by routing | FRW-037 |
| 23 | Access code: how it is registered, how the participant receives it, and the lockout policy | FRW-039 |
| 24 | Consent text: where it is stored, authored and localised; whether the sign endpoint refuses without consent | FRW-044 |
| 25 | How a typed signature becomes an `asset` (font, renderer); what a visible signature appearance shows and whose it is | FRW-045, FRW-057 |
| 26 | Behaviour when the two compiles differ, when a compile fails, and when the time-stamping authority or signing service is down (the spec says only that the workflow cannot finalise) | FRW-049, EXP-079, FRW-052, FRW-053 |
| 27 | 12 §8.2 names the seal baseline B-LT or B-LTA, while 12 §13 puts long-term validation and re-time-stamping in phase 4 and the S8 exit criterion chooses the profile | FRW-053, FRW-056 |
| 28 | Whether prefill is allowed after send; who may call it; the code for refusing a server-set kind | FRW-061 |
| 29 | The `/templates` and `/bulk-sends` resource shapes, the row format and limits, and whether grants are copied | FRW-062, FRW-063 |
| 30 | 12 §9 mentions "exported spreadsheets"; no such export is specified | FRW-064 |
| 31 | 12 §13 says "DOCX round trip of fields"; 12 §12 specifies only export. The import side belongs to EXP | EXP-095 |
| 32 | What happens to the value when a field's `kind` changes or a `choice` option in use is removed | FRW-073 |
| 33 | Payloads of `de-fill-progress` and `de-sign-request`; whether `de-field-change` fires for remote changes; when `de-workflow-complete` fires | FRW-070, FRW-071 |
| 34 | `SignatureProvider` is not in the port list of 05 §8.3 | FRW-059 |
| 35 | Review items still open: the page view and spike S9 for field widgets (review §6 item 2); legal review (item 4); unmeasured compile cost with tagging (item 5); a second review pass over draft 0.2 (item 7) | FRW-049, EXP-079, FRW-087 |
