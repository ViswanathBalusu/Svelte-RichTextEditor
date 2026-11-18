# ADR 0413: Forced line breaks (parity level L2) are built, as an experimental mode

**Status:** accepted by the owner's decision 147 (`docs/owner-decisions-2026-11-15.md`, 2026-11-15: "Build them. This reverses the proposed default (not built)."). The scope below is proposed by lane w2 (2026-11-18, EXP-059) and is for the owner to review.

## Context

- 09 §7 lists three parity levels. L2 makes the PDF's lines match the editor's even for text edited since the last compile. The class forces the editor's first-fit breaks. The cost is TeX's paragraph quality.
- 09 §15 kept the question open. ADR 0320 round 8 set out three options (do not build, defer, build) and used "do not build" as a working default.
- Decision 147 chose "build". The owner gave no reasons beyond the decision. The reasons 09 §7 gives for the mode are the ones recorded here: the editor and the PDF agree on lines for text that the last compile has not seen. The evidence gap stands (S4 has no reference-machine measurement, see EXP-060). The decision does not wait for it.

## Decision

1. **Decision: build.** L2 is built. L0 and L1 stay as they are. L2 is a separate, opt-in mode, off by default.
2. **Constraints (09 §7, unchanged).**
   - The editor and the class use the same fonts.
   - No hyphenation in L2 documents.
   - Fixed leading (baseline-to-baseline distance), so that line height does not depend on content.
   - The editor's first-fit breaks are forced in the class with penalties placed before TeX's own line breaker runs (a forced break is a `\penalty-10000` at the position the editor chose, and a `\penalty10000` where it chose to keep a line together).
   - TeX's line breaker is not replaced. Inserts, marks and vertical material keep migrating as TeX decides, which is the reason 09 §7 gives for not replacing it.
3. **Scope.** The mode covers paragraphs of running text. Display math, tables, floats and preserved blocks keep TeX's own breaks, because the editor has no first-fit result for them that TeX could use. A paragraph that the editor cannot break (a word wider than the line) keeps TeX's break.
4. **Where the breaks come from.** The editor's line breaker (`@docedit/layout`) gives the break positions. The converter writes them as penalties through the typed emitters (09 §4). The export option is named in the export request, and the class option is `parity=forced`. Both names are working placeholders.
5. **Announcement.** Wherever the mode is offered or described (the export dialogue, the option's help text, the release notes and the documentation) it carries this text, in this order:
   - "Experimental."
   - "Forced line breaks make lines match the editor, but give up TeX's paragraph quality: line breaks are less even, and spacing can be looser or tighter than TeX would set it."
   The result of a job that used the mode records `parity: "forced"` in its manifest, so a reader of the PDF's provenance can tell.
6. **Stories.** The decision story (EXP-059) ends with this record. The build needs its own stories: the editor's break export, the converter's penalties, the class option, a corpus test that compares the editor's lines with `layout.json`, and the dialogue wording. They are not written here (EXP-059 says an implementation story follows a "build" decision, and numbering them is the integrator's). They depend on EXP-057 and SPK-017.

## Consequences

- 09 §7 and §15 are updated: L2 is "to be built", and the open issue is closed.
- Documents set in L2 will differ from L0 and L1 documents in line breaks, by design.
- A measurement of how well the editor's lines match TeX's on forced paragraphs is still needed before the mode can be called usable. It is a criterion of the build stories, not of this decision.
