/**
 * Optional features in the room (03 §11.1; CDM-047; ADR 0050 item 5). A document lists the
 * features it uses in `requires`; a client that lacks one is refused when it opens a channel
 * (`unsupported_feature`), and a commit that adds a feature is accepted only when every attached
 * client announced it. The decisions are the model's (`mayOpen`, `mayAddFeatures`); this module
 * finds the features a document uses, from the model's feature registry.
 */
import { featureRegistry } from '@docedit/model/definition';
import type { Mark, Node } from 'prosemirror-model';

interface Lookup {
  nodes: Map<string, string>;
  marks: Map<string, string>;
  /** `owner.attribute` → feature: the attribute may be non-null only with the feature. */
  attributes: Map<string, string>;
  /** `owner.attribute=value` → feature. */
  values: Map<string, string>;
}

let lookup: Lookup | null = null;

function registry(): Lookup {
  if (lookup) return lookup;
  const l: Lookup = {
    nodes: new Map(),
    marks: new Map(),
    attributes: new Map(),
    values: new Map(),
  };
  for (const f of featureRegistry()) {
    for (const n of f.nodes) l.nodes.set(n, f.name);
    for (const m of f.marks) l.marks.set(m, f.name);
    for (const a of f.attributes) l.attributes.set(a, f.name);
    for (const v of f.values) l.values.set(v, f.name);
  }
  lookup = l;
  return l;
}

function attrsUse(owner: string, attrs: Readonly<Record<string, unknown>>, out: Set<string>) {
  const l = registry();
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    const a = l.attributes.get(`${owner}.${name}`);
    if (a) out.add(a);
    if (typeof value === 'string') {
      const v = l.values.get(`${owner}.${name}=${value}`);
      if (v) out.add(v);
    }
  }
}

function marksUse(marks: readonly Mark[], out: Set<string>) {
  const l = registry();
  for (const m of marks) {
    const f = l.marks.get(m.type.name);
    if (f) out.add(f);
    attrsUse(m.type.name, m.attrs, out);
  }
}

/** The features a document uses: every feature one of whose node types, marks, attributes or values occurs. */
export function featuresUsed(doc: Node): Set<string> {
  const out = new Set<string>();
  const l = registry();
  const visit = (n: Node) => {
    const f = l.nodes.get(n.type.name);
    if (f) out.add(f);
    if (!n.isText) attrsUse(n.type.name, n.attrs, out);
    marksUse(n.marks, out);
  };
  visit(doc);
  doc.descendants((n) => {
    visit(n);
    return true;
  });
  return out;
}
