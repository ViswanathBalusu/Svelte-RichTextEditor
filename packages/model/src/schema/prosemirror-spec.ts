/**
 * The ProseMirror schema of the CDM as plain data (CDM-008). Applying a step depends on the schema
 * (04 §4), so this spec is published as a normative artifact with a content hash, and the runtime
 * schema in ../prosemirror is built from exactly this data. Rendering (toDOM, parseDOM) is added by
 * the editor and does not change step semantics.
 */
import type { CdmDefinition, Grammar, NodeDef, ProjectionNodeDef } from '../definition/grammar.ts';
import { extendContent } from './content-expr.ts';

export interface AttributeSpecJson {
  default: unknown;
  /** ProseMirror's type check (prosemirror-model 1.22 or later), run by Node.check(). */
  validate?: string;
}

export interface NodeSpecJson {
  content?: string;
  marks?: string;
  group?: string;
  inline?: boolean;
  atom?: boolean;
  selectable?: boolean;
  draggable?: boolean;
  isolating?: boolean;
  defining?: boolean;
  allowGapCursor?: boolean;
  attrs?: Record<string, AttributeSpecJson>;
}

export interface MarkSpecJson {
  excludes?: string;
  inclusive?: boolean;
  attrs?: Record<string, AttributeSpecJson>;
}

export interface ProseMirrorSchemaJson {
  cdm: number;
  topNode: string;
  /** Ordered: [name, spec] pairs. Mark order is significant (03 §2). */
  nodes: Array<[string, NodeSpecJson]>;
  marks: Array<[string, MarkSpecJson]>;
}

function typeOf(g: Grammar): string | undefined {
  switch (g.kind) {
    case 'string':
    case 'enum':
    case 'ref':
      return 'string';
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
    case 'array':
    case 'elementTree':
      return 'object';
    case 'json':
      return g.objectOnly ? 'object' : undefined;
  }
}

function attrSpec(g: Grammar, def: unknown): AttributeSpecJson {
  const t = typeOf(g);
  const spec: AttributeSpecJson = { default: def };
  if (t) spec.validate = g.nullable || def === null ? `${t}|null` : t;
  return spec;
}

function nodeSpec(n: NodeDef | ProjectionNodeDef): NodeSpecJson {
  const s: NodeSpecJson = {};
  if (n.content !== undefined) s.content = n.content;
  if (n.marks !== undefined) s.marks = n.marks;
  if ('group' in n && n.group !== undefined) s.group = n.group;
  if (n.inline) s.inline = true;
  if (n.atom) s.atom = true;
  if (n.selectable !== undefined) s.selectable = n.selectable;
  if (n.draggable !== undefined) s.draggable = n.draggable;
  if (n.isolating) s.isolating = true;
  if (n.defining) s.defining = true;
  if (n.allowGapCursor !== undefined) s.allowGapCursor = n.allowGapCursor;
  const attrs = Object.entries(n.attrs);
  if (attrs.length)
    s.attrs = Object.fromEntries(attrs.map(([k, a]) => [k, attrSpec(a.grammar, a.default)]));
  return s;
}

/**
 * The projection schema as data (ADR 0019; CDM-053): the CDM schema, with each projection node
 * added at the end and as one more choice in the content of the nodes that may hold it. Only
 * projections use it; a stored document is always read with the CDM schema.
 */
export function generateProjectionSpec(def: CdmDefinition): ProseMirrorSchemaJson {
  const base = generateProseMirrorSpec(def);
  const projection = def.projection ?? [];
  const nodes: Array<[string, NodeSpecJson]> = base.nodes.map(([name, s]) => {
    let content = s.content;
    for (const p of projection)
      if (p.allowedIn.includes(name) && content !== undefined)
        content = extendContent(content, p.name);
    return [name, content === undefined || content === s.content ? s : { ...s, content }];
  });
  for (const p of projection) nodes.push([p.name, nodeSpec(p)]);
  return { ...base, nodes };
}

export function generateProseMirrorSpec(def: CdmDefinition): ProseMirrorSchemaJson {
  const nodes: Array<[string, NodeSpecJson]> = def.nodes.map((n) => [n.name, nodeSpec(n)]);
  const marks: Array<[string, MarkSpecJson]> = def.marks.map((m) => {
    const s: MarkSpecJson = {};
    if (m.excludes !== undefined) s.excludes = m.excludes;
    if (m.inclusive !== undefined) s.inclusive = m.inclusive;
    const attrs = Object.entries(m.attrs);
    if (attrs.length)
      s.attrs = Object.fromEntries(attrs.map(([k, a]) => [k, attrSpec(a.grammar, a.default)]));
    return [m.name, s];
  });
  return { cdm: def.cdm, topNode: def.topNode, nodes, marks };
}
