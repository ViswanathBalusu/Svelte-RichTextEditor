/**
 * The CDM fragment types (03 §2; FE-027; 05 §8.1). They live apart from `api.ts`, which imports
 * `clipboard.ts`, and that module names these types, so that the two form no cycle. `api.ts`
 * re-exports them.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */

/** A CDM node as plain JSON (03 §2): `type`, `attrs`, `content` and `marks`, as the envelope holds them. */
export interface CdmJsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: CdmJsonNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

/**
 * A CDM fragment (FE-027; 05 §8.1): the selected blocks as plain JSON, with the open depths of the
 * selection's ends, and the style definitions (`style_def`) the blocks refer to, with their `basedOn`
 * and `next` chains. `requires` is the document's list, so a fragment says what it needs.
 */
export interface CdmFragment {
  readonly cdm: number;
  readonly requires: readonly string[];
  readonly defs: readonly CdmJsonNode[];
  readonly content: readonly CdmJsonNode[];
  readonly openStart: number;
  readonly openEnd: number;
}
