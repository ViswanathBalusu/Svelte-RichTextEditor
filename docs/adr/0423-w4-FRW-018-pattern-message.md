# 0423. The message of a field's pattern

**Status:** proposed, 2026-11-20. Written while finishing FRW-018 criterion 4 (lane w4). The owner decided on 2026-11-15 (decision 187 of docs/owner-decisions-2026-11-15.md) that the field definition carries an optional message for `validation.pattern` and that the model gains the member (ADR 0030, open item 3). The points below are how that is built. Each takes the smallest reading that works, and the owner may change any of them.

## Context

FRW-018 criterion 4 asks that a value that does not match `validation.pattern` is reported invalid in the editor and at completion "with the message the author gave". Until now the CDM's `validation` object had no place for a message, so the editor showed the rules package's own wording ("the entry does not have the expected form") and the completion refusal named the field and the code only.

## Decisions (proposed)

1. **The member.** `form_field.validation.message` is a string of 1 to 255 code points with no control character other than tab and line feed: the CDM's grammar of labels, with the same bounds as the message of a `validate` effect (ADR 0030 §9). It is optional. `spec/cdm/cdm-1.schema.json` declares it (invariant I11), so a commit that sets a message outside the grammar is refused like any attribute.
2. **It is the pattern's message, and nothing else's.** `checkEntry` of `packages/rules` reports an entry that does not match `pattern` with the author's message. The other checks of the same field (`minLength`, `maxLength`, `preset`, the type) keep the package's wording. A preset has its own wording because its meaning is fixed ("enter a valid e-mail address"). The alternative, one message for every check of the field, would make the message say the wrong thing for a length limit.
3. **A message nothing would show is named, not refused.** `checkFieldDefinition` reports `not_applicable` at `/validation/message` when the field has a message and no pattern, or is not a text field. As for the other limits that do not apply to a kind, no commit is refused for it; only a pattern outside the subset is refused on commit (FRW-018 criterion 1).
4. **The report says whose words it carries.** An entry problem has `authored: true` when its message is the author's. A caller may then show the text as it is; any other message of a static check is the package's English wording, which a caller may replace by the code.
5. **In the editor.** The control of the field is `aria-invalid`, and the message beside it (`role="alert"`), which the control's description ends with, is the author's. `validateFields()` of the embedding API returns it. Nothing was changed in the view: it shows the messages of the entry's problems, as before.
6. **At completion.** `completionCheck` of the authority carries `authored` on the problem. The answer of `POST /documents/{id}/workflow/participants/{pid}/complete` is still `validation_failed` with one violation for each field and check; the violation of a pattern whose field has a message gains the member `message` with the author's text. `ProblemDetails.violations[].message` is declared in the protocol definition (`packages/protocol/src/definition/common.ts`) as optional. This is a small addition to decision D71 ("where the body breaks which rule; never the offending value"): the message is a text of the document's definitions, not a value, and it is sent only for the fields of the participant who completes.
7. **The author gives it where the field is defined.** In the field properties pane the author types it in the validation object (`{"pattern": "...", "message": "..."}`); `editField` of the editing core checks it against the grammar before the commit. A hosted integration sets it in the content it creates.

## Not decided here

- Whether the message of a `validate` effect should also be sent with the completion refusal. Today the violation names the rule (`rule (<id>)`) and carries no text; the editor has the rule's message from its own evaluation. Left as it was.
- A separate control for the message in the field properties pane. The pane edits `validation` as one JSON object; the message is one more member of it.
- Translated messages. The message is one string in the document's language, as a label is; ADR 0030 lists localised `validate` messages as open (item 5), and the same holds here.
- A field in a region the participant cannot read: the completion refusal already names the key of such a field when it is assigned to the participant's role, and would now carry its message. Fill mode does not arise for a field the participant cannot see, so this is left with the read rules (ADR 0019).

## Consequences

- One more optional member in CDM 1 (draft) and one in the DEP problem document; both artifacts are regenerated, and the definition hashes of `spec/cdm/cdm-1.manifest.json` and `spec/dep/dep-1.manifest.json` change.
- A reader of an older build that validates strictly would refuse a document whose field has a message. CDM 1 is still a draft, so no document of a released version exists.
