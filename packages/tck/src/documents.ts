/**
 * The documents the kit creates and the steps it submits. Steps are JSON as `Step.toJSON()` of the
 * pinned prosemirror-transform release writes them (04 §4), and positions are computed from CDM
 * JSON with the CDM definition alone: the kit needs no editor code to build a commit.
 */
import type { CdmEnvelope } from '@docedit/model';
import { CDM1 } from '@docedit/model/definition';
import { IDS, contractDocument, importedDocument } from '@docedit/protocol/contract';
import type { Step } from '@docedit/protocol';

export { IDS, contractDocument, importedDocument };

/** The scope of the restricted region of the contract document. */
export const LOCKED_SCOPE = `region:${IDS.locked}`;
export const OPEN_SCOPE = `region:${IDS.open}`;

export interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: unknown[];
  text?: string;
}

const LEAVES: ReadonlySet<string> = new Set(
  CDM1.nodes.filter((n) => !n.content).map((n) => n.name),
);

/** ProseMirror size of a node from its JSON: text length, 1 for a leaf, 2 plus content otherwise. */
export function nodeSize(n: JsonNode): number {
  // ProseMirror counts text in UTF-16 code units.
  if (n.type === 'text') return (n.text ?? '').length;
  if (LEAVES.has(n.type)) return 1;
  return 2 + (n.content ?? []).reduce((s, c) => s + nodeSize(c), 0);
}

function search(node: JsonNode, id: string, start: number): number | null {
  let pos = node.type === 'doc' ? 0 : start + 1;
  for (const child of node.content ?? []) {
    if (child.attrs?.['id'] === id) return pos;
    if (child.type !== 'text' && !LEAVES.has(child.type)) {
      const inner = search(child, id, pos);
      if (inner !== null) return inner;
    }
    pos += nodeSize(child);
  }
  return null;
}

/** The position just before the node with this `id`. */
export function posBefore(doc: unknown, id: string): number {
  const found = search(doc as JsonNode, id, 0);
  if (found === null) throw new Error(`no node ${id} in the document`);
  return found;
}

/** The position just inside the start of the node with this `id`, plus `offset`. */
export function posIn(doc: unknown, id: string, offset = 0): number {
  return posBefore(doc, id) + 1 + offset;
}

/** The node with this `id`. */
export function nodeById(doc: unknown, id: string): JsonNode | null {
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return find(doc as JsonNode);
}

/** The plain text of the node with this `id`. */
export function textOf(doc: unknown, id: string): string {
  const node = nodeById(doc, id);
  if (!node) throw new Error(`no node ${id} in the document`);
  const collect = (n: JsonNode): string =>
    n.type === 'text' ? (n.text ?? '') : (n.content ?? []).map(collect).join('');
  return collect(node);
}

/** Every text in the document, concatenated: for leak checks. */
export function allText(doc: unknown): string {
  const collect = (n: JsonNode): string =>
    n.type === 'text' ? (n.text ?? '') : (n.content ?? []).map(collect).join(' ');
  return collect(doc as JsonNode);
}

export function insertText(pos: number, text: string): Step {
  return { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } };
}

export function deleteRange(from: number, to: number): Step {
  return { stepType: 'replace', from, to };
}

export function setAttr(pos: number, attr: string, value: unknown): Step {
  return { stepType: 'attr', pos, attr, value };
}

/** A paragraph with an identifier and text. */
export function paragraph(id: string, text: string): JsonNode {
  return {
    type: 'paragraph',
    attrs: { id },
    ...(text ? { content: [{ type: 'text', text }] } : {}),
  };
}

/** The contract document with its body replaced. */
export function withBody(body: JsonNode[]): CdmEnvelope {
  const env = contractDocument();
  const root = env.doc as unknown as JsonNode;
  const b = root.content!.find((n) => n.type === 'body')!;
  b.content = body;
  return env;
}

/** A document of `n` paragraphs, for catch-up and size scenarios. */
export function longDocument(n: number, text = 'Paragraph'): CdmEnvelope {
  return withBody(
    Array.from({ length: n }, (_, i) =>
      paragraph(`pLong${String(i).padStart(11, '0')}`, `${text} ${i}`),
    ),
  );
}

/** A random identifier of the node-identifier form (03 §9): 16 characters. */
export function nodeIdOf(prefix: string, n: number): string {
  const body = `${prefix}${n.toString(36)}`;
  return (body + '0000000000000000').slice(0, 16);
}
