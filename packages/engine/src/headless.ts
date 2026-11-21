/**
 * `@docedit/engine/headless`: the editing core without a view (02 §14; FE-121). Nothing reachable
 * from here imports `prosemirror-view` or touches the DOM, so it runs in Node.js and in workers; a
 * test walks its imports to keep it so.
 */
export {
  CDM_VERSION,
  DocumentCore,
  ENGINE,
  UnsupportedDocumentError,
  capabilities,
  readEnvelope,
  type CoreConfig,
  type ViewBridge,
} from './core.ts';
export type * from './api.ts';
export {
  VersionDocument,
  openVersion,
  refusalOf,
  versionCoreConfig,
  type VersionCoreOptions,
  type VersionInput,
  type VersionOpen,
  type VersionOpener,
  type VersionRefusal,
} from './version-view.ts';
export {
  comparisonSpecs,
  type ComparisonChange,
  type ComparisonSpec,
} from './comparison-markup.ts';
export {
  ReadValue,
  ViewHub,
  nextFrame,
  sameJson,
  type ReadView,
  type Schedule,
} from './read-value.ts';
export { editingSchema, holdsPlaceholder, PLACEHOLDER } from './schema.ts';
export { canWrite, capsOf, checkChange, depScope, guardPlugin, type Refusal } from './guard.ts';
export { identifierPlugin, fillIdentifiers, idTypesOf } from './ids.ts';
export { INTERNAL, REMOTE } from './meta.ts';
export {
  PartNotLoadedError,
  loadParts,
  partsFor,
  type PartName,
  type PartsInput,
} from './parts.ts';
export {
  BodySelection,
  bodyGuard,
  bodyRange,
  initialSelection,
  moveToBodyEdge,
  selectAllInBody,
  stopAtBodyEdge,
} from './body.ts';
export {
  clampToRegion,
  regionAt,
  regionClamp,
  regionParagraphs,
  stopAtRegionEdge,
  withParagraphsAfterRegions,
} from './regions.ts';
export {
  currentStyle,
  enterWithNextStyle,
  outlineOf,
  paragraphStyles,
  setParagraphStyle,
} from './styles.ts';
export { coreKeys, press } from './keys.ts';
export {
  insertTable,
  isRegular,
  locateCell,
  MAX_TABLE_COLUMNS,
  moveToCell,
  tableCommand,
  tableTransaction,
  type TableOp,
} from './table.ts';
export { insertFootnote, insertLineBreak, oneParagraphLimit } from './footnote.ts';
export { listSemantics, type ListItemSemantics, type ListParagraph } from './list-semantics.ts';
export {
  CITATION_MODES,
  MAX_CITATION_ITEMS,
  insertCitation,
  sourceIdsOf,
  type CitationItemInput,
  type CitationMode,
  type CitationRefusal,
  type CitationResult,
} from './citation-insert.ts';
export {
  SOURCE_FIELDS,
  sourceProblems,
  type SourceCitedAt,
  type SourceEdit,
  type SourceEditOutcome,
  type SourceField,
  type SourceInfo,
  type SourceProblem,
  type SourceValues,
} from './source-edit.ts';
export {
  BOOKMARK_NAME_PATTERN,
  MAX_HREF_LENGTH,
  addLink,
  bookmarkPositions,
  followInternalLink,
  insertBookmark,
  linkRefusalOf,
  type BookmarkRefusal,
  type FollowResult,
  type LinkRefusal,
} from './links-bookmarks.ts';
export {
  PAGE_NUMBER_FORMATS,
  PAPER_SIZES,
  invalidField,
  pageSetupPos,
  setPageSetup,
  type PageSetupChanges,
  type PageSetupRefusal,
  type PaperSize,
} from './page-setup-commands.ts';
export { insertBreak, insertSectionBreak, sectionWarnings } from './breaks-sections.ts';
export { insertField, insertSymbol, insertToc } from './fields-toc.ts';
export {
  insertCaption,
  insertCaptionHere,
  insertEquationCaption,
  insertReference,
  insertTableCaption,
} from './captions-refs.ts';
export { referenceTargets } from './reference-targets.ts';
export type { ReferenceTarget, ReferenceTargetKind } from './reference-targets.ts';
export { insertEquation, latexRefusal, setEquationLatex } from './equation-commands.ts';
export { pasteImage, type AssetsPort, type PastedImage } from './image-paste.ts';
export { rebuildTransaction } from './remote.ts';
export * as sync from './sync/state.ts';
export {
  type RestorePlan,
  discardForeignWork,
  readRestorePlan,
  restoreBase,
} from './sync/restore.ts';
export {
  SyncSession,
  commitId,
  type Clock,
  type SyncEvent,
  type SyncHost,
} from './sync/session.ts';
export { covered, lacksGlyph, missingGlyphs } from './glyph-check.ts';
export type { GlyphCoverage, GlyphNotice, GlyphRange, MissingGlyph } from './glyph-check.ts';
