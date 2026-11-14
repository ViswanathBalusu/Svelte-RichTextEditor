/**
 * The feature registry of the CDM (03 §11.1; CDM-047): which node types, marks, attributes and
 * attribute values belong to each optional feature, and the pure decisions the room and the
 * gateway take about features (05 §1 rule 4, §5.2). Protocol and CDM features share one namespace
 * (05 §1), so a CDM feature name must not name a protocol feature of another meaning.
 */
import { CDM1 } from './cdm1.ts';
import type { CdmDefinition, FeatureName } from './grammar.ts';

export interface FeatureEntry {
  name: FeatureName;
  doc: string;
  /** Node types of the feature. */
  nodes: string[];
  /** Marks of the feature. */
  marks: string[];
  /** Attributes of core nodes and marks that may be non-null only with the feature, as `owner.name`. */
  attributes: string[];
  /** Enumeration values of core attributes that belong to the feature, as `owner.name=value`. */
  values: string[];
}

/** Every feature of a definition with its members, in definition order. */
export function featureRegistry(def: CdmDefinition = CDM1): FeatureEntry[] {
  return def.features.map((f) => {
    const entry: FeatureEntry = {
      name: f.name,
      doc: f.doc,
      nodes: [],
      marks: [],
      attributes: [],
      values: [],
    };
    const owners = [
      ...def.nodes.map((n) => ({ owner: n, mark: false })),
      ...def.marks.map((m) => ({ owner: m, mark: true })),
    ];
    for (const { owner, mark } of owners) {
      if (owner.feature === f.name) (mark ? entry.marks : entry.nodes).push(owner.name);
      for (const [attrName, a] of Object.entries(owner.attrs)) {
        if (a.feature === f.name && owner.feature !== f.name)
          entry.attributes.push(`${owner.name}.${attrName}`);
        for (const [value, feature] of Object.entries(a.valueFeatures ?? {}))
          if (feature === f.name) entry.values.push(`${owner.name}.${attrName}=${value}`);
      }
    }
    return entry;
  });
}

/** The CDM features a reader of this package understands; what `hello` and `ch.open` announce. */
export function supportedFeatures(def: CdmDefinition = CDM1): FeatureName[] {
  return def.features.map((f) => f.name);
}

/** The features a document gains between two values of `requires`, sorted. */
export function addedFeatures(before: readonly string[], after: readonly string[]): string[] {
  const had = new Set(before);
  return [...new Set(after)].filter((f) => !had.has(f)).sort();
}

export type FeatureDecision = { ok: true } | { ok: false; missing: string[] };

/**
 * Whether a commit may change `requires` from `before` to `after` (03 §11.1): a commit that adds a
 * feature is accepted only when every attached client announced it. `clients` holds the features
 * each attached client announced. `missing` lists every added feature some client lacks.
 */
export function mayAddFeatures(
  before: readonly string[],
  after: readonly string[],
  clients: ReadonlyArray<readonly string[]>,
): FeatureDecision {
  const added = addedFeatures(before, after);
  const missing = added.filter((f) => clients.some((c) => !c.includes(f)));
  return missing.length ? { ok: false, missing } : { ok: true };
}

/**
 * Whether a client that announced `announced` may open a document whose `requires` is `requires`
 * (03 §11.1): it is refused with `unsupported_feature` when it lacks one, and `missing` names each.
 */
export function mayOpen(
  requires: readonly string[],
  announced: readonly string[],
): FeatureDecision {
  const missing = [...new Set(requires)].filter((f) => !announced.includes(f)).sort();
  return missing.length ? { ok: false, missing } : { ok: true };
}

/** A feature name as the protocol registry lists it (spec/dep/dep-1.registry.json). */
export interface ProtocolFeature {
  name: string;
  /** The epic that owns the name. */
  owner: string;
}

/**
 * The shared namespace check (05 §1; CDM-047): returns one problem for each CDM feature whose name
 * the protocol registry gives to a feature owned by another epic, or does not list at all. The
 * CDM's features are owned by CDM, except `fields`, which FRW owns on both sides (12 §10).
 */
export function namespaceProblems(
  protocol: readonly ProtocolFeature[],
  def: CdmDefinition = CDM1,
): string[] {
  const owners: Readonly<Record<string, readonly string[]>> = { fields: ['FRW', 'CDM'] };
  const problems: string[] = [];
  for (const f of def.features) {
    const entry = protocol.find((p) => p.name === f.name);
    const allowed = owners[f.name] ?? ['CDM'];
    if (!entry) problems.push(`CDM feature "${f.name}" is missing from the protocol registry`);
    else if (!allowed.includes(entry.owner))
      problems.push(
        `CDM feature "${f.name}" is a protocol feature of ${entry.owner}; protocol and CDM features share one namespace`,
      );
  }
  return problems;
}
