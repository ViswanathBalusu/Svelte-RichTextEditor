/**
 * `@docedit/model`: the Canonical Document Model without ProseMirror (03 §1 principle 2; CDM-006).
 *
 * - Generated document types (src/generated/types.ts).
 * - The cross-cutting conventions of 01 §8 (FND-003): identifiers, time, lengths, values, errors.
 * - RFC 8785 serialisation and SHA-256 (FND-005), and the CDM canonical form built on them (03 §2).
 * - Paragraph style resolution: default style, `basedOn` inheritance, outline levels (CDM-016).
 * - The layout semantics every writer shares (03 §6, §7; ADR 0032): the formatting cascade
 *   (CDM-041), labels (CDM-042), paragraph gaps and line heights (CDM-043), tab stops (CDM-044),
 *   header and footer growth (CDM-045), kept spaces and date fields. Fixtures for other engines
 *   are in `@docedit/model/fixtures/semantics/*.json`.
 *
 * The ProseMirror schema is in `@docedit/model/prosemirror`; validation and the reader that refuses
 * what it cannot understand (CDM-009) are in `@docedit/model/validate`.
 */
export type * from './generated/types.ts';

export * from './conventions/ids.ts';
export * from './conventions/time.ts';
export * from './conventions/units.ts';
export * from './conventions/validators.ts';
export * from './conventions/errors.ts';
export { randomBytes, sha256, utf8 } from './conventions/platform.ts';

export {
  styleTable,
  paragraphStyleOf,
  styleProperty,
  outlineLevelOf,
  styleChain,
  defaultSettings,
  type StyleTable,
  type DocumentSettings,
  type FootnoteFormat,
  type CascadeError,
  type CascadeErrorCode,
  type StyleChainResult,
  type TreeNode,
} from './cascade/styles.ts';
export {
  resolveParagraph,
  resolveRun,
  resolveLabelRun,
  paragraphNumbering,
  numberingLevel,
  sortTabs,
  BASE_PARAGRAPH,
  BASE_RUN,
  PARAGRAPH_PROPERTIES,
  RUN_PROPERTIES,
  type Alignment,
  type Borders,
  type CascadeResult,
  type Layer,
  type LineRule,
  type NumberingRef,
  type ParagraphContext,
  type ParagraphProperties,
  type ResolvedParagraph,
  type ResolvedRun,
  type RunProperties,
  type Shading,
  type TabAlignment,
  type TabLeader,
  type TabStop,
} from './cascade/resolve.ts';
export {
  resolveTableFormat,
  type TableFormat,
  type TableFormatLayer,
} from './cascade/table-format.ts';
export {
  computeLabels,
  counterEffects,
  referenceText,
  fillTemplate,
  restarts,
  EQUATION_SEQUENCE,
  type CounterEffect,
  type DocumentLabels,
  type LabelOptions,
  type LevelEffect,
  type ListLabel,
  type SequenceLabel,
} from './numbering/labels.ts';
export {
  formatNumber,
  footnoteMark,
  DEFAULT_BULLET,
  FOOTNOTE_SYMBOLS,
  type NumberFormat,
} from './numbering/format.ts';
export { dateFieldText, DEFAULT_DATE_FORMAT, type DateFieldInput } from './numbering/dates.ts';
export { pageNumberOf, pageNumberText, type PageNumberFormat } from './numbering/page-numbers.ts';
export {
  paragraphGap,
  flowGaps,
  type FlowGap,
  type FlowGaps,
  type GapSide,
} from './spacing/gaps.ts';
export { lineHeight, type LineSpacing } from './spacing/lines.ts';
export {
  nextTabStop,
  placeTab,
  decimalIndex,
  type PlacedTab,
  type ResolvedTab,
  type TabContext,
  type TabSegment,
} from './spacing/tabs.ts';
export {
  bodyFrame,
  headerFor,
  footerFor,
  pageGeometry,
  type BodyFrame,
  type PageGeometry,
  type PageSlot,
} from './spacing/page.ts';
export { spaceRuns, type SpaceRun } from './spacing/whitespace.ts';

export { canonicalize, canonicalizeText, CanonicalizationError } from './canonical/jcs.ts';
export { sha256Hex, sha256HexBytes, jcsHash, toHex, SHA256_HEX_PATTERN } from './canonical/hash.ts';
export {
  CANONICAL_FORM_VERSION,
  canonicalEnvelope,
  canonicalNode,
  canonicalText,
  canonicalNodeText,
  documentHash,
  nodeHash,
} from './canonical/canonical-form.ts';
export type { JsonEnvelope, JsonMark, JsonNode } from './canonical/canonical-form.ts';
// Schema migrations (03 §11.3; CDM-049), for the authority service's migrate (PRO-107).
export {
  chainProblem,
  migrate,
  moveExtKey,
  type Migration,
  type MigrationCode,
  type MigrationResult,
} from './migrate/migrations.ts';

// Fields (12 §3; FRW-003): the type of a value for its kind (I15), without ProseMirror. The entry
// checks and presets of FRW-004 are the rules package's (`checkEntry` in @docedit/rules).
export {
  fieldValueProblem,
  isCalendarDate,
  valueBytes,
  type ValueOptions,
  type ValueProblem,
} from './fields/values.ts';

// Reading the structure of a document (CDM-016, CDM-023, CDM-026, CDM-035, CDM-040, CDM-051).
export { listInstances, type ListInstance } from './structure/lists.ts';
export {
  suggestionsOf,
  type Suggestion,
  type SuggestionKind,
  type SuggestionPart,
} from './structure/suggestions.ts';
export {
  mapPastedDefinitions,
  type PasteInput,
  type PasteOptions,
  type PasteResult,
} from './structure/paste.ts';
export {
  fieldText,
  valueText,
  type FieldAttrsForText,
  type FieldText,
  type FieldTextContext,
  type FormFieldValue,
} from './structure/field-text.ts';
export {
  preservedDigests,
  preservedPayloads,
  type PreservedPayload,
} from './structure/preserved.ts';
export {
  builtInStyleName,
  newDocument,
  type NewDocumentOptions,
} from './structure/new-document.ts';
