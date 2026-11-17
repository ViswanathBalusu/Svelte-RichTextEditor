/**
 * What the assistant may be given (UX-047; 13 §6.2; ADR 0019), read from the live document.
 *
 * The request holds the selection, the blocks around it and the outline, and what the host attaches,
 * and nothing else: no token, no other user's profile data, no text of a scope the reader cannot
 * view, no text of the definitions, the headers, the footers or the footnotes. The function reads
 * only the document, the selection range and the `canView` check it is given, so no other state of
 * the core (the access object, the presence list, the user) can reach the request.
 *
 * Defaults of this module, proposed and not from the spec (the story's Notes): the surrounding
 * blocks are the one text block before the first selected block and the one after the last; a block
 * the reader cannot view contributes nothing and is only counted; a selection that runs over
 * several blocks gives one `text` with the blocks' selected parts joined by a line feed, `blockId`
 * of the first block, and `from` and `to` as offsets into that first block's text (`to` stops at the
 * end of that block).
 */
import type { AssistantContext, AssistantTask } from '@docedit/protocol';
import type { Node as PMNode } from 'prosemirror-model';
import { regionAt } from './regions.ts';

/** What the host attaches through the port, passed on as it was given and marked as the host's. */
export interface HostAttachment {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export interface AttachmentOut extends HostAttachment {
  readonly source: 'host';
}

/** The protocol's context, with the host's attachments when there are any. */
export interface AssistantRequestContext extends AssistantContext {
  readonly attachments?: readonly AttachmentOut[];
}

export interface AssistantRequest {
  readonly docId: string;
  readonly task: AssistantTask;
  readonly prompt: string;
  readonly context: AssistantRequestContext;
}

interface BodyBlock {
  readonly id: string;
  readonly scope: string;
  readonly text: string;
  /** Document position of the first character of the block's text. */
  readonly start: number;
}

function bodyBlocks(doc: PMNode): BodyBlock[] {
  const out: BodyBlock[] = [];
  const body = doc.lastChild;
  if (!body || body.type.name !== 'body') return out;
  const bodyStart = doc.content.size - body.nodeSize + 1;
  body.descendants((node, offset) => {
    if (!node.isTextblock) return true;
    const id = node.attrs['id'];
    if (typeof id === 'string') {
      const start = bodyStart + offset + 1;
      const region = regionAt(doc.resolve(start));
      out.push({
        id,
        scope: region?.id ? `region:${region.id}` : 'body',
        text: node.textBetween(0, node.content.size, undefined, ' '),
        start,
      });
    }
    return false;
  });
  return out;
}

export interface AssembledContext {
  readonly context: AssistantRequestContext;
  /** Blocks and outline entries left out because the reader cannot view their scope. */
  readonly omitted: number;
}

/** Builds the context of a request from the document, the selection range and the view check. */
export function assembleAssistantContext(
  doc: PMNode,
  range: { readonly from: number; readonly to: number },
  canView: (scope: string) => boolean,
  outline: ReadonlyArray<{ readonly id: string; readonly level: number; readonly text: string }>,
  attachments: readonly HostAttachment[] = [],
): AssembledContext {
  const blocks = bodyBlocks(doc);
  const scopeOf = new Map(blocks.map((b) => [b.id, b.scope]));
  let omitted = 0;

  // The blocks the selection touches (a caret touches the block it is in).
  const touched = blocks.filter(
    (b) => range.from <= b.start + b.text.length && range.to >= b.start,
  );
  let selection: AssistantContext['selection'];
  if (range.from !== range.to) {
    const parts: string[] = [];
    let first: { blockId: string; from: number; to: number } | null = null;
    for (const b of touched) {
      if (!canView(b.scope)) {
        omitted++;
        continue;
      }
      const a = Math.max(range.from, b.start) - b.start;
      const z = Math.min(range.to, b.start + b.text.length) - b.start;
      if (z <= a) continue;
      parts.push(b.text.slice(a, z));
      first ??= { blockId: b.id, from: a, to: z };
    }
    if (first) selection = { ...first, text: parts.join('\n') };
  }

  // The one block before the first touched block and the one after the last.
  const surrounding: BodyBlock[] = [];
  const firstAt = touched.length ? blocks.indexOf(touched[0]!) : -1;
  const lastAt = touched.length ? blocks.indexOf(touched[touched.length - 1]!) : -1;
  for (const at of [firstAt - 1, lastAt + 1]) {
    const b = at >= 0 ? blocks[at] : undefined;
    if (!b || b.text === '') continue;
    if (canView(b.scope)) surrounding.push(b);
    else omitted++;
  }

  const kept: Array<{ blockId: string; level: number; text: string }> = [];
  for (const o of outline) {
    const scope = scopeOf.get(o.id);
    if (scope !== undefined && canView(scope))
      kept.push({ blockId: o.id, level: o.level, text: o.text });
    else omitted++;
  }

  const context: AssistantRequestContext = {
    ...(selection ? { selection } : {}),
    blocks: surrounding.map((b) => ({ blockId: b.id, scope: b.scope, text: b.text })),
    outline: kept,
    ...(attachments.length > 0
      ? {
          attachments: attachments.map((a) => ({
            source: 'host' as const,
            id: a.id,
            label: a.label,
            text: a.text,
          })),
        }
      : {}),
  };
  return { context, omitted };
}
