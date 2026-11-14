/**
 * The stable violation codes of `model.validate()` (CDM-013). A code names one kind of violation
 * and never changes its meaning; a new kind gets a new code. Every code belongs to one invariant
 * of 03 §8 or 12 §3.6. Registered checks declare their own codes, which must not reuse these.
 * Published as spec/cdm/cdm-1.violations.json for other implementations and the conformance kit.
 */
import type { CodeDoc } from './types.ts';

export const VIOLATION_CODES = {
  // I1: valid against the schema of the `cdm` version and the `requires` list.
  not_an_object: { invariant: 'I1', doc: 'The document, or a node, is not a JSON object.' },
  envelope_member: {
    invariant: 'I1',
    doc: 'The envelope has a member other than `cdm`, `requires` and `doc`; metadata belongs to the document resource.',
  },
  cdm_version: { invariant: 'I1', doc: '`cdm` is not the major version of this definition.' },
  requires_invalid: {
    invariant: 'I1',
    doc: '`requires` is not an array, names an unknown feature, or names one twice.',
  },
  top_node: { invariant: 'I1', doc: '`doc` is not a node of the top type.' },
  unknown_node_type: { invariant: 'I1', doc: 'A node type the definition does not have.' },
  projection_only_node: {
    invariant: 'I1',
    doc: 'A node that exists only in projections (ADR 0019), such as `hidden_region`.',
  },
  redaction_marker: {
    invariant: 'I1',
    doc: 'The redaction marker of projections (ADR 0019) in a stored value.',
  },
  unknown_member: { invariant: 'I1', doc: 'A node or mark member other than its own.' },
  unknown_attribute: { invariant: 'I1', doc: 'An attribute the node or mark does not declare.' },
  unknown_mark_type: { invariant: 'I1', doc: 'A mark type the definition does not have.' },
  feature_missing: {
    invariant: 'I1',
    doc: 'A node, mark, attribute or value of a feature that `requires` does not list.',
  },
  empty_text: { invariant: 'I1', doc: 'A text node without text.' },
  malformed: {
    invariant: 'I1',
    doc: 'A member of the wrong JSON type: `attrs` not an object, `content` or `marks` not an array, a child that is no node.',
  },
  content_on_leaf: { invariant: 'I1', doc: 'Content on a node type that has none.' },
  node_mark_host: {
    invariant: 'I1',
    doc: 'A node mark on a node other than a paragraph, a table row or a table, or a node mark that is not a suggestion mark.',
  },
  footnote_paragraphs: {
    invariant: 'I1',
    doc: 'A footnote with more than one paragraph; version 1 allows one (CDM-001).',
  },
  schema_content: {
    invariant: 'I1',
    doc: 'The ProseMirror schema refuses the content: an order or a count its content expression does not allow.',
  },
  not_canonicalisable: { invariant: 'I1', doc: 'The document has no canonical form (03 §2).' },
  check_failed: {
    invariant: 'I1',
    doc: 'A registered invariant check threw or reported a code it did not declare; the document is refused unchecked.',
  },
  // I2: identifiers.
  missing_id: { invariant: 'I2', doc: 'A node type that declares an `id` has none.' },
  duplicate_id: { invariant: 'I2', doc: 'Two nodes share an identifier.' },
  id_changed: { invariant: 'I2', doc: 'The commit changed a non-null identifier.' },
  suggestion_user: {
    invariant: 'I2',
    doc: 'One suggestion identifier with two users; an identifier belongs to the user who first used it (03 §5).',
  },
  // I3: placement of regions and section breaks.
  misplaced_container: {
    invariant: 'I3',
    doc: 'A region or a section break that is not a direct child of the body.',
  },
  nested_region: { invariant: 'I3', doc: 'A region inside a region.' },
  region_id_reused: { invariant: 'I3', doc: 'A region identifier that was removed earlier.' },
  // I4: references.
  unresolved_reference: {
    invariant: 'I4',
    doc: 'A reference to a definition that does not exist.',
  },
  wrong_reference_kind: {
    invariant: 'I4',
    doc: 'A reference to a definition of the wrong kind, such as a character style as a paragraph style.',
  },
  numbering_level_missing: {
    invariant: 'I4',
    doc: 'A numbering level that the numbering definition does not have.',
  },
  asset_not_attached: { invariant: 'I4', doc: 'An asset that is not attached to the document.' },
  field_target_unresolved: {
    invariant: 'I4',
    doc: 'A field target that names nothing, or not something a reference can target.',
  },
  duplicate_target_name: {
    invariant: 'I4',
    doc: 'A bookmark name or an equation label used twice, which makes references to it ambiguous.',
  },
  // I5: style chains.
  style_chain_cycle: { invariant: 'I5', doc: 'A `basedOn` chain with a cycle.' },
  style_chain_too_deep: { invariant: 'I5', doc: 'A `basedOn` chain of more than ten styles.' },
  // I6: table geometry.
  row_columns: {
    invariant: 'I6',
    doc: 'A table row whose spans, with the columns covered from rows above, do not cover the grid exactly.',
  },
  row_span_past_end: { invariant: 'I6', doc: 'A row span that runs past the last row.' },
  header_rows: { invariant: 'I6', doc: '`headerRows` larger than the number of rows.' },
  // I7: limits.
  nesting_too_deep: { invariant: 'I7', doc: 'Nesting deeper than 12.' },
  too_many_regions: { invariant: 'I7', doc: 'More than 500 regions.' },
  canonical_too_large: { invariant: 'I7', doc: 'A canonical size above 16 MiB.' },
  limit_exceeded: {
    invariant: 'I7',
    doc: 'A `latex` attribute longer than 4,000 characters, or a table grid of more than 63 columns.',
  },
  // I8: the math gate.
  math_refused: { invariant: 'I8', doc: 'The math gate of 09 refused a `latex` value.' },
  // I9: link schemes.
  link_scheme: {
    invariant: 'I9',
    doc: 'A link whose `href` is not http, https, mailto or an in-document target.',
  },
  // I10: forbidden combinations.
  footnote_in_footnote: { invariant: 'I10', doc: 'A footnote inside a footnote.' },
  footnote_in_caption: { invariant: 'I10', doc: 'A footnote inside a caption.' },
  table_in_story_or_footnote: { invariant: 'I10', doc: 'A table inside a story or a footnote.' },
  float_in_cell: { invariant: 'I10', doc: 'A figure with `placement: float` inside a table cell.' },
  break_in_container: {
    invariant: 'I10',
    doc: 'A page or column break inside a table cell, a caption or a footnote.',
  },
  form_field_placement: {
    invariant: 'I10',
    doc: 'A form field inside a header, a footer or a footnote (12 §3.2).',
  },
  // I11: attribute grammars.
  attribute_invalid: {
    invariant: 'I11',
    doc: 'An attribute value outside its grammar: type, range, length, pattern or size.',
  },
  attribute_missing: { invariant: 'I11', doc: 'A required attribute is null or absent.' },
  reserved_style_id: {
    invariant: 'I11',
    doc: 'A built-in style identifier used by another style, or `builtIn` on a style without one.',
  },
  table_property: {
    invariant: 'I11',
    doc: 'A table property (`cellMargins`, `headerRowShading`, `bandedRows`, inside borders) on a style that is not a table style.',
  },
  toc_levels: { invariant: 'I11', doc: 'A table of contents whose `minLevel` exceeds `maxLevel`.' },
  field_target_form: {
    invariant: 'I11',
    doc: 'A field target not in the form its kind needs, a missing target where the kind needs one, or a target or sequence name on a kind that takes none.',
  },
  preserved_without_payload: {
    invariant: 'I11',
    doc: 'Preserved inline content with neither its fragment asset nor the tree of a small marker.',
  },
  fmt_before: {
    invariant: 'I11',
    doc: 'A `fmt` suggestion whose `before` is not the shape of CDM-002, or names attributes a block suggestion cannot change.',
  },
  // I12: extensions.
  extension_envelope: {
    invariant: 'I12',
    doc: 'An extension node whose name, payload or fallback is outside its grammar, or whose payload is above its limit.',
  },
  extension_fallback: {
    invariant: 'I12',
    doc: 'An extension node without the fallback it needs: a picture or a text for a block, a text for an inline.',
  },
} as const satisfies Record<string, CodeDoc>;

export type BuiltInCode = keyof typeof VIOLATION_CODES;
