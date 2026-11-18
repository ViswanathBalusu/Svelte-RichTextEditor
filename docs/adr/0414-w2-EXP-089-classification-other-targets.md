# ADR 0414: How the other export targets carry the classification label

**Status:** proposed, 2026-11-18 (lane w2; EXP-089 criteria 3 and 4). The owner has not reviewed it. Decision 51 (header and footer of every page) covers the PDF. This record applies it to the other targets, because 13 §10 and 09 §11 do not say how they carry the label.

## Context

- EXP-089 criterion 4 asks that the other targets carry the label "in the way their documentation states". No documentation stated it.
- Decision 51 puts the marking in the header and the footer of every page. HTML, Markdown and the canonical JSON have no pages.
- A label change is a change to the document record, not to its content. The export request key (EXP-006) was built from the content position (`seq`), so the same content with a new label would have been answered from the first result, with the old label printed on it.

## Decision

1. **PDF (unchanged).** Header and footer of every page, through the `text` emitter.
2. **DOCX.** The label is a centred paragraph at the end of every header and footer story that the sections use (default, first page, even pages). Where a section has no header or no footer, the writer adds a default one. A story shared by sections is marked once. The option is `classification` in the writer's options.
3. **HTML.** A `header` element with class `de-classification` before `main`, a `footer` element with the same class after it, and `<meta name="classification">`. The text is escaped.
4. **Markdown.** The label in bold as the first and as the last paragraph. The text is escaped.
5. **Canonical JSON (`cdm`).** The file does not carry the label. It is the canonical document, and its bytes are fixed by the content (09 §11). The label stays on the document record. A reader who needs it takes it from the record (`classification` on the document resource, PRO-048).
6. **No label, no marking** in any target. A blank label counts as none.
7. **The request key includes the label.** `exportRequestKey` takes an optional `classification` and adds it to the key only when it is not empty, so the keys of unlabelled documents do not change. A label change gives a different key, a new job and a new result. The workflow's final export (`final-export-start.ts`) has no document record at hand and does not pass the label, so its key is the key of an unlabelled request. A request for the same content after the label was cleared could therefore be answered from a workflow job that printed a label. This gap is known and not closed here.

## Consequences

- The DOCX writer is not yet a target of the export worker (`job.ts` accepts `pdf`, `cdm`, `html` and `md`), so decision 2 is tested at the writer, not through a job.
- If the owner wants the label in the canonical JSON, it needs a place in the envelope or a field in the job result, which is a change to the published schema.
- Decisions 2 to 5 are working choices. The tests name them, so a change shows.
