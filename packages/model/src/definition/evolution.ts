/**
 * The check behind CDM-048 criterion 5 (03 §11.2): within one `cdm` major version, a node or mark
 * may not gain or lose a top-level attribute. New optional data enters `ext`, and an attribute
 * leaves `ext` only at the next major version. This module compares two definitions and lists the
 * changes; it is pure, so a CI job can call it on the generated definitions of two releases.
 * The CI job itself is not built (CDM-048 criterion 5 stays open).
 */
import type { CdmDefinition } from './grammar.ts';

export interface AttributeShapeChange {
  /** "node" or "mark". */
  kind: 'node' | 'mark';
  /** The node or mark name. */
  name: string;
  /** The top-level attribute, `ext` excluded. */
  attribute: string;
  change: 'gained' | 'lost';
}

/**
 * Top-level attributes that the two definitions do not share, for every node and mark present in
 * both or in one of them. `ext` is part of every shape and never reported. A node or mark that
 * exists in only one definition is reported as "added" through its attributes, not as a change of
 * shape: adding a whole node type is a feature change (CDM-047), not an attribute change.
 */
export function attributeShapeChanges(
  before: CdmDefinition,
  after: CdmDefinition,
): AttributeShapeChange[] {
  const out: AttributeShapeChange[] = [];
  const compare = (
    kind: 'node' | 'mark',
    a: readonly { name: string; attrs: Readonly<Record<string, unknown>> }[],
    b: readonly { name: string; attrs: Readonly<Record<string, unknown>> }[],
  ) => {
    const other = new Map(b.map((d) => [d.name, d]));
    for (const d of a) {
      const e = other.get(d.name);
      if (!e) continue;
      const left = new Set(Object.keys(d.attrs).filter((k) => k !== 'ext'));
      const right = new Set(Object.keys(e.attrs).filter((k) => k !== 'ext'));
      for (const k of [...right].sort())
        if (!left.has(k)) out.push({ kind, name: d.name, attribute: k, change: 'gained' });
      for (const k of [...left].sort())
        if (!right.has(k)) out.push({ kind, name: d.name, attribute: k, change: 'lost' });
    }
  };
  compare('node', before.nodes, after.nodes);
  compare('mark', before.marks, after.marks);
  return out;
}
