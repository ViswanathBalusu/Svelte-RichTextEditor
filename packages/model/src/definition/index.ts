/**
 * Entry point for the CDM definition (CDM-006). No ProseMirror import: a consumer can read the
 * definition, the grammars and the generated types with a JSON parser alone (03 §1 principle 2).
 */
import { CDM1 } from './cdm1.ts';
import type {
  AttrDef,
  CdmDefinition,
  FeatureName,
  MarkDef,
  NodeDef,
  ProjectionNodeDef,
} from './grammar.ts';

export * from './grammar.ts';
export {
  BLOCK_FORMAT_ATTRIBUTES,
  BUILT_IN_STYLES,
  BULLET_CHARS,
  CDM1,
  DEFINITION_ID_PATTERN,
  EXT_KEY_PATTERN,
  FIELD_KEY_PATTERN,
  FIELD_NODE_KINDS,
  FIELD_TARGET_PATTERN,
  HIGHLIGHT_VALUES,
  LINK_HREF_PATTERN,
  NODE_MARK_HOSTS,
  NO_PAGE_BREAK_CONTAINERS,
  REGION_POLICIES,
} from './cdm1.ts';
export {
  FIELD_KINDS,
  FIELD_LIMITS,
  FILL_ATTRIBUTES,
  FILLABLE_FIELD_KINDS,
  RESERVED_FIELD_KINDS,
  SERVER_SET_FIELD_KINDS,
  SIGNATURE_MODES,
  VALIDATION_PRESETS,
  type FieldKind,
} from './fields.ts';
export { CITATION_STYLES, LOCATOR_LABELS, SOURCE_KINDS } from './citations.ts';
export { PRESERVED_NAME_PATTERN, PRESERVED_PREFIXES, REGISTERED_NAMESPACES } from './namespaces.ts';
export { PRESERVED_BYTES, PRESERVED_DEPTH, PRESERVED_STYLE_BYTES } from './shared.ts';
export {
  HIDDEN_REGION,
  REDACTED_FIELD_ATTRIBUTES,
  REDACTION_MARKER,
  isRedactionMarker,
  redactionMarker,
} from './projection.ts';
export {
  addedFeatures,
  featureRegistry,
  mayAddFeatures,
  mayOpen,
  namespaceProblems,
  supportedFeatures,
  type FeatureDecision,
  type FeatureEntry,
  type ProtocolFeature,
} from './features.ts';
export {
  FIELD_KIND_SUPPORT,
  MARK_SUPPORT,
  NODE_SUPPORT,
  PAGE_SETUP_FEATURES,
  PAGE_SETUP_SUPPORT,
  SUPPORT_LEVELS,
  writerSupportProblems,
  type SupportLevel,
  type WriterSupport,
} from './writer-support.ts';

/** Fast lookups over a definition. */
export interface DefinitionIndex {
  def: CdmDefinition;
  nodes: ReadonlyMap<string, NodeDef>;
  marks: ReadonlyMap<string, MarkDef>;
  markRank: ReadonlyMap<string, number>;
  features: ReadonlySet<FeatureName>;
  /** Node types that declare an `id` attribute (invariant I2). */
  idNodes: ReadonlySet<string>;
  /** Node types that exist only in projections (ADR 0019). */
  projectionNodes: ReadonlyMap<string, ProjectionNodeDef>;
}

const cache = new WeakMap<CdmDefinition, DefinitionIndex>();

export function indexDefinition(def: CdmDefinition = CDM1): DefinitionIndex {
  let ix = cache.get(def);
  if (ix) return ix;
  const nodes = new Map(def.nodes.map((n) => [n.name, n]));
  const marks = new Map(def.marks.map((m) => [m.name, m]));
  const markRank = new Map(def.marks.map((m, i) => [m.name, i]));
  const idNodes = new Set(def.nodes.filter((n) => 'id' in n.attrs).map((n) => n.name));
  const projectionNodes = new Map((def.projection ?? []).map((n) => [n.name, n]));
  ix = {
    def,
    nodes,
    marks,
    markRank,
    features: new Set(def.features.map((f) => f.name)),
    idNodes,
    projectionNodes,
  };
  cache.set(def, ix);
  return ix;
}

export function attrsOf(def: NodeDef | MarkDef): ReadonlyArray<[string, AttrDef]> {
  return Object.entries(def.attrs);
}
