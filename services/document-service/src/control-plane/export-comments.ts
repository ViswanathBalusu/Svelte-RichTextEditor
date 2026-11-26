/**
 * The comment threads of an export with `comments: margin` (EXP-084; 09 section 10; 05 section
 * 6.2; owner decisions 52 and 39; docs/adr/0428). Comments are not in the document, so the export
 * job carries them, written here by the control plane and read by the worker:
 *
 * - the open threads only (a resolved one is left out);
 * - each range mapped from the seq it was made at to the exported `seq` through the commits between
 *   them (SYN-032, `mapRangesThrough`: the same mapping as `GET /threads?seq=`); a thread made after
 *   `seq` is left out; a range that lost all its text, or whose block is not in the document, is
 *   `detached`;
 * - the paragraph the range starts in and the words it covers (shortened);
 * - threads in a region the requester may not see are left out, as in the thread routes
 *   (ADR 0019);
 * - authors as display names. A person who was erased, or who has no name, is "Unknown person"
 *   (owner decision 39): no surrogate or host `sub` reaches the PDF.
 */
import { mapRangesThrough } from '@docedit/authority';
import type { JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { StoredThread } from '../storage/thread-store.ts';
import type { DocRef } from '../storage/types.ts';
import type { Kit } from './kit.ts';
import type { ReaderView } from './visibility.ts';

type Node = ReturnType<ReturnType<typeof cdmSchema>['nodeFromJSON']>;

/** The shape the worker reads (`CommentThread` of `@docedit/export-latex`). */
export interface CommentThreadPayload {
  id: string;
  block: string;
  quote?: string;
  detached?: true;
  messages: Array<{ author: string; text: string }>;
}

export const UNKNOWN_PERSON = 'Unknown person';

/** Most open threads one export carries, and the words of a quote kept. */
const MAX_THREADS = 500;
const MAX_QUOTE = 200;
const SCAN_PAGE = 200;

/** The plain text of a comment body: its text parts; a mention is `@` and no identifier. */
export function plainTextOf(body: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (n === null || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o['type'] === 'text' && typeof o['text'] === 'string') out.push(o['text']);
    else if (o['type'] === 'mention') out.push('@mention');
    else if (Array.isArray(o['content'])) walk(o['content']);
  };
  walk(body);
  return out.join('');
}

export async function commentThreadsAt(
  d: Kit['d'],
  args: { ref: DocRef; seq: number; doc: JsonNode; view: ReaderView },
): Promise<CommentThreadPayload[]> {
  const store = d.threads;
  if (!store) return [];
  const { ref, seq, view } = args;
  const open: StoredThread[] = [];
  for (let after: string | undefined; open.length < MAX_THREADS;) {
    const page = await store.list(ref, {
      ...(after !== undefined ? { after } : {}),
      limit: SCAN_PAGE,
    });
    for (const t of page) {
      if (t.state !== 'open' || t.comments.length === 0) continue;
      const hidden = t.scope
        .split('\n')
        .some((s) => s.startsWith('region:') && view.hidden.regions.has(s.slice('region:'.length)));
      if (hidden) continue;
      if ('range' in t.target && t.rangeSeq !== null && t.rangeSeq > seq) continue;
      open.push(t);
      if (open.length >= MAX_THREADS) break;
    }
    if (page.length < SCAN_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  if (open.length === 0) return [];

  const schema = cdmSchema();
  const pm = schema.nodeFromJSON(args.doc);
  const ids = new Set<string>();
  pm.descendants((n: Node) => {
    const id: unknown = n.attrs['id'];
    if (typeof id === 'string') ids.add(id);
  });

  const from = Math.min(
    seq,
    ...open.flatMap((t) => ('range' in t.target && t.rangeSeq !== null ? [t.rangeSeq] : [])),
  );
  const commits = from < seq ? await d.logs.read(ref, from + 1, seq) : [];

  // Display names: the surrogate to the host `sub` (an erased person has none), then the name.
  const surrogates = [...new Set(open.flatMap((t) => t.comments.map((c) => c.author)))];
  const subs = await d.users.subsOf(ref.tenant, surrogates);
  const names = new Map<string, string>();
  for (const s of surrogates) {
    const sub = subs.get(s);
    const name = sub !== undefined ? await d.users.displayName(ref.tenant, sub) : null;
    names.set(s, name !== null && name.trim() !== '' ? name.trim() : UNKNOWN_PERSON);
  }

  const out: CommentThreadPayload[] = [];
  for (const t of open) {
    const messages = t.comments
      .map((c) => ({ author: names.get(c.author) ?? UNKNOWN_PERSON, text: plainTextOf(c.body) }))
      .filter((m) => m.text.trim() !== '');
    if (messages.length === 0) continue;
    if ('block' in t.target) {
      const block = t.target.block;
      out.push({
        id: t.id,
        block,
        ...(ids.has(block) ? {} : { detached: true as const }),
        messages,
      });
      continue;
    }
    const through = commits
      .filter((c) => c.seq > t.rangeSeq! && c.seq <= seq)
      .map((c) => ({ kind: c.kind, steps: 'steps' in c ? c.steps : [] }));
    const [mapped] = mapRangesThrough([t.target.range], through, schema);
    const found = mapped && !mapped.collapsed ? blockAndQuote(pm, mapped.from, mapped.to) : null;
    out.push(
      found
        ? { id: t.id, block: found.block, quote: found.quote, messages }
        : { id: t.id, block: '', detached: true, messages },
    );
  }
  return out;
}

/** The nearest identified block around `from`, and the words from `from` to `to` in it. */
function blockAndQuote(
  pm: Node,
  from: number,
  to: number,
): { block: string; quote: string } | null {
  try {
    const $from = pm.resolve(Math.min(from, pm.content.size));
    for (let depth = $from.depth; depth > 0; depth--) {
      const id: unknown = $from.node(depth).attrs['id'];
      if (typeof id !== 'string') continue;
      const words = pm.textBetween(from, Math.min(to, pm.content.size), ' ').replace(/\s+/g, ' ');
      return {
        block: id,
        quote: words.length > MAX_QUOTE ? `${words.slice(0, MAX_QUOTE - 1)}…` : words.trim(),
      };
    }
  } catch {
    // A position outside the document: the thread is listed as detached.
  }
  return null;
}
