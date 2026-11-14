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
