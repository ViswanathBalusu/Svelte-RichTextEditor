/**
 * The vocabulary of the CDM definition (CDM-006). Every attribute has a grammar (invariant I11) and
 * a default (03 §2: the canonical form omits values equal to the default). Generators turn the
 * definition into TypeScript types, the JSON Schema, the ProseMirror schema and documentation.
 */

export type FeatureName = 'fields' | 'extensions' | 'preserve';

/** The invariants of 03 §8 (I1 to I12) and 12 §3.6 (I13 to I15). */
export type InvariantId =
  | 'I1'
  | 'I2'
  | 'I3'
  | 'I4'
  | 'I5'
  | 'I6'
  | 'I7'
  | 'I8'
  | 'I9'
  | 'I10'
  | 'I11'
  | 'I12'
  | 'I13'
  | 'I14'
  | 'I15';

/**
 * What is wrong with a value, as the grammar check sees it. An attribute can name the invariant a
 * kind of problem belongs to (`AttrDef.reportAs`); every other problem is I11.
 */
export type GrammarProblemKind =
  /** The JSON type is wrong (a number where a string belongs). */
  | 'type'
  /** Null where the grammar does not allow it. */
  | 'null'
  /** A string longer or shorter than its bounds. */
  | 'length'
  /** A string that does not match its pattern. */
  | 'pattern'
  /** A control character in a string. */
  | 'control'
  /** An integer outside its range, or a number that is not an integer. */
  | 'range'
  /** A value outside its enumeration. */
  | 'enum'
  /** A reference that is not an identifier of its kind. */
  | 'reference'
  /** A member an object grammar does not declare, or a required one missing. */
  | 'member'
  /** An array with too many or too few items. */
  | 'count'
  /** Free JSON or an element tree larger than its bound in bytes. */
  | 'size'
  /** Free JSON or an element tree nested deeper than its bound. */
  | 'depth'
  /** A key of free JSON that does not match its pattern. */
  | 'key'
  /** An element tree that is not made of elements and text in Clark notation. */
  | 'element';

/** What a reference attribute points at; used by invariant I4. */
export type RefTarget =
  | 'paragraphStyle'
  | 'characterStyle'
  | 'tableStyle'
  | 'anyStyle'
  | 'numbering'
  | 'pageSetup'
  | 'headerStory'
  | 'footerStory'
  | 'asset'
  | 'role'
  | 'source'
  | 'preservedDef';

interface GrammarBase {
  /** Whether null is a valid stored value. */
  nullable?: boolean;
}

export interface StringGrammar extends GrammarBase {
  kind: 'string';
  minLength?: number;
  maxLength: number;
  /** ASCII-only ECMAScript regular expression, anchored. */
  pattern?: string;
  /** Rejects C0 and C1 control characters other than tab (default true). */
  noControl?: boolean;
}

export interface IntegerGrammar extends GrammarBase {
  kind: 'integer';
  min: number;
  max: number;
}

export interface BooleanGrammar extends GrammarBase {
  kind: 'boolean';
}

export interface EnumGrammar extends GrammarBase {
  kind: 'enum';
  values: readonly string[];
}

export interface RefGrammar extends GrammarBase {
  kind: 'ref';
  to: RefTarget;
}

export interface ObjectGrammar extends GrammarBase {
  kind: 'object';
  properties: Readonly<Record<string, Grammar>>;
  required?: readonly string[];
}

export interface ArrayGrammar extends GrammarBase {
  kind: 'array';
  items: Grammar;
  minItems?: number;
  maxItems: number;
}

/** Free JSON (payloads, `ext`): integers only, bounded in size and depth. */
export interface JsonGrammar extends GrammarBase {
  kind: 'json';
  maxBytes: number;
  maxDepth: number;
  /** For `ext`: member names must match this pattern. */
  keyPattern?: string;
  /** The top-level value must be an object. */
  objectOnly?: boolean;
}

/**
 * Preserved properties (ADR 0017): `{ attrs?, children? }` with element names in registered-prefix
 * or Clark notation, or `{ ref }`, a reference to a shared tree in `preserved_def` (spike S11).
 */
export interface ElementTreeGrammar extends GrammarBase {
  kind: 'elementTree';
  maxBytes: number;
  maxDepth: number;
  /** The tree itself, never a reference (the shared trees of `preserved_def`). */
  noRef?: boolean;
}

export type Grammar =
  | StringGrammar
  | IntegerGrammar
  | BooleanGrammar
  | EnumGrammar
  | RefGrammar
  | ObjectGrammar
  | ArrayGrammar
  | JsonGrammar
  | ElementTreeGrammar;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AttrDef {
  grammar: Grammar;
  default: JsonValue;
  /**
   * `required`: must be present and valid in a stored document. The default exists only so that
   * ProseMirror can create the node (03 §9), so it need not satisfy the grammar; `id` attributes
   * and invariant I2 are the main case.
   */
  presence?: 'required';
  /** The attribute may be non-null only when the document requires this feature (I1). */
  feature?: FeatureName;
  /**
   * Values of an enumeration that belong to a feature: the value may be used only when the
   * document requires it (I1). For example the `field` kind `formValue` belongs to `fields`.
   */
  valueFeatures?: Readonly<Record<string, FeatureName>>;
  /**
   * The invariant that a kind of grammar problem of this attribute belongs to, instead of I11:
   * `latex` lengths are I7, a link scheme is I9, an extension's envelope is I12. `'*'` covers
   * every kind.
   */
  reportAs?: Readonly<Partial<Record<GrammarProblemKind | '*', InvariantId>>>;
  doc: string;
}

export interface NodeDef {
  name: string;
  feature?: FeatureName;
  /** Space-separated ProseMirror groups. */
  group?: string;
  /** ProseMirror content expression. */
  content?: string;
  /** Marks allowed on children (for block containers: the node marks of 03 §5). */
  marks?: string;
  inline?: boolean;
  atom?: boolean;
  selectable?: boolean;
  draggable?: boolean;
  isolating?: boolean;
  defining?: boolean;
  /** Closed to the gap cursor (CDM-008: definitions and stories). */
  allowGapCursor?: boolean;
  attrs: Readonly<Record<string, AttrDef>>;
  /** Spec section the node comes from. */
  spec: string;
  doc: string;
}

export interface MarkDef {
  name: string;
  feature?: FeatureName;
  attrs: Readonly<Record<string, AttrDef>>;
  /** ProseMirror `excludes`; omitted means the mark excludes only itself. */
  excludes?: string;
  inclusive?: boolean;
  spec: string;
  doc: string;
}

export interface FeatureDef {
  name: FeatureName;
  doc: string;
}

/**
 * A node that exists only in a reader's projection of a document (ADR 0019), never in a stored
 * document or a commit. The projection schema is the CDM schema plus these nodes.
 */
export interface ProjectionNodeDef extends Omit<NodeDef, 'group'> {
  /** The node types whose content may hold it in a projection, beside their own content. */
  allowedIn: readonly string[];
}

export interface CdmDefinition {
  /** Major schema version (03 §2). */
  cdm: number;
  /** Draft until CDM-001, CDM-002 and spike S11 are recorded (CDM-007 notes). */
  status: 'draft' | 'frozen';
  features: readonly FeatureDef[];
  /** In schema order; the order of marks is part of the canonical form (03 §2). */
  nodes: readonly NodeDef[];
  marks: readonly MarkDef[];
  topNode: string;
  /** Nodes of projections only (ADR 0019): placeholders for what a reader may not see. */
  projection?: readonly ProjectionNodeDef[];
}

// ---------------------------------------------------------------------------------------------
// Grammar constructors, so that the definition reads like the tables of 03.

export const str = (
  maxLength: number,
  extra: Omit<StringGrammar, 'kind' | 'maxLength'> = {},
): StringGrammar => ({
  kind: 'string',
  maxLength,
  ...extra,
});
export const int = (
  min: number,
  max: number,
  extra: Omit<IntegerGrammar, 'kind' | 'min' | 'max'> = {},
): IntegerGrammar => ({
  kind: 'integer',
  min,
  max,
  ...extra,
});
export const bool = (extra: Omit<BooleanGrammar, 'kind'> = {}): BooleanGrammar => ({
  kind: 'boolean',
  ...extra,
});
export const oneOf = (
  values: readonly string[],
  extra: Omit<EnumGrammar, 'kind' | 'values'> = {},
): EnumGrammar => ({
  kind: 'enum',
  values,
  ...extra,
});
export const ref = (to: RefTarget, extra: Omit<RefGrammar, 'kind' | 'to'> = {}): RefGrammar => ({
  kind: 'ref',
  to,
  ...extra,
});
export const obj = (
  properties: Record<string, Grammar>,
  extra: Omit<ObjectGrammar, 'kind' | 'properties'> = {},
): ObjectGrammar => ({ kind: 'object', properties, ...extra });
export const arr = (
  items: Grammar,
  maxItems: number,
  extra: Omit<ArrayGrammar, 'kind' | 'items' | 'maxItems'> = {},
): ArrayGrammar => ({
  kind: 'array',
  items,
  maxItems,
  ...extra,
});
export const nullable = <G extends Grammar>(g: G): G => ({ ...g, nullable: true });

export function attr(
  grammar: Grammar,
  def: JsonValue,
  doc: string,
  extra: Omit<AttrDef, 'grammar' | 'default' | 'doc'> = {},
): AttrDef {
  return { grammar, default: def, doc, ...extra };
}
