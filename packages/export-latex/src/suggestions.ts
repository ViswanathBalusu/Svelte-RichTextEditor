/**
 * Suggestions in output (09 §10). The job's `suggestions` option prints the document as if every
 * suggestion were accepted (`accept`) or none (`reject`), or keeps every suggestion visible as
 * markup (`markup`, EXP-083): insertions are blue and underlined, deletions red and struck through,
 * so the two differ by a cue that is not colour. Markup covers text runs and the runs of a paragraph
 * with a suggestion (EXP-083 criterion 3, paragraphs only); a table, a row or an atom with a
 * suggestion is printed as it is. A document with suggestions
 * and no option is refused by the service with `pending_suggestions` (EXP-082); the converter
 * reports the same code as an error and prints the text as if all suggestions were rejected, so
 * that no unreviewed text reaches a PDF.
 * A `fmt` suggestion shows the formatting it suggests in both cases (ADR 0032 §1, marks); the
 * `reject` revert to the recorded `before` values of EXP-081 criterion 2 is not built.
 */
import { color, lit, tex, type Tex } from './emit.ts';
import { diag, type Ctx, type Mark } from './context.ts';

/** Insertions in markup: blue, underlined. The colours are a proposed default (ADR 0142), not a decision. */
const INSERT_COLOUR: Tex = color('#1F5FAD') ?? lit('1F5FAD');
/** Deletions in markup: red, struck through. */
const DELETE_COLOUR: Tex = color('#B3261E') ?? lit('B3261E');

export function hasSuggestion(marks: readonly Mark[] | undefined): boolean {
  return (marks ?? []).some((m) => m.type === 'ins' || m.type === 'del');
}

/** Whether content with these marks (text, an atom or a block's node marks) is left out. */
export function suggestionHides(ctx: Ctx, marks: readonly Mark[] | undefined): boolean {
  if (!marks || marks.length === 0) return false;
  const ins = marks.some((m) => m.type === 'ins');
  const del = marks.some((m) => m.type === 'del');
  if (!ins && !del) return false;
  let mode = ctx.o.suggestions;
  if (mode === null) {
    if (!ctx.warned.has('pending_suggestions')) {
      ctx.warned.add('pending_suggestions');
      diag(
        ctx,
        'error',
        'pending_suggestions',
        null,
        'the document has unresolved suggestions and the job sets no `suggestions` option (09 §10)',
      );
    }
    mode = 'reject';
  }
  if (mode === 'markup') {
    // Kept and marked. The pagination note of EXP-083 criterion 5 goes once per job.
    if (!ctx.warned.has('markup_pagination')) {
      ctx.warned.add('markup_pagination');
      diag(
        ctx,
        'info',
        'markup_pagination',
        null,
        'suggestions are shown as markup: the pagination of this PDF differs from that of the accepted or rejected text (09 §10)',
      );
    }
    return false;
  }
  return mode === 'accept' ? del : ins;
}

/**
 * Wraps a text run that carries a suggestion in markup mode (EXP-083 criteria 1 and 4): an
 * insertion is underlined in the insertion colour, a deletion is struck through in the deletion
 * colour. Any other mode returns the run unchanged. The colours go through the `color` emitter.
 */
export function markupRun(ctx: Ctx, marks: readonly Mark[] | undefined, body: Tex): Tex {
  if (ctx.o.suggestions !== 'markup' || !hasSuggestion(marks)) return body;
  let out = body;
  if (marks?.some((m) => m.type === 'ins')) out = tex`\DEc{${INSERT_COLOUR}}{\DEul{${out}}}`;
  if (marks?.some((m) => m.type === 'del')) out = tex`\DEc{${DELETE_COLOUR}}{\DEst{${out}}}`;
  return out;
}
