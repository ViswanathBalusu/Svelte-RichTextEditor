/**
 * The document and steps backend-dep's own tests work with: the contract suite's document, and
 * positions computed from CDM JSON with the CDM definition (no ProseMirror), as the suite does.
 */
import { CDM1 } from '@docedit/model/definition';
import type { Step } from '@docedit/protocol';
import { IDS, USERS, contractDocument } from '@docedit/protocol/contract';
import type { GrantSpec } from '@docedit/protocol/contract';

export { IDS, USERS, contractDocument };

/** Opens the restricted region to `group:legal`, as the contract suite does. */
export const LEGAL_GRANT: GrantSpec = {
  region: IDS.locked,
  principal: 'group:legal',
  role: 'editor',
};

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
}

const LEAVES: ReadonlySet<string> = new Set(
  CDM1.nodes.filter((n) => !n.content).map((n) => n.name),
);

function size(n: JsonNode): number {
  if (n.type === 'text') return (n.text ?? '').length;
  if (LEAVES.has(n.type)) return 1;
  return 2 + (n.content ?? []).reduce((s, c) => s + size(c), 0);
}

/** The position just inside the start of the node with this `id`. */
export function posIn(doc: unknown, id: string): number {
  const visit = (node: JsonNode, start: number): number | null => {
    let pos = node.type === 'doc' ? 0 : start + 1;
    for (const child of node.content ?? []) {
      if (child.attrs?.['id'] === id) return pos;
      if (child.type !== 'text' && !LEAVES.has(child.type)) {
        const inner = visit(child, pos);
        if (inner !== null) return inner;
      }
      pos += size(child);
    }
    return null;
  };
  const found = visit(doc as JsonNode, 0);
  if (found === null) throw new Error(`no node ${id}`);
  return found + 1;
}

export function insertText(pos: number, text: string): Step {
  return { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } };
}

/** The text of the node with this `id`. */
export function textOf(doc: unknown, id: string): string {
  const find = (n: JsonNode): JsonNode | null =>
    n.attrs?.['id'] === id ? n : ((n.content ?? []).map(find).find((x) => x !== null) ?? null);
  const collect = (n: JsonNode): string =>
    n.type === 'text' ? (n.text ?? '') : (n.content ?? []).map(collect).join('');
  const node = find(doc as JsonNode);
  if (!node) throw new Error(`no node ${id}`);
  return collect(node);
}
