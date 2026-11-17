# ADR 0370: Settling suggestions in an export (lane w2, EXP-081)

Status: proposed. The owner has not decided these points. EXP-081 criteria 1, 2, 4 and 6 are ticked on the defaults below; criterion 3 is not.

## Context

09 §10 says an export with `accept` or `reject` reads as if every suggestion were accepted or none were, that a whole-block deletion is honoured only if it "passes the permission rules", and that the exporter "never drops a region because of a mark it cannot verify". Three points were open:

1. EXP-081 criterion 2 (`reject` gives `fmt` back its `before`) seemed to conflict with ADR 0032 §1, which says the style cascade ignores `fmt` and "text with a `fmt` suggestion shows the formatting it suggests".
2. "A mark the exporter cannot verify" is not defined.
3. "Passes the permission rules" does not say which rule, or where the exporter gets the data.

## Decision proposed

1. **`fmt` under `reject`.** ADR 0032 §1 is about the cascade (`resolveRun`, `resolveParagraph`), which reads the current marks and attributes and ignores suggestion marks. It does not say what an export that rejects suggestions prints, so there is no conflict. The converter and the Markdown and HTML writers settle the document before they read it (`settleSuggestions` in `packages/export-latex/src/suggestions.ts`). Under `reject`, and with no option (read as `reject`), a `fmt` mark that records a `before` is replaced by it, as the editor does when it rejects the suggestion (`resolveSuggestions`, FE-047):
   - text and inline atoms: the formatting marks are replaced by `before.marks`; `link` and `preserved` are kept (the editor drops a link too; a link is not formatting and an export should not lose it);
   - a paragraph, a row or a table: the attributes in `before.attrs` (`style`, `align`, `numbering`) are put back.
   A `fmt` with no `before` is left as it is. Under `accept` and `markup` nothing changes: the current formatting is printed.
2. **Cannot verify.** An `ins` or `del` mark that has no string `id` or no string `user` (03 §5: a suggestion names itself and its author). Such a mark is treated as absent: its text, paragraph, row or table is printed under every mode and is never dropped, and the job reports the warning `suggestion_unverified` with the identifier of the nearest block that has one. This is the narrowest definition that can be checked from the document alone. Whether the exporter should also check the author against the commit log (a suggestion identifier belongs to the user who first used it, I2) is not decided; the converter cannot do it without a payload from the service.
3. **Permission rules (not built).** The candidate rule is P4 (`packages/authority/src/permissions/suggestions.ts`), which needs the identity that owns each suggestion identifier and the grants of the requester. Neither is in the export payload. The shape of that payload is not decided here (see ADR 0228 for the comments input). Until then a whole-block `del` is honoured under `accept` without a permission check, and EXP-081 criterion 3 stays unticked.

## Consequences

- A document with a rejected `fmt` prints its recorded formatting in the PDF, HTML and Markdown. The bundle hash of a document with `fmt` suggestions under `reject` changes accordingly.
- `markup` mode does not show `fmt` suggestions as markup (EXP-083 Open questions).
- Tests: `packages/export-latex/src/exp-081-settle.test.ts`, `packages/element/test/exp-081-editor-equivalence.test.ts`.
