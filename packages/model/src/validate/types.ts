/**
 * The types of the invariant engine (CDM-013): violations with a stable code and the node they are
 * about, the context that invariants beyond the document need, and the registration point through
 * which other packages add invariants (I13 to I15 from FRW, the rules' half of I14 later).
 */
import type { Schema } from 'prosemirror-model';
import type { CdmDefinition, InvariantId, JsonValue } from '../definition/grammar.ts';

export type { InvariantId } from '../definition/grammar.ts';

export interface Violation {
  invariant: InvariantId;
  /** Stable code, unique across invariants: the list is VIOLATION_CODES (spec/cdm/cdm-1.violations.json). */
  code: string;
  /** JSON Pointer into the envelope. */
  path: string;
  /**
   * The `id` of the node the violation is about, or of the nearest enclosing node that has one
   * (a definition's identifier for definitions); null when no node on the path has one.
   */
  nodeId: string | null;
  message: string;
}

/**
 * One identifier change made by a commit's attribute steps, in step order (I2: "a non-null `id`
 * never changes"). `copy` is true when another node held `from` when the step applied, as after a
 * split or a paste that copied the attributes: giving the copy its own identifier is allowed.
 */
export interface IdentifierChange {
  from: string | null;
  to: string | null;
  copy?: boolean;
}

export interface ValidationContext {
  def?: CdmDefinition;
  schema?: Schema;
  /** Asset identifiers attached to the document (I4). Without it, asset references are not checked. */
  attachedAssets?: ReadonlySet<string>;
  /** Region identifiers that were ever removed from the document (I3). */
  retiredRegionIds?: ReadonlySet<string>;
  /** The math gate of 09 §6.3 (I8): returns a reason to refuse, or null. Without it, I8 is not checked. */
  mathGate?: (latex: string, display: boolean) => string | null;
  /**
   * The identifier changes of the commit's attribute steps (I2 transition). Without them, "a
   * non-null `id` never changes" is listed as not checked. A change by replacement, which removes
   * one node and creates another, is not an identifier change (CDM-012, open question).
   */
  identifierChanges?: readonly IdentifierChange[];
  /**
   * The document before the commit, as an envelope or as its `doc` node. With it, the math gate
   * runs only on LaTeX the previous document did not contain: a commit that touches no `latex`
   * attribute calls the gate not at all (09 §6.3; CDM-030).
   */
  previous?: unknown;
  /** Invariant checks for this call only, beside the built-in and registered ones. */
  invariants?: readonly InvariantCheck[];
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
  /** Invariants that could not be checked because the context lacked what they need. */
  notChecked: string[];
}

/** A node of the document as the invariant engine saw it (text nodes are not listed). */
export interface IndexedNode {
  type: string;
  /** Attributes with the defaults filled in. */
  attrs: Readonly<Record<string, JsonValue>>;
  /** JSON Pointer of the node. */
  path: string;
  /** Types of the enclosing nodes, outermost first. */
  ancestors: readonly string[];
  /** The node's own `id`, or the nearest enclosing one. */
  nodeId: string | null;
  /** The node as given. */
  node: Readonly<Record<string, unknown>>;
}

/** What a registered invariant reads: the document after the built-in walk. */
export interface DocumentView {
  envelope: Readonly<Record<string, unknown>>;
  requires: ReadonlySet<string>;
  context: Readonly<ValidationContext>;
  /** Every node except text, in document order. */
  nodes: readonly IndexedNode[];
  /** The nodes of one type, in document order. */
  ofType(type: string): readonly IndexedNode[];
}

/** One violation a check reports; the engine adds the invariant of the code and the node id. */
export interface ViolationReport {
  code: string;
  path: string;
  message: string;
  /** Defaults to the id of the nearest node on `path` that has one. */
  nodeId?: string | null;
}

export interface CodeDoc {
  invariant: InvariantId;
  /** One sentence on what the code means. */
  doc: string;
}

/**
 * An invariant check registered by another package (CDM-013). It declares every code it reports;
 * a check that throws, or reports a code it did not declare, makes the document invalid with the
 * code `check_failed`, because the authority refuses what it could not check.
 */
export interface InvariantCheck {
  /** Unique name, such as `fields` or `rules`. */
  name: string;
  codes: Readonly<Record<string, CodeDoc>>;
  /** Invariants this check could not evaluate with the context it got. */
  notChecked?(view: DocumentView): readonly string[];
  check(view: DocumentView, report: (v: ViolationReport) => void): void;
}
