/**
 * The core backend ports (05 §8.3; PRO-091). The component reaches a backend only through these
 * interfaces; `backend-dep`, `backend-mock` and `backend-local` implement them and pass the same
 * contract suite (src/contract).
 *
 * Members beyond the sketch of 05 §8.3 are decisions of S6 (D19 to D24), listed in the spike report.
 */
import type * as W from '../generated/types.ts';
import type {
  AssetsPort,
  AssistantPort,
  CommentsPort,
  ExportsPort,
  FieldsPort,
  FontsPort,
  HistoryPort,
  ImportsPort,
  LeasesPort,
  PresencePort,
  ProofingPort,
  WorkflowPort,
} from './optional.ts';
import type {
  Access,
  Ack,
  ChannelOpened,
  ChannelState,
  Commit,
  Content,
  Notification,
  RemoteCommit,
  Resume,
  Session,
  SyncCheck,
  SyncReset,
  Tagged,
  Unsubscribe,
} from './types.ts';

/** Where an implementation gets user tokens (05 §8.1 `getToken`). Not a port member: a constructor option. */
export type TokenSource = (ctx: { docId?: string }) => Promise<string>;

export interface Backend {
  /**
   * Features both sides support: what the client asked for and the server announced (05 §1 rule 4).
   * Empty until `connect()` resolves (D23). The interface shows a feature only when its port is
   * present (05 §8.3; see hasPort()).
   */
  readonly features: ReadonlySet<string>;
  /**
   * The export targets the deployment announced in its discovery document (`exportTargets`, 05 §2;
   * UX-101), or null when it does not say or before `connect()` has read it. Absent on a backend
   * that has no discovery (a stand-in); the interface then offers the PDF and the LaTeX bundle.
   */
  exportTargets?(): readonly string[] | null;
  /** Opens the session (`hello`, `welcome`). Rejects with a PortError (`unauthenticated`, `revoked`, `unsupported_version`, …). */
  connect(): Promise<void>;
  /** Closes every channel and the session. Idempotent. */
  close(): Promise<void>;
  readonly auth: AuthPort;
  readonly sync: SyncPort;
  readonly permissions: PermissionsPort;
  // Optional ports (05 §8.3; PRO-092): present only when the backend offers them.
  readonly presence?: PresencePort;
  readonly history?: HistoryPort;
  readonly comments?: CommentsPort;
  readonly assets?: AssetsPort;
  readonly exports?: ExportsPort;
  readonly imports?: ImportsPort;
  readonly fonts?: FontsPort;
  readonly leases?: LeasesPort;
  readonly fields?: FieldsPort;
  readonly workflow?: WorkflowPort;
  readonly proofing?: ProofingPort;
  readonly assistant?: AssistantPort;
}

/**
 * Authentication (05 §3, §5.1; decision D24). Tokens come from the implementation's TokenSource;
 * the port reports the session and the events the element turns into `de-auth-required`.
 */
export interface AuthPort {
  /** The `welcome` of the current session (version, session, user, features, limits, tokenExp); null before connect(). */
  readonly session: Session | null;
  /** Gets a new token from the token source and presents it (`auth.refresh`, `auth.ok`). Resolves the new `tokenExp`. */
  refresh(): Promise<{ tokenExp: string }>;
  /** `auth.expiring`: the token expires in `inMs`; the backend refreshes by itself, this reports it. */
  onExpiring(cb: (e: { inMs: number }) => void): Unsubscribe;
  /** `auth.revoked` (followed by close 4401, 05 §3.3): every channel is closed. */
  onRevoked(cb: (e: { reason: string }) => void): Unsubscribe;
  /** The token source failed or the token was refused (`unauthenticated`, `token_expired`, `revoked`). */
  onAuthRequired(cb: (e: { code: W.ErrorCode; message: string }) => void): Unsubscribe;
}

export interface SyncPort {
  /**
   * Content at the head, or at `seq` (a pinned read, `GET /documents/{id}/content?seq=N`). Resolves
   * `requires` too, which a reader MUST check before parsing (03 §2; decision D19). Rejects with a
   * PortError (`not_found`, `forbidden`).
   */
  loadContent(docId: string, seq?: number): Promise<Content>;
  /**
   * `GET /documents/{id}`: the metadata of the document, with its ETag (05 §6.2). The interface reads
   * the classification label from it (UX-085; PRO-048) and fetches it again on `document.updated`
   * (owner decision 216). A reader ignores the fields it does not know (PRO-005). Optional: a
   * backend without a metadata read leaves the label out of the status bar. Not in `CORE_MEMBERS`;
   * each implementation has its own test.
   */
  document?(docId: string): Promise<Tagged<W.DocumentResource>>;
  /**
   * Opens a document channel (`ch.open`). Without `resume` the server answers `catchUp: "reload"`,
   * and the caller fetches the content at `opened.head`. Rejects with a PortError carrying the
   * `ch.rejected` code.
   *
   * `features` are the CDM features the caller's editor reads (03 section 11.1; D120). A backend
   * announces them in `ch.open`, limited to what the server announced, and the room adds a feature to
   * `requires` only when every attached channel announced it. Without it a backend sends the
   * features it was constructed with.
   */
  open(
    docId: string,
    opts: { resume?: Resume; features?: readonly string[] },
  ): Promise<SyncChannel>;
}

/**
 * A document channel (05 §5.2 to §5.6). Delivery rules (decision D21):
 * - no callback is called synchronously from `open()`, `submit()` or an `on…` call;
 * - messages are delivered in the order the channel received them;
 * - a message that arrives before any callback of its kind is registered is kept and delivered,
 *   in order, to the first such callback, so a caller that subscribes right after `open()`
 *   resolves misses nothing;
 * - after settling a `submit()` promise the channel yields one microtask before delivering the next
 *   message, so code that awaits `submit()` directly runs before later commits arrive.
 */
export interface SyncChannel {
  readonly docId: string;
  /** What `ch.opened` said: `head`, `incarnation`, `catchUp`, `inflight`, `access`, `workflow` (decision D20). */
  readonly opened: ChannelOpened;
  /**
   * Submits a commit (`sync.submit`). Resolves the `Ack` (with `steps` when rebased); rejects with
   * a SyncRejectError (`sync.reject`, carrying `code`, `action` and `head`), or with a PortError of
   * code `unavailable` when the channel closes first (decision D23).
   */
  submit(commit: Commit): Promise<Ack>;
  /** `sync.commit`: other sessions' commits and control commits, in ascending `seq` without gaps. */
  onCommits(cb: (commits: RemoteCommit[]) => void): Unsubscribe;
  /** `sync.reset`: a snapshot commit was stored; reload the content at `seq`. */
  onReset(cb: (reset: SyncReset) => void): Unsubscribe;
  /** The access of `ch.opened` first, then every `perm.changed`. */
  onAccess(cb: (access: Access) => void): Unsubscribe;
  /** `event`: "this changed; fetch it over REST if you care". */
  onEvent(cb: (event: Notification) => void): Unsubscribe;
  /** The channel state: the initial state first, then every change. */
  onState(cb: (state: ChannelState) => void): Unsubscribe;
  /** `sync.check`: compare the confirmed document's hash at `seq` (04 §13; decision D20). */
  onCheck(cb: (check: SyncCheck) => void): Unsubscribe;
  /** Closes the channel (`ch.close`). Idempotent; later messages are ignored. */
  close(): void;
}

/**
 * Permissions (05 §5.5, §6.2; 07; decision D24). `current` and `onAccess` mirror the access of the
 * document's open channel; the other members exist when the backend announces `regions`.
 */
export interface PermissionsPort {
  /** The latest access for a document with an open channel; null otherwise. */
  current(docId: string): Access | null;
  /** Every access for the document, in order: the one of `ch.opened`, then each `perm.changed`. */
  onAccess(docId: string, cb: (access: Access) => void): Unsubscribe;
  /** `GET /documents/{id}/regions`. */
  regions?(docId: string): Promise<W.RegionInfo[]>;
  /** `GET /documents/{id}/grants`. */
  grants?(docId: string): Promise<Tagged<W.Grants>>;
  /**
   * `PATCH /documents/{id}/grants` (needs `manage`). Resolves once no commit can be stored under the
   * old grants revision (04 G7).
   */
  updateGrants?(
    docId: string,
    patch: W.GrantsPatch,
    opts: { ifMatch: string },
  ): Promise<Tagged<W.Grants>>;
  /** `PUT /documents/{id}/regions/{rid}/state` (needs `manage`). */
  setRegionState?(
    docId: string,
    regionId: string,
    state: W.RegionStateRequest['state'],
    opts: { ifMatch: string },
  ): Promise<Tagged<W.RegionState>>;
}
