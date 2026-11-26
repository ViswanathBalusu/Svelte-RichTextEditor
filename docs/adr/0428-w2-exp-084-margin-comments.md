# ADR 0428: Margin comments in the PDF (lane w2, EXP-084)

Status: proposed. Owner decision 52 settles who is shown (open threads, with display names; resolved threads left out). The rest below is the lane's reading of 09 section 10, and the owner has not confirmed it.

## Context

09 section 10 and the `comments` option (`none`, `margin`) ask for the threads of a review in the PDF margin. Threads are not in the document (03 section 4; 07 section 6): they live in the document service with ranges that are mapped through commits (SYN-032). The converter reads the document only. ADR 0228 gave the DOCX writer a thread input (`{ id, block, messages, done? }`); the PDF needs the same input and a place on the page.

## Decision proposed

1. **Input.** `ConvertOptions.comments` (`none` default, `margin`) and `ConvertOptions.commentThreads`: `{ id, block, quote?, done?, detached?, messages: [{ author, text }] }` (`CommentThread` in `packages/export-latex/src/bundle.ts`). It extends the shape of ADR 0228 with `quote` and `detached`. The converter never reads a user identity; `author` is a display name.
2. **Who writes it.** The control plane (`export-comments.ts`), at request time, next to `suggestionAccess`. It reads the open threads of the document, maps each range from the seq it was made at to the exported `seq` through the commits between them (`mapRangesThrough`, the mapping of `GET /threads?seq=`), finds the identified block the range starts in, and reads the words it covers (at most 200 characters). A thread made after the exported `seq` is left out. A thread in a region the requester may not see is left out (ADR 0019). A range with no text left, or a block that is not in the document, is `detached`. At most 500 threads are carried.
3. **Display names.** The surrogate of each comment's author is turned into the host `sub` (`subsOf`) and then into the stored display name. A person who is erased, or who has no name, is "Unknown person" (owner decision 39). No surrogate and no `sub` goes into the job. A mention prints as "@mention"; its principal is not printed (it can be an e-mail address).
4. **Placement.** A note is set in the right margin beside the first line of the paragraph the range starts in (`\DEmargin` in the house class, class 0.2.18): 6.5 pt type, as wide as the margin allows (at least 10 mm, so a page with a margin narrower than that overflows it). A range is shown by its quoted words at the head of the note, not by a mark in the text: the converter has no character offsets inside a paragraph (ADR 0228 decision 4), and a mark would change the line breaks. The page does not change size, so the pagination of a PDF with margin comments is that of the same PDF without them; `\marginpar` can push notes down when they are many.
5. **What has no margin.** A table cell, a header or footer and a hidden paragraph cannot take `\marginpar`, which would lose the note. A heading's note follows the heading (its own argument is moved into the table of contents). A detached thread, and a thread whose paragraph is not in a margin place, are listed at the end of the document under "Comments not shown in the margin", each with a warning (`comment_detached`, `comment_not_in_margin`), never anchored to a place they do not belong to. The heading's English text is fixed; it is not yet translated with the document language.
6. **Limits.** 50 messages per thread, 4000 characters per message, 200 characters per quote, 80 per author name; a cut is reported as `comments_truncated`. All text goes through the `text` emitter, and each string is checked against the fonts (`glyph_missing`).
7. **Tagging.** `\marginpar` in a tagged document becomes one `Aside` structure element inside the paragraph, after the paragraph's own text. The marked content of the page reads in the order of the body (the test reads the structure tree), and the file passes PDF/UA-2 (veraPDF).
8. **Targets.** `comments: margin` is for `pdf` and `tex`. An `html` or `md` job refuses it as `option_unsupported`; those files have no margin. (Showing threads there is for another story.)
9. **Request key.** The threads are part of the export request key, because a comment can be added without a commit.

## Not decided

- Dates of messages in the note (left out: they need a time zone and make the note longer).
- Threads on a whole block in a table cell: listed at the end, as above.
- Resolved threads as a separate option: owner decision 52 leaves them out.
- A margin wider than the page setup's: a narrow page margin gives a narrow note.

## Consequences

- The house class has a new release, 0.2.18 (`class/releases.json`).
- Tests: `packages/export-latex/src/exp-084-comments.test.ts`, `packages/export-latex/src/exp-084-comments.compile.test.ts` (Podman), `services/export-worker/src/exp-084-comments.job.test.ts`, `services/document-service/test/control-plane/exp-084-margin-comments.test.ts`.
