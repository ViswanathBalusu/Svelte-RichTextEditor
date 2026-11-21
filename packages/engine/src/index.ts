/**
 * `@docedit/engine`: the editing core (02 §5) with its web view. The element and the shell use
 * `EditorCore`; the shell sees only the `CoreApi` part of it (packages/ui/src/core-api.ts).
 *
 * - `EditorCore`: the document API (FE-026), the read views (FE-023, FE-024), the sync client
 *   hosted in the core (FE-033; SYN-017 to SYN-020), and the body view and sub-editors.
 * - `@docedit/engine/headless`: the same core without the view, for Node.js and workers (FE-121).
 * - `@docedit/engine/testing`: instrumentation for tests and the spike pages; not product API.
 */
export { EditorCore } from './view/web.ts';
export {
  CDM_VERSION,
  DocumentCore,
  ENGINE,
  UnsupportedDocumentError,
  capabilities,
  type CoreConfig,
  type TransactionInfo,
} from './core.ts';
export { REMOTE } from './meta.ts';
export { ATOM_CHAR } from './page-input.ts';
export type { BlockPoint, BlockSelection, PageViewHandle, PageViewHooks } from './page-input.ts';
export type {
  PageColumnInfo,
  ParagraphFormatInfo,
  TabAlign,
  TabLeader,
  TabStopInfo,
} from './paragraph-format-info.ts';
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
export { VersionView, makeWebVersion } from './view/version-web.ts';
export {
  comparisonSpecs,
  type ComparisonChange,
  type ComparisonSpec,
} from './comparison-markup.ts';
export type {
  AccessLimit,
  AccessSummary,
  AttachOptions,
  AuthoringCommandName,
  Capability,
  CellRectArgs,
  CdmEnvelope,
  CdmFragment,
  CdmJsonNode,
  CitationItemArgs,
  CommandArgs,
  CommandName,
  CommandState,
  CommandUnavailable,
  ConnectionState,
  CoreLabels,
  CoreProblem,
  CoreQueryName,
  DocumentApi,
  EditMode,
  EquationConfirmation,
  AssistantInsertOutcome,
  FieldFillOutcome,
  FieldsApi,
  EquationRequest,
  SignFieldRequest,
  EquationTarget,
  FieldArgs,
  FindResult,
  FindState,
  InsertResult,
  ModeState,
  PageSetupArgs,
  ReplaceNotice,
  ReplaceReport,
  StatusSummary,
  OutlineItem,
  PanelInfo,
  PeerCaretInfo,
  PeerSelectionInfo,
  PresencePeerInfo,
  PresencePortLike,
  RecoveredEdits,
  ShellCounts,
  RecoveredItem,
  RefusalNotice,
  RefusalReason,
  SaveState,
  SelectionScope,
  SelectionSummary,
  StyleInfo,
  SuggestionModeInfo,
  SyncSnapshot,
  SyncSummary,
} from './api.ts';
export type { StoryPart, StoryVariant, StoryVariantInfo } from './header-footer.ts';
export type {
  AssetsPort,
  ImagePasteResult,
  PastedImage,
  StoredImage,
  UploadOutcome,
} from './image-paste.ts';
export type { AltRequest } from './alt-text.ts';
export type { GlyphCoverage, GlyphNotice, GlyphRange, MissingGlyph } from './glyph-check.ts';
export type { ClipboardInput } from './clipboard.ts';
export { ReadValue, ViewHub, type ReadView, type Schedule } from './read-value.ts';
export { editingSchema, definitionFor, headingLevel, type FootnoteModel } from './schema.ts';
export type { SelectionShim } from './view-support.ts';
export { imageSource, RASTER_IMAGE_TYPES } from './image-source.ts';
export type { AssetImage, AssetImageLookup } from './image-source.ts';
export type { EquationDrawer } from './equation-draw.ts';
export type { Clock, ConnectionStatus } from './sync/session.ts';
export type { Discarded } from './sync/state.ts';
export {
  type JournalContents,
  type JournalEntry,
  type JournalPort,
  type QueueAt,
  memoryJournal,
} from './sync/journal.ts';
export { type RestorePlan, readRestorePlan, restoreBase } from './sync/restore.ts';
export type {
  LocatedFinding,
  ProofingClock,
  ProofingFindingInfo,
  ProofingPort,
  ProofingInfo,
  ProofingState,
} from './proofing.ts';
export type {
  AssistantRequest,
  AssistantRequestContext,
  AttachmentOut,
  HostAttachment,
} from './assistant-context.ts';
