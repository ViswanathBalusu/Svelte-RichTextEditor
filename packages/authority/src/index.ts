/**
 * `@docedit/authority`: the authority as pure functions (SYN-001) and the room state machine.
 * Universal: no Node.js or browser APIs, so the same code runs in the room, the authority service,
 * the local backend and tests (01 §6).
 */
export * from './codes.ts';
// The entry checks of `@docedit/rules` (FRW-004), for a client that already depends on the
// authority: the editor shows the same verdict as the completion check (ADR 0030 §6).
export {
  checkEntry,
  fieldFrom,
  isEmptyValue,
  validateFields,
  type EntryProblem,
  type EntryProblemCode,
  type FieldInfo,
  type FieldReport,
} from '@docedit/rules';
export {
  ALLOWED_STEP_TYPES,
  parseSteps,
  stepsToJson,
  stepsEqual,
  commitBytes,
  expandMarkSets,
  type StepJson,
} from './steps.ts';
export { rebaseOver, applySteps, mapsOf, inverseMapsOf, type Rebased } from './rebase.ts';
export { mapRanges, mapRangesThrough, type Range, type MappedRange } from './ranges.ts';
export { checkInvariants, type InvariantContext, type InvariantOutcome } from './invariants.ts';

export * from './permissions/model.ts';
export {
  AUDITED_REJECTION_CODES,
  rejectionAudit,
  type AuditEntry,
  type AuditedRejectionCode,
  type RejectionAuditInput,
} from './permissions/audit.ts';
export {
  CONTROL_AUDIT_KEYS,
  CONTROL_AUDIT_KINDS,
  controlAudit,
  type ControlAuditEntry,
  type ControlAuditInput,
  type ControlAuditKind,
} from './permissions/control-audit.ts';
export {
  computeAccess,
  canSubmitAnything,
  fillSummary,
  holdsSomewhere,
  nextExpiry,
  sameAccess,
  type Access,
  type RegionInfo,
} from './permissions/access.ts';
export {
  diffScopes,
  eqIgnoringFieldValues,
  deepEqual,
  partitionScopes,
  type ScopeDiff,
  type ScopePartition,
  type FieldChange,
  type FieldNodes,
} from './permissions/scopes.ts';
export {
  outcomeCheck,
  definitionUse,
  SERVER_ONLY_KINDS,
  type OutcomeInput,
  type OutcomeVerdict,
} from './permissions/outcome.ts';
export {
  NO_RULES,
  type FillContext,
  type FillRule,
  type OutcomeRules,
  type RuleVerdict,
  type SuggestRule,
  type SuggestionVerdict,
} from './permissions/registry.ts';
export { STANDARD_RULES } from './permissions/standard.ts';
export { FILL_RULE, checkFill } from './permissions/fill.ts';
export {
  IMPORT_LABEL_PREFIXES,
  SUGGESTION_RULE,
  baselineText,
  checkSuggestion,
  isImportLabel,
  isSuggestionMark,
  ownSuggestions,
  sameBaseline,
  type Counter,
  type Rejects,
  type SuggestionContext,
  type ScopeContent,
} from './permissions/suggestions.ts';
export {
  suggestionIdentity,
  type IdentityInput,
  type IdentityVerdict,
} from './permissions/identity.ts';
export {
  authoriseComment,
  authoriseThread,
  capsInScope,
  type ThreadAction,
  type ThreadContext,
  type ThreadDecision,
} from './permissions/comments.ts';
export {
  LEASE_DEFAULTS,
  acquireLease,
  endLease,
  renewLease,
  type AcquireRequest,
  type EndRequest,
  type HeartbeatRequest,
  type LeaseEnd,
  type LeaseOptions,
  type LeaseVerdict,
} from './permissions/leases.ts';
export {
  approvalHash,
  regionCanonicalText,
  setRegionState,
  type StateChange,
  type StateVerdict,
} from './permissions/states.ts';
export {
  checkApprovalHash,
  checkApprovals,
  verifyRoomApprovals,
  type ApprovalHashCheck,
  type ApprovalMismatch,
  type ApprovalSource,
} from './permissions/approval-check.ts';
export { planRestoreDefinitions, type DefinitionPlan } from './permissions/restore.ts';
export { PermissionIndex, type FieldEntry, type RegionEntry } from './permissions/indexes.ts';
export { regionBoundaryViolation, type BoundaryViolation } from './permissions/boundaries.ts';
export {
  canReadValue,
  hiddenSet,
  hiddenSetOf,
  regionInfos,
  visibility,
  type VisibilityOptions,
} from './permissions/visibility.ts';
export {
  MATRIX,
  UNMATRIXED_ROUTES,
  authorise,
  type MatrixContext,
  type MatrixRow,
  type MatrixVerdict,
  type Requirement,
  type RouteClassification,
} from './permissions/matrix.ts';

export {
  DEFAULT_THREAD_LIMIT,
  Room,
  regionsOf,
  controlCommitId,
  type RoomInit,
  type AuthoredRequest,
  type SnapshotRequest,
  type Preconditions,
  type Requester,
  type ThreadOutcome,
  type ThreadRefusalCode,
  type ThreadRequest,
} from './room/room.ts';
export * from './room/types.ts';
export {
  cloneAnchor,
  findBlock,
  mapThread,
  rangeScopes,
  threadScopes,
  type ThreadAnchor,
  type ThreadState,
  type ThreadTarget,
} from './room/threads.ts';
export { featuresUsed } from './room/features.ts';
export {
  DEFAULT_HISTORY_VISIBILITY,
  HISTORY_VISIBILITIES,
  editsSomewhere,
  minVisibleSeq,
  minVisibleSeqAsync,
  rangeVisible,
  stateVisible,
  type GateInput,
  type HistoryVisibility,
} from './room/gate.ts';
export {
  Admission,
  TokenBucket,
  defaultCost,
  type AdmissionConfig,
  type BucketConfig,
  type Budget,
  type CostInput,
} from './room/admission.ts';
export {
  ContentCache,
  contentAt,
  contentEtag,
  defaultReplayers,
  pmStepsReplayer,
  replayerKey,
  type Checkpoint,
  type ContentGate,
  type ContentResult,
  type ContentSource,
  type Replayer,
} from './room/content.ts';
export {
  EngineRegistry,
  PM_STEPS_1,
  engineContractFailures,
  isRefusal,
  type Attribution,
  type EngineDefinition,
  type PayloadKind,
  type Refusal,
} from './room/engine.ts';
// SYN-046 criterion 4: the engine of a channel, decided against the session's negotiated list.
export {
  negotiatedEngine,
  openNegotiatedChannel,
  type ChannelEngineRequest,
  type ChannelEngineResult,
  type EngineDecision,
} from './room/channel-engine.ts';
export {
  FOLLOWER_REFUSAL,
  Follower,
  type FollowerInit,
  type FollowerViewer,
} from './room/follower.ts';
// Relay mode (04 §14; SYN-044): what a DEP transport without the document model runs.
export {
  RELAY_EXCLUDED_FEATURES,
  RELAY_MODE,
  Relay,
  relayCapabilities,
  relayFeatureAvailable,
  type RelayCapabilities,
  type RelayFeature,
  type RelayInit,
  type RelayOut,
  type RelayStore,
} from './room/relay.ts';

// Webhook bodies for permission events and the throttle of rejections (05 §7; PRM-053). The host
// raises and delivers them (BE-055).
export {
  EVENT_DATA_KEYS,
  PERMISSION_EVENT_TYPES,
  REJECTION_CODES,
  carriesNoContent,
  commitRejectedEvent,
  createThrottle,
  grantsChangedEvent,
  regionStateChangedEvent,
  type CloudEvent,
  type EventEnvelope,
  type PermissionEventType,
  type RejectionCode,
  type Throttle,
  type ThrottleOptions,
} from './permissions/events.ts';

// Workflow finalisation and visible signature appearances (12 §6.2, §12; FRW-049, FRW-057). The
// workflow and signing services act on the results (`raised`, the planned appearances).
export {
  finaliseWorkflow,
  type CompileResult,
  type FailureCode,
  type FinalisationFailure,
  type FinalisationInput,
  type FinalisationOutcome,
  type FinalisationStage,
  type SealResult,
  type StoreResult,
} from './workflow/finalisation.ts';
export {
  planAppearances,
  validateLayout,
  type AppearanceDiagnostic,
  type AppearanceKind,
  type AppearancePlan,
  type AppearancePlanned,
  type AppearanceTarget,
  type LayoutCheck,
  type LayoutEntry,
  type LayoutProblem,
  type PageBounds,
  type Rect,
} from './workflow/appearance.ts';
// Time-stamp renewal of a sealed workflow (FRW-056 criteria 2 and 5; lane V-FRW-055-072).
export {
  applyRenewalResult,
  planRenewal,
  type RenewalApplication,
  type RenewalPlan,
  type RenewalResult,
  type RenewalState,
} from './workflow/renewal.ts';
// Workflow evidence, capture, consent, completion, retention and the signature provider adapter
// (FRW-041 to FRW-059). Exported so the workflow and signing services can act on them.
export {
  DEFAULT_CAPTURE_SETTINGS,
  captureChangeAudit,
  captureEvidence,
  settingsAt,
  type CaptureChange,
  type CaptureChangeAudit,
  type CaptureSettings,
  type CapturedEvidence,
  type EvidenceFacts,
} from './workflow/capture.ts';
export {
  COMPLETION_RULE_BUDGET,
  completionCheck,
  hiddenValuesToClear,
  type CompletionProblem,
  type CompletionVerdict,
} from './workflow/completion.ts';
export {
  checkConsentForSign,
  consentTextHash,
  recordConsent,
  type ConsentRecord,
  type ConsentText,
  type ConsentTextRef,
  type ConsentVerdict,
} from './workflow/consent.ts';
export {
  SALT_BYTES,
  commitEvidence,
  controlCommitEvidence,
  newEvidenceSalt,
  verifyEvidence,
  type EvidenceCommitPayload,
} from './workflow/evidence.ts';
export {
  planPurge,
  type EvidenceRow,
  type PurgeAudit,
  type PurgeInput,
  type PurgePlan,
} from './workflow/retention.ts';
export {
  runEvidencePurge,
  type EvidenceRowStore,
  type PurgeAuditSink,
  type PurgeJobInput,
  type PurgeJobResult,
} from './workflow/evidence-purge-job.ts';
export {
  sealWithProvider,
  sealWorkflow,
  type AssertedFacts,
  type Embed,
  type ProviderFailure,
  type ProviderRequest,
  type ProviderResult,
  type ProviderSealOutcome,
  type SignatureProvider,
} from './workflow/provider.ts';
export {
  AUTHENTICATION_PHRASE,
  NATIVE_SIGNING_DESCRIPTION,
  OVERCLAIM_PHRASES,
  findOverclaims,
  isWithinLegalStance,
} from './workflow/language.ts';
export {
  BUNDLE_INSTRUCTIONS,
  buildBundle,
  instructionsWithinStance,
  verifyBundle,
  type BundleItem,
  type BundleVerdict,
  type EvidenceBundleFile,
  type ItemProblem,
  type ItemVerdict,
} from './workflow/bundle.ts';
// The workflow lock, the webhook event data and the participant binding (FRW-029, FRW-036,
// FRW-038). Exported for the workflow service (FRW-030), which is not built yet: nothing raises,
// signs or delivers these events today.
export { lockFor, type WorkflowLock } from './workflow/lock.ts';
// The send transition, the order of activation and the refusals' registry codes (FRW-027, FRW-030),
// for the document service's workflow routes.
export {
  sendChecklist,
  sendWorkflow,
  type SendProblem,
  type SendResult,
  type SentHead,
} from './workflow/send.ts';
export { activeParticipantIds } from './workflow/order.ts';
export {
  sendProblem,
  transitionProblem,
  WORKFLOW_PROBLEM_STATUS,
  type ChecklistFailure,
  type WorkflowProblem,
  type WorkflowProblemCode,
} from './workflow/problems.ts';
export type {
  Caller as WorkflowCaller,
  WorkflowParticipant,
  WorkflowRecord,
  WorkflowStateName,
} from './workflow/lifecycle.ts';
export {
  WORKFLOW_EVENTS,
  WORKFLOW_EVENT_PREFIX,
  workflowEvent,
  type WorkflowEvent,
  type WorkflowEventContext,
  type WorkflowEventData,
  type WorkflowEventName,
} from './workflow/events.ts';
export {
  bindParticipant,
  tokenMayFill,
  type Binding,
  type ParticipantClaims,
} from './workflow/binding.ts';
// The participant list of the workflow resource (FRW-025, FRW-026; lane V-FRW-019-036). Exported so
// that the workflow store refuses a list that is not valid before it is written.
export {
  checkParticipants,
  PARTICIPANT_KINDS,
  type ParticipantCheck,
  type ParticipantDraft,
  type ParticipantProblem,
  type ParticipantProblemReason,
} from './workflow/resource.ts';
// The body of `PUT /documents/{id}/workflow` (FRW-025).
export {
  checkWorkflowBody,
  DEFAULT_TIME_ZONE,
  SERVER_OWNED_MEMBERS,
  type WorkflowBodyCheck,
  type WorkflowBodyProblem,
  type WorkflowInput,
  type WorkflowMembers,
} from './workflow/workflow-body.ts';

// Read restrictions by projection (ADR 0019, proposed; spike S12).
export {
  NOTHING_HIDDEN,
  REDACTED,
  diffStep,
  fullToProj,
  hidesNothing,
  project,
  projectCommit,
  projToFull,
  projectionSchema,
  toFullSteps,
  visibilityKey,
  type HiddenSet,
  type ProjectedCommit,
  type Projection,
  type Span,
  type StepRoute,
} from './projection/projection.ts';
export { projectCommitPage, visibleScopes } from './projection/page.ts';
export {
  ProjectionGateway,
  viewToken,
  type GatewayStats,
  type Visibility,
} from './projection/gateway.ts';
