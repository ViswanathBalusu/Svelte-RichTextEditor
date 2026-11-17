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
 * A `fmt` suggestion shows the formatting it suggests under `accept`; under `reject` it is settled by
 * `settleSuggestions` before any writer reads the document (EXP-081; docs/adr/0370-w2-exp-081-unverifiable-suggestion-marks.md).
 */
import { color, lit, tex, type Tex } from './emit.ts';
import { diag, type Ctx, type J, type Mark } from './context.ts';
import type { Diagnostic, Suggestions } from './bundle.ts';

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

/** The formatting marks that a rejected `fmt` leaves alone: a link and the preserved properties. */
const KEPT_ON_REVERT: ReadonlySet<string> = new Set(['ins', 'del', 'fmt', 'link', 'preserved']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether an `ins` or `del` mark can be checked: it names its suggestion and its author (03 §5).
 * A mark that does not is "not verifiable" (ADR 0370, proposed): the exporter never drops a region
 * because of it.
 */
function verifiable(m: Mark): boolean {
  const id = m.attrs?.['id'];
  const user = m.attrs?.['user'];
  return typeof id === 'string' && id !== '' && typeof user === 'string' && user !== '';
}

/** The identifier of the block that holds a node, for a diagnostic: the nearest one that has one. */
function holderOf(parents: readonly (string | null)[]): string | null {
  for (let i = parents.length - 1; i >= 0; i--) if (parents[i]) return parents[i]!;
  return null;
}

/**
 * Settles what a mode can settle before any writer reads the document (EXP-081). The result is a
 * copy; the argument is never changed, so an export leaves the document as it was.
 * - An `ins` or `del` mark that cannot be verified is dropped from the copy, so its text, row or
 *   block is printed as plain content, and a warning `suggestion_unverified` names the block.
 * - Under `reject` (and with no option, which is read as `reject`), a `fmt` mark that records a
 *   `before` gives that value back: the text gets the recorded marks in place of its formatting
 *   marks, and a paragraph, row or table gets the recorded `style`, `align` and `numbering`.
 *   The editor does the same when it rejects the suggestion (`resolveSuggestions`, FE-047).
 *   Under `accept` and `markup` the `fmt` stays as it is: the current formatting is shown.
 */
export function settleSuggestions(doc: J, mode: Suggestions | null, diagnostics: Diagnostic[]): J {
  const revert = mode === null || mode === 'reject';
  const reported = new Set<string>();
  const visit = (node: J, parents: (string | null)[]): J => {
    let marks = node.marks;
    let attrs = node.attrs;
    if (marks && marks.length > 0) {
      const unverified = marks.filter(
        (m) => (m.type === 'ins' || m.type === 'del') && !verifiable(m),
      );
      if (unverified.length > 0) {
        marks = marks.filter((m) => !unverified.includes(m));
        const block = holderOf([
          ...parents,
          typeof node.attrs?.['id'] === 'string' ? (node.attrs['id'] as string) : null,
        ]);
        const key = `${block ?? ''}\u0000${node.type}`;
        if (!reported.has(key)) {
          reported.add(key);
          diagnostics.push({
            severity: 'warning',
            code: 'suggestion_unverified',
            blockId: block,
            message:
              'a suggestion mark names no suggestion or no author, so it cannot be verified; its content is kept as it is (09 §10)',
          });
        }
      }
      if (revert) {
        const fmts = marks.filter((m) => m.type === 'fmt' && isRecord(m.attrs?.['before']));
        const last = fmts[fmts.length - 1];
        const before = last ? (last.attrs?.['before'] as Record<string, unknown>) : null;
        if (before) {
          const prevMarks = before['marks'];
          if (Array.isArray(prevMarks) && (node.text !== undefined || node.content === undefined))
            marks = [
              ...marks.filter((m) => KEPT_ON_REVERT.has(m.type)),
              ...(prevMarks.filter((m) => isRecord(m) && typeof m['type'] === 'string') as Mark[]),
            ];
          const prevAttrs = before['attrs'];
          if (isRecord(prevAttrs)) attrs = { ...(node.attrs ?? {}), ...prevAttrs };
          marks = marks.filter((m) => m.type !== 'fmt' || !isRecord(m.attrs?.['before']));
        }
      }
    }
    const id = typeof attrs?.['id'] === 'string' ? (attrs['id'] as string) : null;
    const content = node.content?.map((c) => visit(c, [...parents, id]));
    const changed =
      marks !== node.marks ||
      attrs !== node.attrs ||
      (content !== undefined && content.some((c, i) => c !== node.content![i]));
    if (!changed) return node;
    const out: J = { ...node };
    if (marks !== node.marks) {
      if (marks && marks.length > 0) out.marks = marks;
      else delete out.marks;
    }
    if (attrs !== node.attrs && attrs) out.attrs = attrs;
    if (content) out.content = content;
    return out;
  };
  return visit(doc, []);
}
