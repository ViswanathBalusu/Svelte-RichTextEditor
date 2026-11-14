/**
 * Node hashes for the source map, equal to the model's `nodeHash` (03 §2) but linear in the size
 * of the document: the canonical text of a container is composed from its children's canonical
 * texts instead of canonicalising every subtree again at each level. Leaves and container heads
 * still go through the model's `canonicalNode`, so the rules stay the model's; the tests check that
 * every node's text equals `canonicalNodeText`.
 */
import { canonicalNode, canonicalize, sha256Hex, type JsonNode } from '@docedit/model';

/** Nodes whose content never holds text, so no adjacent-text merging happens at their level. */
const CONTAINERS: ReadonlySet<string> = new Set([
  'doc',
  'defs',
  'body',
  'region',
  'story',
  'table',
  'table_row',
  'table_cell',
]);

export class NodeHasher {
  private readonly texts = new WeakMap<JsonNode, string>();
  private readonly hashes = new WeakMap<JsonNode, string>();

  text(node: JsonNode): string {
    const cached = this.texts.get(node);
    if (cached !== undefined) return cached;
    let out: string;
    if (!CONTAINERS.has(node.type) || !node.content?.length)
      out = canonicalize(canonicalNode(node));
    else {
      const head: JsonNode = { type: node.type };
      if (node.attrs) head.attrs = node.attrs;
      if (node.marks) head.marks = node.marks;
      const h = canonicalNode(head);
      const members: string[] = [];
      if (h.attrs) members.push(`"attrs":${canonicalize(h.attrs)}`);
      members.push(`"content":[${node.content.map((c) => this.text(c)).join(',')}]`);
      if (h.marks) members.push(`"marks":${canonicalize(h.marks)}`);
      members.push(`"type":${canonicalize(h.type)}`);
      out = `{${members.join(',')}}`;
    }
    this.texts.set(node, out);
    return out;
  }

  async hash(node: JsonNode): Promise<string> {
    let h = this.hashes.get(node);
    if (h === undefined) {
      h = await sha256Hex(this.text(node));
      this.hashes.set(node, h);
    }
    return h;
  }
}
