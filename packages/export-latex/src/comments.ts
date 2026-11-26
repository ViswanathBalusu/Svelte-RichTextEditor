/**
 * Comments in the margin (EXP-084; 09 section 10; owner decision 52; docs/adr/0428). With
 * `comments: margin` the open threads of the job's `commentThreads` print beside the paragraph
 * they start in, in the class's `\DEmargin`. Resolved threads are left out. A thread that cannot
 * stand beside its paragraph is listed at the end of the document with a warning, never anchored
 * to a place it does not belong to.
 *
 * Every string goes through the text emitter. The counts are bounded, so that one thread cannot
 * grow the PDF without limit.
 */
import { EMPTY, join, lit, text, tex, type Tex } from './emit.ts';
import { diag, type Ctx, type J } from './context.ts';
import { familyOf } from './props.ts';
import { checkGlyphs } from './fonts/check.ts';
import type { CommentThread } from './bundle.ts';

/** Most threads, messages per thread, and characters per message and quote that print. */
export const COMMENT_LIMITS = { threads: 500, messages: 50, chars: 4000, quote: 200 } as const;

/** Whitespace folded to one space, trimmed, shortened with an ellipsis. */
function oneLine(value: string, max: number): string {
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Sorts the open threads by paragraph; reports what the limits cut. */
export function planComments(ctx: Ctx): void {
  if (ctx.o.comments !== 'margin') return;
  const all = ctx.options.commentThreads ?? [];
  let kept = 0;
  for (const t of all) {
    if (t.done === true) continue;
    if (kept >= COMMENT_LIMITS.threads) {
      diag(
        ctx,
        'warning',
        'comments_truncated',
        null,
        `only the first ${COMMENT_LIMITS.threads} open comment threads are printed`,
      );
      break;
    }
    kept++;
    const list = ctx.comments.byBlock.get(t.block);
    if (list) list.push(t);
    else ctx.comments.byBlock.set(t.block, [t]);
  }
}

/** The notes of one thread: the quoted words, then each message, as `\DEnote`s. */
function notesOf(ctx: Ctx, t: CommentThread, blockId: string | null): Tex {
  const fam = familyOf(ctx, null, blockId);
  const parts: Tex[] = [];
  const quote = t.quote ? oneLine(t.quote, COMMENT_LIMITS.quote) : '';
  if (quote !== '') {
    checkGlyphs(ctx, quote, fam, false, true, blockId);
    parts.push(tex`\DEquote{${text(quote)}}`);
  }
  const messages = t.messages.slice(0, COMMENT_LIMITS.messages);
  if (messages.length < t.messages.length)
    diag(
      ctx,
      'warning',
      'comments_truncated',
      blockId,
      `a thread prints its first ${COMMENT_LIMITS.messages} messages only`,
    );
  for (const m of messages) {
    const author = oneLine(m.author, 80);
    const body = oneLine(m.text, COMMENT_LIMITS.chars);
    checkGlyphs(ctx, author + body, fam, false, false, blockId);
    parts.push(tex`\DEnote{${text(author)}}{${text(body)}}`);
  }
  return join(parts);
}

/**
 * The margin note of the threads that start in paragraph `id`, or nothing. A detached thread is not
 * placed (it is listed at the end). Called by the paragraph writer; marks the threads as placed.
 */
export function marginNote(ctx: Ctx, id: string | null): Tex {
  if (ctx.o.comments !== 'margin' || id === null) return EMPTY;
  const threads = (ctx.comments.byBlock.get(id) ?? []).filter(
    (t) => t.detached !== true && t.messages.length > 0 && !ctx.comments.placed.has(t.id),
  );
  if (threads.length === 0) return EMPTY;
  for (const t of threads) ctx.comments.placed.add(t.id);
  return tex`\DEmargin{${join(threads.map((t) => notesOf(ctx, t, id)))}}`;
}

/**
 * The list at the end for the threads that were not placed beside a paragraph, with a warning each.
 * Returns the lines to write (none when every thread stands in the margin).
 */
export function unplacedComments(ctx: Ctx, exists: ReadonlySet<string>): Tex[] {
  if (ctx.o.comments !== 'margin') return [];
  const rest: CommentThread[] = [];
  for (const list of ctx.comments.byBlock.values())
    for (const t of list) if (!ctx.comments.placed.has(t.id) && t.messages.length > 0) rest.push(t);
  if (rest.length === 0) return [];
  const items: Tex[] = [];
  for (const t of rest) {
    const known = exists.has(t.block);
    diag(
      ctx,
      'warning',
      t.detached === true ? 'comment_detached' : 'comment_not_in_margin',
      known ? t.block : null,
      t.detached === true
        ? 'the range of a comment thread has no text left at this version, so it is listed at the end'
        : 'a comment thread stands in a place that has no margin (a table cell, a heading, a header or a hidden paragraph), so it is listed at the end',
    );
    items.push(tex`\DEunplaced{${notesOf(ctx, t, known ? t.block : null)}}`);
  }
  return [lit('\\DEunplacedhead'), ...items];
}

/** The identifiers of the nodes of a document, for `unplacedComments`. */
export function blockIds(doc: J): Set<string> {
  const out = new Set<string>();
  const walk = (n: J): void => {
    const id = n.attrs?.['id'];
    if (typeof id === 'string') out.add(id);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}
