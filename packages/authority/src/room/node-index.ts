/**
 * The room's node-identifier index (03 §9; BE-019 criterion 2). Every node that carries an `id`
 * attribute maps to its type, its position and its size, so that a reader finds a block by its
 * identifier without a scan. The room builds it when it opens a document, and rebuilds it when the
 * durable head moves (see `Room.nodeIndex`). Duplicates are counted, not stored: the first node in
 * document order keeps the identifier.
 */
import type { Node } from 'prosemirror-model';

export interface NodeEntry {
  /** The node type's name, for example `paragraph` or `region`. */
  type: string;
  /** The position before the node, as `Node.descendants` gives it for the document. */
  pos: number;
  /** The node's size in the document, `Node.nodeSize`. */
  size: number;
}

export class NodeIndex {
  private readonly entries: ReadonlyMap<string, NodeEntry>;
  /** Nodes whose identifier an earlier node in document order already carries. */
  readonly duplicates: number;

  private constructor(entries: ReadonlyMap<string, NodeEntry>, duplicates: number) {
    this.entries = entries;
    this.duplicates = duplicates;
  }

  /** Builds the index of every identified node in `doc`, in one walk of the tree. */
  static build(doc: Node): NodeIndex {
    const entries = new Map<string, NodeEntry>();
    let duplicates = 0;
    doc.descendants((node, pos) => {
      const id: unknown = node.attrs['id'];
      if (typeof id !== 'string' || id === '') return true;
      if (entries.has(id)) duplicates++;
      else entries.set(id, { type: node.type.name, pos, size: node.nodeSize });
      return true;
    });
    return new NodeIndex(entries, duplicates);
  }

  /** The entry of a node identifier, or undefined when no node carries it. */
  get(id: string): NodeEntry | undefined {
    return this.entries.get(id);
  }

  /** The number of distinct identifiers the index holds. */
  get size(): number {
    return this.entries.size;
  }

  /** The identifiers, in document order. */
  ids(): string[] {
    return [...this.entries.keys()];
  }
}
