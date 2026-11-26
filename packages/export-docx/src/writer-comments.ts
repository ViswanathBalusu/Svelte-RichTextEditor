/**
 * Comment threads written as Word comments (09 §10; EXP-093 criterion 4). A thread is anchored to
 * a paragraph by its identifier: the paragraph gets a `commentRangeStart` and a `commentRangeEnd`
 * with a `commentReference` for each message of the thread, the messages go to `comments.xml`, and
 * each reply is linked to its root in `commentsExtended.xml`. Threads anchored to a text range are
 * not written here: the export input carries no offsets within a paragraph (see the story's Notes).
 *
 * The writer uses only what the caller passes. Comment threads live outside the document (03 §4;
 * 07 §6), so the caller maps them to the exported `seq` and gives each author label and date.
 */
import type { JsonNode } from '@docedit/model';
import { NS } from './ooxml.ts';
import { ROOT_DECLARATIONS, XML_DECLARATION, el, textElement } from './writer-xml.ts';

/** One message of a thread: the author's label or name, the server time it was made, and its text. */
export interface CommentMessage {
  author: string;
  /** RFC 3339 server time of the message; left out of the file when absent. */
  date?: string;
  text: string;
}

/** A comment thread. The first message is the root; the others are replies, in order. */
export interface CommentThread {
  /** The thread's identifier (05 §6.2). */
  id: string;
  /** The identifier of the paragraph the thread is anchored to. */
  block: string;
  messages: readonly CommentMessage[];
  /** Whether the thread is resolved (Word's `done`). */
  done?: boolean;
  /**
   * The text the thread is on, as positions in the paragraph's inline content (UTF-16 units of the
   * text, one for each atom such as a tab, a break or a field), from the start to the end, mapped by the
   * caller to the exported seq (owner decision 102: the exact range). Absent: the whole paragraph.
   * An end past the end of the paragraph is cut to it: a range that runs on into the next
   * paragraph is anchored to the end of the paragraph where it starts.
   */
  from?: number;
  to?: number;
}

/** Content types and relationship types of the comment parts (ECMA-376 Part 1; MS-DOCX). */
export const COMMENT_PARTS = {
  comments: {
    name: 'word/comments.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
    rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
    target: 'comments.xml',
  },
  extended: {
    name: 'word/commentsExtended.xml',
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
    rel: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
    target: 'commentsExtended.xml',
  },
} as const;

const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';

/** One message as planned: its `w:id`, its paragraph identifier, and its root's identifier. */
export interface PlannedComment {
  id: number;
  paraId: string;
  /** The root's paragraph identifier for a reply; null for a root. */
  parentParaId: string | null;
  message: CommentMessage;
}

export interface CommentPlan {
  /** The threads, in the order given; a thread that names no message is left out. */
  threads: ReadonlyArray<{ thread: CommentThread; comments: readonly PlannedComment[] }>;
  /** Indexes into `threads` by the identifier of the paragraph they anchor to. */
  byBlock: ReadonlyMap<string, readonly number[]>;
  /** Threads with no message, which are never written. */
  empty: readonly CommentThread[];
}

/**
 * Plans the ids of the comments. Identifiers are assigned in order from 0, and each paragraph
 * identifier (`w14:paraId`, eight hexadecimal digits below 0x80000000) is derived from the same
 * counter, so that the parts of one export agree and no two comments share one.
 */
export function planComments(threads: readonly CommentThread[]): CommentPlan {
  let next = 0;
  const planned: CommentPlan['threads'][number][] = [];
  const empty: CommentThread[] = [];
  const byBlock = new Map<string, number[]>();
  for (const thread of threads) {
    if (thread.messages.length === 0) {
      empty.push(thread);
      continue;
    }
    let rootPara: string | null = null;
    const comments: PlannedComment[] = thread.messages.map((message) => {
      const id = next++;
      const paraId = paraIdFor(id);
      const parentParaId = rootPara;
      if (rootPara === null) rootPara = paraId;
      return { id, paraId, parentParaId, message };
    });
    const index = planned.length;
    planned.push({ thread, comments });
    const list = byBlock.get(thread.block) ?? [];
    list.push(index);
    byBlock.set(thread.block, list);
  }
  return { threads: planned, byBlock, empty };
}

/** A paragraph identifier for the comment with this identifier: unique, and below 0x80000000. */
export function paraIdFor(id: number): string {
  return (0x10000000 + id).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * The markers that anchor the thread at index `index` around a paragraph's content: a range start
 * for each message, then the range ends with their references.
 */
export function anchorStarts(plan: CommentPlan, index: number): string {
  return plan.threads[index]!.comments.map((c) => el('w:commentRangeStart', { 'w:id': c.id })).join(
    '',
  );
}

export function anchorEnds(plan: CommentPlan, index: number): string {
  return plan.threads[index]!.comments.map(
    (c) =>
      el('w:commentRangeEnd', { 'w:id': c.id }) +
      el('w:r', {}, el('w:commentReference', { 'w:id': c.id })),
  ).join('');
}

/** The `comments.xml` part, holding the messages of the threads listed in `used`. */
export function commentsXml(plan: CommentPlan, used: ReadonlySet<number>): string {
  const items: string[] = [];
  plan.threads.forEach(({ comments }, index) => {
    if (!used.has(index)) return;
    for (const c of comments) items.push(commentXml(c));
  });
  return `${XML_DECLARATION}<w:comments${ROOT_DECLARATIONS}>${items.join('')}</w:comments>`;
}

function commentXml(c: PlannedComment): string {
  const lines = c.message.text.split('\n');
  const paragraphs = lines.map((line, i) => {
    const last = i === lines.length - 1;
    const runs =
      (i === 0 ? el('w:r', {}, el('w:annotationRef')) : '') +
      (line.length > 0 ? el('w:r', {}, textElement('w:t', line)) : '');
    // Word links a reply to its root by the paragraph identifier of the last paragraph.
    return el('w:p', last ? { 'w14:paraId': c.paraId } : {}, runs);
  });
  return el(
    'w:comment',
    {
      'w:id': c.id,
      'w:author': c.message.author,
      'w:date': c.message.date ?? null,
    },
    ...paragraphs,
  );
}

/** The `commentsExtended.xml` part: one entry per message, a reply naming its root's paragraph. */
export function commentsExtendedXml(plan: CommentPlan, used: ReadonlySet<number>): string {
  const items: string[] = [];
  plan.threads.forEach(({ thread, comments }, index) => {
    if (!used.has(index)) return;
    for (const c of comments)
      items.push(
        el('w15:commentEx', {
          'w15:paraId': c.paraId,
          'w15:paraIdParent': c.parentParaId,
          'w15:done': thread.done === true ? 1 : 0,
        }),
      );
  });
  return `${XML_DECLARATION}<w15:commentsEx xmlns:w15="${W15}" xmlns:w14="${NS.w14}">${items.join('')}</w15:commentsEx>`;
}

/** A comment range that a thread names with `from` and `to`, or null for the whole paragraph. */
export function rangeOf(thread: CommentThread): { from: number; to: number } | null {
  const { from, to } = thread;
  if (from === undefined || to === undefined) return null;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  return { from, to };
}

/** The type of the internal node that carries a comment marker through the inline writer. */
export const ANCHOR_NODE = 'x_comment_anchor';

/** A marker to write at a position of a paragraph's inline content. */
export interface AnchorMarker {
  offset: number;
  raw: string;
}

/**
 * The inline content of a paragraph with the markers woven in at their positions: a text node is
 * split where a marker falls inside it, and an atom counts as one position. A marker past the end
 * is written at the end. Markers at one position keep the order they were given in. The content is
 * not changed; with no markers it is returned as it is.
 */
export function weaveAnchors(
  content: readonly JsonNode[],
  markers: readonly AnchorMarker[],
): readonly JsonNode[] {
  if (markers.length === 0) return content;
  const sorted = markers
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => a.offset - b.offset || a.i - b.i);
  const out: JsonNode[] = [];
  const anchor = (raw: string): JsonNode => ({ type: ANCHOR_NODE, attrs: { raw } }) as JsonNode;
  let next = 0;
  let pos = 0;
  for (const node of content) {
    if (node.type !== 'text') {
      while (next < sorted.length && sorted[next]!.offset <= pos)
        out.push(anchor(sorted[next++]!.raw));
      out.push(node);
      pos += 1;
      continue;
    }
    let text = node.text ?? '';
    while (text.length > 0) {
      while (next < sorted.length && sorted[next]!.offset <= pos)
        out.push(anchor(sorted[next++]!.raw));
      const cut =
        next < sorted.length ? Math.min(text.length, sorted[next]!.offset - pos) : text.length;
      out.push({ ...node, text: text.slice(0, cut) });
      text = text.slice(cut);
      pos += cut;
    }
  }
  while (next < sorted.length) out.push(anchor(sorted[next++]!.raw));
  return out;
}
