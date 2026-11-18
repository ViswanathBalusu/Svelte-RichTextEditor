/**
 * `@docedit/history`: the history algorithms of 08 as pure functions (ADR 0051, proposed), for the
 * document service, a local backend and tests. Universal: no Node.js or browser APIs, so the same
 * code runs in a room host's worker thread, in a browser and in tests (01 §6).
 *
 * - Comparisons (08 §6; HIS-011, HIS-012): from the recorded steps or by aligning blocks, on the
 *   requester's projection, behind the visibility gate, cached per visibility class.
 * - The attribution map (08 §7; HIS-014, HIS-017) and its per-block variant (HIS-044).
 * - The history list grouped by day and editing session (08 §4; HIS-008).
 * - Restore plans and their dry runs (08 §8; HIS-018 to HIS-021).
 * - Verification of a log and its hash chain (08 §12; HIS-033); the command-line tool is
 *   `scripts/verify-log.ts` (`docedit-verify-log`).
 * - The audit export of a log segment and its verification alone (08 §12; HIS-037), for the
 *   document service's audit route and the same command-line tool.
 * - History as the requester's projection (ADR 0019; HIS-046).
 * - Payload thinning after the tenant's chosen period, keeping the chain and the stored versions
 *   that must stay rebuildable (08 §11; HIS-032).
 */
export * from './types.ts';
export {
  AttributionMap,
  CHUNK,
  HIDDEN_AUTHOR,
  applyCommit,
  attributionAt,
  authorLabel,
  authorOf,
  commitAuthor,
  coversExactly,
  projectAttribution,
  sameAuthor,
  type AttributionJson,
  type AttributionResult,
  type AttributionSource,
  type AuthorLabel,
  type RestoreHint,
  type Run,
} from './attribution.ts';
export { BlockAttribution } from './per-block.ts';
export {
  PLACEHOLDER,
  definitionKey,
  indexDocument,
  stableJson,
  tokenize,
  type BlockEntry,
  type DefinitionEntry,
  type DocIndex,
  type FieldEntry,
  type Granularity,
  type Token,
} from './blocks.ts';
export { DEFAULT_MAX_COST, diffTokens, type Edit } from './diff.ts';
export {
  ComparisonCache,
  STEP_LIMIT,
  compare,
  compareStates,
  compareSteps,
  summarise,
  type Change,
  type ChangeKind,
  type CompareContext,
  type CompareRequest,
  type CompareSource,
  type Comparison,
  type ComparisonMethod,
  type DiffSpan,
  type RegionSummary,
  type StatesComparisonInput,
  type StepsComparisonInput,
} from './compare.ts';
export {
  DEFAULT_IDLE_GAP_MS,
  DEFAULT_LIMIT,
  EDITING_ORIGINS,
  MAX_LIMIT,
  byDay,
  dayOf,
  groupCommits,
  listHistory,
  originClass,
  scoped,
  type AuthorRef,
  type GroupOptions,
  type HistoryFilter,
  type HistoryGroup,
  type HistoryItem,
  type HistoryListInput,
  type HistoryPage,
  type VersionItem,
} from './groups.ts';
export {
  createVersion,
  isVersionKind,
  type VersionCreation,
  type VersionRequest,
  type VersionRules,
} from './versions.ts';
export { advanceMarker, type MarkerAdvance } from './markers.ts';
export {
  DAY_MS,
  KEEP_ALL_MS,
  WEEK_MS,
  thinningPlan,
  type CheckpointRecord,
  type ThinningPlan,
  type ThinningPolicy,
} from './thinning.ts';
export { shownAuthor, type ShownAuthor, type UnknownAuthorLabel } from './erasure.ts';
export {
  decideErasure,
  releaseDeferred,
  type DeferredRun,
  type ErasureAudit,
  type ErasureDecision,
  type ErasureRequest,
  type PendingErasure,
} from './erasure-hold.ts';
export {
  derivedId,
  markRestored,
  planRestore,
  type RestoreContext,
  type RestoreNotes,
  type RestorePlan,
  type RestoreRequest,
} from './restore.ts';
export {
  BUNDLE_FORMAT,
  EXIT,
  chainHash,
  payloadDigest,
  verifyBundle,
  type Anchor,
  type BundleCheckpoint,
  type BundleCommit,
  type ChainMetadata,
  type CheckKind,
  type LogBundle,
  type Problem,
  type VerifyOptions,
  type VerifyReport,
  type VerifyStatus,
} from './chain.ts';
export * from './audit-segment.ts';
export * from './workflow-evidence-bundle.ts';
export {
  activitySince,
  attributionFor,
  fieldHistory,
  forkContent,
  hiddenAcross,
  unionHidden,
  versionFor,
  type Activity,
  type ActivityInput,
  type AttributionQuery,
  type AttributionSpanOut,
  type FieldHistoryEntry,
} from './reader.ts';
export { NO_HOLD, applyHold, type HoldAudit, type HoldChange, type HoldState } from './hold.ts';
export {
  payloadOf,
  tombstone,
  type TombstoneAudit,
  type TombstoneCopies,
  type TombstoneRequest,
  type TombstoneResult,
} from './tombstone.ts';
export {
  purgePlan,
  type PurgeAsset,
  type PurgeOutcome,
  type PurgePlan,
  type PurgeRequest,
} from './purge.ts';
export {
  PINNED_VERSION_KINDS,
  payloadRecordsOf,
  payloadThinningPlan,
  thinBundle,
  type PayloadRecord,
  type PayloadThinningPlan,
  type PayloadThinningPolicy,
  type PinnedVersion,
} from './payload-thinning.ts';
export {
  introducedBy,
  suggestionDate,
  suggestionIndex,
  type SuggestionDate,
  type SuggestionIndex,
  type SuggestionIntroduction,
} from './suggestions.ts';
export {
  COLD_AFTER_MS,
  PAYLOAD_SEGMENT_FORMAT,
  coldMovePlan,
  moveSegment,
  readPayloads,
  segmentPath,
  segmentText,
  type ColdCandidate,
  type ColdIo,
  type ColdMoveResult,
  type ColdPlan,
  type ColdPlanSegment,
  type ColdPolicy,
  type ColdRead,
  type ColdReadInput,
  type ColdStatus,
  type HotPayloads,
  type SegmentCodec,
  type SegmentIndex,
  type SegmentObjects,
  type SegmentRef,
} from './cold-segments.ts';
