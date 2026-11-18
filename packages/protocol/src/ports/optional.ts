/**
 * The optional backend ports (05 §8.3; PRO-092). Each member names the message or resource it maps
 * to; request and response types come from the generated operation map, so they match the OpenAPI
 * document. Where the resource itself is a placeholder (decision D26), so is the port type.
 */
import type * as W from '../generated/types.ts';
import type { Body, CancelSignal, Page, Query, Response, Tagged, Unsubscribe } from './types.ts';

/** Presence (05 §5.4; 04 §11). Feature `presence`. */
export interface PresencePort {
  /** `presence.update`: positions refer to the confirmed document at `seq`. Rate-limited to `limits.presenceHz`. */
  update(docId: string, update: W.PresenceUpdate): void;
  /** `presence.state`: peers with server-derived identity, and sessions that left. */
  onPeers(docId: string, cb: (state: W.PresencePeers) => void): Unsubscribe;
}

/** History, versions, comparison, attribution, restore and read markers (05 §6.2; 08). Feature `history`. */
export interface HistoryPort {
  /** `GET /documents/{id}/history`. */
  history(docId: string, query?: Query<'listHistory'>): Promise<Response<'listHistory'>>;
  /** `GET /documents/{id}/versions`. */
  versions(docId: string, query?: Query<'listVersions'>): Promise<Response<'listVersions'>>;
  /** `POST /documents/{id}/versions` (needs `edit` somewhere). */
  createVersion(
    docId: string,
    body: Body<'createVersion'>,
    opts?: { idempotencyKey?: string },
  ): Promise<Response<'createVersion'>>;
  /** `GET /documents/{id}/diff`. */
  diff(docId: string, query: Query<'getDiff'>): Promise<Response<'getDiff'>>;
  /** `GET /documents/{id}/attribution`. */
  attribution(docId: string, query: Query<'getAttribution'>): Promise<Response<'getAttribution'>>;
  /** `POST /documents/{id}/restore`; `dryRun` returns the comparison. */
  restore(docId: string, body: Body<'restore'>): Promise<Response<'restore'>>;
  /** `PUT /documents/{id}/read-marker`; it only moves forward. */
  setReadMarker(
    docId: string,
    seq: number,
    opts: { ifMatch: string },
  ): Promise<Tagged<W.ReadMarker>>;
  /** `GET /documents/{id}/activity`. */
  activity(docId: string): Promise<Response<'getActivity'>>;
}

/** Comment threads (05 §6.2; 07 §6; ADR 0015). Feature `comments`. Thread events arrive through `SyncChannel.onEvent`. */
export interface CommentsPort {
  /** `GET /documents/{id}/threads` (`seq` maps ranges to that seq). */
  threads(docId: string, query?: Query<'listThreads'>): Promise<Response<'listThreads'>>;
  /** `POST /documents/{id}/threads` (needs `comment` in the scopes of the target). */
  createThread(
    docId: string,
    body: Body<'createThread'>,
    opts?: { idempotencyKey?: string },
  ): Promise<Tagged<W.Thread>>;
  /** `GET /threads/{tid}`. */
  thread(threadId: string): Promise<Tagged<W.Thread>>;
  /** `PATCH /threads/{tid}`: `state` and `assignee`. */
  updateThread(
    threadId: string,
    patch: Body<'updateThread'>,
    opts: { ifMatch: string },
  ): Promise<Tagged<W.Thread>>;
  /** `DELETE /threads/{tid}` (the author or `manage`). */
  deleteThread(threadId: string, opts?: { ifMatch?: string }): Promise<void>;
  /** `POST /threads/{tid}/comments`. */
  reply(
    threadId: string,
    body: Body<'createComment'>,
    opts?: { idempotencyKey?: string },
  ): Promise<Tagged<W.Comment>>;
  /** `PATCH /comments/{cid}` (the author or `manage`). */
  updateComment(
    commentId: string,
    body: Body<'updateComment'>,
    opts: { ifMatch: string },
  ): Promise<Tagged<W.Comment>>;
  /** `DELETE /comments/{cid}` (the author or `manage`). */
  deleteComment(commentId: string, opts?: { ifMatch?: string }): Promise<void>;
}

/** Bytes to upload: structurally a `Blob`, without depending on the DOM. */
export interface UploadSource {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Assets through quarantine (05 §6.2; 06 §4.4). Feature `assets`. */
export interface AssetsPort {
  /** `POST /documents/{id}/assets`: an asset identifier and a pre-signed upload. */
  create(
    docId: string,
    body: Body<'createAsset'>,
    opts?: { idempotencyKey?: string },
  ): Promise<Response<'createAsset'>>;
  /** `POST /assets/{aid}/complete`; the result arrives as `asset.ready` or `asset.failed`. */
  complete(assetId: string): Promise<void>;
  /** `POST /documents/{id}/assets/resolve`: short-lived signed URLs. */
  resolve(docId: string, assetIds: readonly string[]): Promise<Response<'resolveAssets'>>;
  /** Creates, transfers, completes and waits for `asset.ready`; rejects on `asset.failed`. */
  upload(
    docId: string,
    file: { filename: string; source: UploadSource },
    opts?: { signal?: CancelSignal },
  ): Promise<{ asset: string }>;
}

/** Export jobs (05 §6.2; 09 §9). Feature `exports`. Progress arrives as `export.*` events. */
export interface ExportsPort {
  /**
   * `POST /documents/{id}/exports` (202 with a job). Rejects with `pending_suggestions` when `options.suggestions` is needed.
   * With `onProgress` (PRO-086), the port calls it with the job now and then with each change of its
   * state or progress, until the job is completed, failed or cancelled, or until the backend closes.
   * The reports come from polling `GET /exports/{jid}` (PRO-096), not from the `export.*` events.
   */
  request(
    docId: string,
    body: Body<'createExport'>,
    opts?: { idempotencyKey?: string; onProgress?: (job: W.ExportJob) => void },
  ): Promise<W.ExportJob>;
  /**
   * The export targets the deployment announced in its discovery document (`exportTargets`, 05 §2;
   * UX-101), or null when it does not say. Absent on a port that has no discovery (a stand-in).
   */
  targets?(): readonly string[] | null;
  /** `GET /exports/{jid}`. */
  get(jobId: string): Promise<Tagged<W.ExportJob>>;
  /** `DELETE /exports/{jid}`. */
  cancel(jobId: string): Promise<void>;
}

/**
 * Word imports (05 §6.2; 09 §12). No feature name (G06). 07 §12 makes the route a service-credential
 * operation (decision D16), so a browser backend offers this port only when its host proxies it.
 */
export interface ImportsPort {
  /** `POST /documents/{id}/imports`. */
  request(
    docId: string,
    body: Body<'createImport'>,
    opts?: { idempotencyKey?: string },
  ): Promise<W.ImportJob>;
  /** `GET /imports/{jid}`. */
  get(jobId: string): Promise<Tagged<W.ImportJob>>;
}

/** The font manifest (05 §6.2). No feature name (G06). */
export interface FontsPort {
  /** `GET /fonts`. */
  manifest(): Promise<W.FontManifest>;
}

/** Exclusive-edit leases (05 §6.2; 07 §10). Feature `leases`. */
export interface LeasesPort {
  /** `POST /documents/{id}/regions/{rid}/lease` (needs `edit` in the region). */
  acquire(docId: string, regionId: string): Promise<Tagged<W.Lease>>;
  /** `PUT /documents/{id}/regions/{rid}/lease`: the heartbeat (G66). */
  heartbeat(docId: string, regionId: string, opts: { ifMatch: string }): Promise<Tagged<W.Lease>>;
  /** `DELETE /documents/{id}/regions/{rid}/lease`: release, or break with `manage`. */
  release(docId: string, regionId: string, opts?: { ifMatch?: string }): Promise<void>;
}

/** Fields (12 §3, §9, §10). Feature `fields`. Fills are ordinary commits with origin `fill`. */
export interface FieldsPort {
  /** `GET /documents/{id}/fields`. */
  fields(docId: string, query?: Query<'listFields'>): Promise<Page<W.FieldInfo>>;
  /** `GET /documents/{id}/field-values`, pinned with `seq`. */
  values(docId: string, seq?: number): Promise<Tagged<W.FieldValues>>;
  /** `PATCH /documents/{id}/field-values`: prefill by key (origin `prefill`). */
  prefill(
    docId: string,
    values: W.FieldValues,
    opts: { ifMatch: string },
  ): Promise<Tagged<W.FieldValues>>;
  /** `POST /documents/{id}/fields/{fid}/sign` (feature `sign`; body not defined, G95). */
  sign(docId: string, fieldId: string, body: Body<'signField'>): Promise<Response<'signField'>>;
}

export type WorkflowAction = 'send' | 'correct' | 'resume' | 'void' | 'remind';
export type ParticipantAction = 'consent' | 'verify' | 'complete' | 'decline';

/** Workflow (12 §6 to §8, §10). Feature `workflow`. */
export interface WorkflowPort {
  /** `GET /documents/{id}/workflow`. */
  get(docId: string): Promise<Tagged<W.Workflow>>;
  /** `PUT /documents/{id}/workflow` while it is a draft; otherwise `workflow_active`. */
  put(docId: string, workflow: W.Workflow, opts: { ifMatch: string }): Promise<Tagged<W.Workflow>>;
  /** The actions `send`, `correct`, `resume`, `void` and `remind`; their route is not defined (G95). */
  act(
    docId: string,
    action: WorkflowAction,
    body?: W.WorkflowPlaceholder,
  ): Promise<Tagged<W.Workflow>>;
  /** `POST /documents/{id}/workflow/participants/{pid}/{action}` (method and prefix assumed, G95). */
  participant(
    docId: string,
    participantId: string,
    action: ParticipantAction,
    body?: W.WorkflowPlaceholder,
  ): Promise<W.WorkflowPlaceholder>;
  /** `GET /documents/{id}/workflow/evidence`. */
  evidence(docId: string): Promise<W.WorkflowPlaceholder>;
  /** `GET /documents/{id}/workflow/final`. */
  final(docId: string): Promise<W.WorkflowPlaceholder>;
  /** `wf.changed`: the workflow state and the participant's status, sent like `perm.changed`. */
  onChange(docId: string, cb: (status: W.WorkflowStatus) => void): Unsubscribe;
}

/** Text of one block sent for proofing: only from scopes the user can view (13 §6.1). */
export interface ProofingBlock {
  blockId: string;
  /** The scope the block is in, for example `body` or `region:<id>`. */
  scope: W.ScopeId;
  text: string;
  /** From the `lang` mark or the document default (BCP 47). */
  lang: string;
}

export interface ProofingFinding {
  blockId: string;
  /** UTF-16 offsets into the block's text. */
  from: number;
  to: number;
  kind: 'spelling' | 'grammar' | (string & {});
  message: string;
  suggestions: string[];
}

/**
 * Spelling and grammar (13 §6.1). No protocol resource and no feature name (G06, G91): findings are
 * decorations with suggestions and never change the document by themselves.
 */
export interface ProofingPort {
  check(
    request: { docId: string; blocks: readonly ProofingBlock[] },
    opts?: { signal?: CancelSignal },
  ): Promise<ProofingFinding[]>;
  /** Adds a word to the user's custom dictionary. */
  addWord(word: string, lang: string): Promise<void>;
}

export type AssistantTask = 'draft' | 'rewrite' | 'summarise' | 'answer';

/** What the assistant may see: limited to scopes the user can view (13 §6.2). */
export interface AssistantContext {
  selection?: { blockId: string; from: number; to: number; text: string };
  blocks: ReadonlyArray<{ blockId: string; scope: W.ScopeId; text: string }>;
  outline?: ReadonlyArray<{ blockId: string; level: number; text: string }>;
}

/**
 * The request as a model should read it (UX-048; 13 §6.2; 10 §3.1): fixed instructions, the user's
 * request as the only instruction, and every piece of document text as a labelled data part. Text in
 * a data part never changes what the model does. The editor builds it; a port that cannot use it may
 * read `prompt` and `context` as before.
 */
export interface AssistantPromptStructure {
  readonly instructions: string;
  readonly request: string;
  readonly data: ReadonlyArray<{
    readonly kind: 'data';
    readonly source: 'document' | 'comment' | 'field' | 'host';
    readonly label: string;
    readonly text: string;
  }>;
}

export type AssistantChunk =
  | { kind: 'text'; text: string }
  | { kind: 'done'; agent: string }
  | { kind: 'error'; code: W.ErrorCode | (string & {}); message: string };

/**
 * A provider-neutral assistant (13 §6.2). Output is data: the editor inserts it as suggestions with
 * origin `assistant` under the agent identity, capped at `suggest` (P4). No protocol resource and
 * no feature name (G06, G91).
 */
export interface AssistantPort {
  request(
    request: {
      docId: string;
      task: AssistantTask;
      prompt: string;
      context: AssistantContext;
      structure?: AssistantPromptStructure;
    },
    opts?: { signal?: CancelSignal },
  ): AsyncIterable<AssistantChunk>;
}
