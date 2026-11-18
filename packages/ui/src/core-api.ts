/**
 * What the user interface sees of the editing core (02 §4, §5.1). Plain data and named commands
 * only: no ProseMirror type, and no document or editor state in reactive state. The core in
 * `@docedit/engine` satisfies this interface structurally; `ui` does not depend on it.
 *
 * Every member added after spike S1 is optional, so a core that does not offer it yet still
 * satisfies the interface; the shell then shows nothing it cannot back with the core's own data
 * (ADR 0041). The additions of phase 1a are listed in ADR 0041, section 9, those of phase 1b in
 * ADR 0052. "Core" here is whatever the element passes as `core`: the editing core's views, and
 * the backend's ports adapted by the element (exports, grants, regions).
 */
import type { ExtensionApiOptions, ExtensionDocumentApi } from './extensions/document-api.ts';
import type { FieldDraft } from './shell/field-properties.ts';

export interface ReadView<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

/**
 * Objects the selection is in or on (13 §3: contextual groups for tables, pictures, headers and
 * fields; UX-008 context-menu targets). `story` is a header or footer.
 */
export type SelectionContext = 'table' | 'picture' | 'story' | 'field' | 'comment';

export interface SelectionSummary {
  empty: boolean;
  scope: 'body' | 'region';
  region: string | null;
  style: string | null;
  marks: string[];
  /** Objects the selection is in or on; absent or empty: plain text (UX-007, UX-008). */
  contexts?: readonly SelectionContext[];
  /** The language at the selection (the `lang` mark); null for the document's default (UX-018). */
  lang?: string | null;
  /** The identifier of the paragraph style at the selection, when `style` names one (UX-022). */
  styleId?: string | null;
}

export interface PanelInfo {
  kind: 'footnote' | 'story';
  id: string;
  /** Kept for spike S1; the shell names panels from its own string tables by `kind` (UX-064). */
  label: string;
}

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

export type CommandName =
  'bold' | 'italic' | 'selectAll' | 'insertFootnote' | 'editHeader' | 'undo' | 'redo';

/** Capabilities of 07 §1. */
export type Capability = 'view' | 'comment' | 'suggest' | 'edit' | 'fill' | 'structure' | 'manage';

/**
 * Why the user may not change content where the selection is (07 §4, §7; 05 §5.5). The shell turns
 * it into the reason a disabled command gives (UX-004).
 *
 * - `role`: the document role allows no editing in this scope (viewer, commenter);
 * - `region`: a restricted region without a grant for this user;
 * - `approved`: the region's state is `approved` (07 §4, limit 2);
 * - `lease`: another user holds a lease on the region (07 §4, limit 3);
 * - `locked`, `archived`: the document's state (07 §4, limit 1);
 * - `workflow`: an active workflow freezes the content (12);
 * - `unlisted`: a region the current `access` does not list yet (05 §5.5);
 * - `hidden`: content the user may not read (ADR 0019).
 */
export type AccessLimit =
  | 'role'
  | 'region'
  | 'approved'
  | 'lease'
  | 'locked'
  | 'archived'
  | 'workflow'
  | 'unlisted'
  | 'hidden';

/** The user's effective access where the selection is (07 §4), for command states (UX-004). */
export interface AccessSummary {
  /**
   * The scope of the selection as DEP names it (05 §5.3): `body`, `region:<id>`, `defs`,
   * `story:<id>`, `field:<id>`. For a selection across scopes, the scope that limits it most.
   */
  readonly scope: string;
  /** Effective capabilities in that scope (07 §4). */
  readonly caps: readonly Capability[];
  /** What limits them, when `edit` is missing; null or absent when nothing does. */
  readonly limit?: AccessLimit | null;
}

/** Connection and save state: the `detail` of `de-status` (05 §8.1; 02 §2.2; FE-007). */
export type ConnectionState = 'online' | 'reconnecting' | 'offline';
export type SyncState = 'saved' | 'saving' | 'unsaved' | 'readonly';

export interface StatusSummary {
  readonly connection: ConnectionState;
  readonly sync: SyncState;
}

/**
 * Another session in the document (05 §5.4 `presence.state`). The view holds only the sessions
 * the core says this user may see (ADR 0019): the shell shows nothing else, and never a peer the
 * view leaves out.
 */
export interface PresencePeer {
  /** The peer's session identifier. */
  readonly session: string;
  /** The user identifier, resolved to a name through the host's `resolveUsers` (UX-025). */
  readonly user: string;
  /** The name the service reported (`user.name`): the fallback when the host gives none. */
  readonly name?: string | null;
  readonly status: 'active' | 'idle';
}

/** Counts shown on header buttons; an absent member is unknown and shows no count. */
export interface ShellCounts {
  /** Open comment threads (13 §3). */
  readonly comments?: number;
  /** Changes and comment activity since the reader's last visit (08 §10). */
  readonly catchUp?: number;
}

/**
 * The last local change the region guard refused (FE-036; the core's `refusal` view). `n` counts
 * refusals, so the same reason twice is two notices. `reason` is the guard's code: `scope`,
 * `structure`, `manage`, `read-only`, `placeholder`, `redacted`, `identifier`, `step`, `invariant`;
 * the shell explains an unknown code in general words. `scopes` are DEP scope identifiers; the shell
 * never shows them, so a notice names nothing the reader cannot see (ADR 0019).
 */
export interface RefusalNotice {
  readonly n: number;
  readonly reason: string;
  readonly scopes: readonly string[];
  /** Suggestions a suggestion command skipped, when it counts them (FE-047 criterion 6). */
  readonly count?: number;
}

/**
 * A deletion that was trimmed to the parts the user may change (FE-037 criterion 2; the core's
 * `trimmed` view). `n` counts trimmed deletions; `skipped` names the scopes kept, which the shell
 * never shows. The shell says that parts were kept and announces it.
 */
export interface TrimNotice {
  readonly n: number;
  readonly skipped: readonly string[];
}

/**
 * One piece of work that was set aside (02 §2.2; 04 §8; 07 §9): a commit the server rejected, or
 * unsent work after a rebase failure, a reload or a reset. The shell lists it in the recovered
 * edits pane (UX-017) and announces its arrival.
 */
export interface RecoveredItem {
  /** The rejection code (05 §5.8), or `rebase`, `reload`, `reset`, `stale`. */
  readonly reason: string;
  readonly commit: string | null;
  /** The text the change inserted: the user's own words, shown only to them. */
  readonly text: string;
  readonly seq: number;
  /** A stable identifier for `insertRecovered` and `discardRecovered`; else the index is used. */
  readonly id?: string;
  /** The DEP scope the change was in; the shell names it only through `regions` (ADR 0019). */
  readonly scope?: string | null;
  /** Who changed the permission that caused a `permission_denied`, when known (07 §9). */
  readonly changedBy?: string | null;
  /** Every scope a `permission_denied` named; `scope` alone when absent (PRM-024). */
  readonly scopes?: readonly string[];
  /** When the permissions changed (an ISO 8601 time), when known (07 §9; PRM-024). */
  readonly changedAt?: string | null;
  /** For a `conflict` that named fields: their identifiers, changed by someone else first (FRW-010). */
  readonly fields?: readonly string[];
}

/** Work set aside so far; `de-recovered-edits` carries `count` (05 §8.1). */
export interface RecoveredEdits {
  readonly count: number;
  readonly items: readonly RecoveredItem[];
}

/** Interface strings the core puts on the surfaces it renders (UX-064: all strings external). */
export interface CoreLabels {
  /** Accessible name of the body's editing surface. */
  readonly body: string;
  /** Accessible name of the footnote sub-editor. */
  readonly footnote: string;
  /** Accessible name of the header or footer sub-editor. */
  readonly story: string;
}

/**
 * Named queries of the document API that the built-in command registry uses (13 §4; 02 §5.1).
 * `query(name)` answers them for the current selection:
 *
 * - `canEditSelection`: content at the selection may be changed (edit, or suggest in suggestion
 *   mode), as the region guard would allow typing there;
 * - `canUndo`, `canRedo`: the user's own history has a change to undo or redo;
 * - `isBold`, `isItalic`: the mark is active at the selection;
 * - `canInsertFootnote`: a footnote may be inserted at the selection;
 * - `hasHeader`: the document has a header story to open.
 */
export type CoreQueryName =
  | 'canEditSelection'
  | 'canUndo'
  | 'canRedo'
  | 'isBold'
  | 'isItalic'
  | 'canInsertFootnote'
  | 'hasHeader'
  | CoreQueryName1b;

/**
 * Queries of phase 1b (ADR 0052). A core answers only those it lists in `queryNames`; the shell
 * registers a built-in command only when the core knows every query it names. `queryReason` may
 * say why one answered false (`nested`, `limit`, `blocks`, `subeditor`, `none`, `structure`).
 *
 * - `canCopyFormat`: the selection has formatting the format painter can take (UX-009);
 * - `canPasteFormat`: formatting was taken and may be applied at the selection;
 * - `canMarkRegion`: the selection is whole blocks of the body, outside any region, and the
 *   document has room for another region (PRM-033);
 * - `hasNextEditableRegion`: a region after the caret, in document order, where the user has
 *   `edit` (PRM-027);
 * - `canInsertField`: a field may be inserted at the selection (FRW-072).
 */
export type CoreQueryName1b =
  'canCopyFormat' | 'canPasteFormat' | 'canMarkRegion' | 'hasNextEditableRegion' | 'canInsertField';

/**
 * Named commands of phase 1b, run through `runNamed` and declared in `commandNames` (ADR 0052).
 * Each passes the same guards as typing. Arguments:
 *
 * - `copyFormat`, `pasteFormat`: none (UX-009);
 * - `paragraphStyle`, `characterStyle`: `{ style }`, a style identifier (UX-022);
 * - `setLanguage`: `{ lang }`, a BCP 47 tag, or null for the document's default (UX-018);
 * - `markRegion`: `{ title }`; the core wraps the selected blocks in a region with policy
 *   `inherit` (PRM-033);
 * - `setRegionPolicy`: `{ region, policy }`, `inherit` or `restricted` (PRM-036);
 * - `nextEditableRegion`: none (PRM-027);
 * - `insertField`: `{ kind }` (FRW-072);
 * - `insertRecovered`, `discardRecovered`: `{ id }`, the item's `id` or its index as a string
 *   (UX-017);
 * - `finishFill`: none (FRW-076).
 */
export type CoreCommandName =
  | 'copyFormat'
  | 'pasteFormat'
  | 'paragraphStyle'
  | 'characterStyle'
  | 'setLanguage'
  | 'markRegion'
  | 'setRegionPolicy'
  | 'nextEditableRegion'
  | 'insertField'
  | 'insertRecovered'
  | 'discardRecovered'
  | 'finishFill';

/** Modes of 05 §8.1 and 13 §3. */
export type EditorMode = 'edit' | 'review' | 'view' | 'fill';

/** Views of 02 §7. */
export type ViewName = 'web' | 'read' | 'print';

/** A rectangle in CSS pixels. */
export interface ShellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The DEP `access` object (05 §5.5) as plain data, for what the shell decides document-wide: which
 * modes the user may choose (UX-015), whether the grant controls show (PRM-035).
 */
export interface AccessObject {
  readonly rev: number;
  readonly docRole: string;
  /** Document-level capabilities, including `structure` and `manage`. */
  readonly caps: readonly string[];
  /** Capabilities per scope. */
  readonly scopes: Readonly<Record<string, readonly string[]>>;
  /** Output restrictions (`no-export`, `no-copy`, `no-print`). */
  readonly restrictions?: readonly string[];
}

/**
 * A classification label of the document (UX-085; 13 §3, §10). `name` is content the tenant set,
 * shown as it is written, so the shell never translates it.
 */
export interface ClassificationLabel {
  readonly name: string;
}

/** One proofing finding as the interface reads it (UX-041): text, kind and suggestions, no position. */
export interface ProofingFindingView {
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  /** The text the finding covers. */
  readonly text: string;
  readonly suggestions: readonly string[];
  /** The scope the text is in (`body` or `region:<id>`). */
  readonly scope: string;
  readonly lang: string;
}

/** The proofing state the status bar and the menus read (UX-041, UX-042). */
export interface ProofingStatus {
  /** A proofing port is attached. Without one no proofing control is shown. */
  readonly available: boolean;
  readonly state: 'idle' | 'checking' | 'unavailable';
  /** The findings shown now. */
  readonly count: number;
  /** The port can add, list and remove custom dictionary words. */
  readonly dictionary: boolean;
  /** The finding the last navigation chose. */
  readonly current: ProofingFindingView | null;
  /** The finding the caret is in. */
  readonly atCaret: ProofingFindingView | null;
}

/** Counts for the status bar (UX-018). */
export interface DocumentStats {
  /** Words in the body this reader sees; null while unknown. */
  readonly words: number | null;
  /**
   * Pages of the last typeset result; null without one, because the web view shows no pages
   * (02 §7). `stale` is true once the document has changed since that result.
   */
  readonly pages: {
    readonly count: number;
    readonly seq: number;
    readonly stale: boolean;
  } | null;
}

/** A style the document defines (03 §4 `style_def`; UX-022). Names are content. */
export interface StyleSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: 'paragraph' | 'character' | 'table';
}

/** Who can edit a region (05 §6.2 `RegionEditors`; PRM-032). */
export interface RegionEditors {
  /** Document roles that may edit by role alone (`editor`, `owner`). */
  readonly roles: readonly string[];
  /** Principals with an `editor` grant (`user:<id>`, `group:<id>`). */
  readonly principals: readonly string[];
  /** The holder of a lease: while it holds, only they may edit (07 §10). */
  readonly leasedTo?: string;
}

/**
 * An entry of the derived region list (05 §6.2 `GET /documents/{id}/regions`; PRM-032), as this
 * reader may see it: a region hidden from them has no title and no editors (ADR 0019).
 */
export interface RegionSummary {
  readonly id: string;
  readonly title: string | null;
  readonly policy: 'inherit' | 'restricted' | 'confidential';
  readonly order: number;
  readonly state: 'draft' | 'in_review' | 'approved';
  readonly editors?: RegionEditors;
}

/**
 * The words the core puts on the lock indicator of a region the user cannot edit (PRM-026):
 * `indicator` is short and visible, `description` says who can edit it. The shell writes them,
 * with names from the host's directory, so the core never sees a name.
 */
export interface RegionLabel {
  readonly indicator: string;
  readonly description: string;
}

/**
 * Another session's caret and selection (UX-027), in CSS pixels relative to the element the core's
 * body view is mounted in (`mountBody`'s target), so scrolling does not move them. The view holds
 * only peers this user may see, never inside hidden content (ADR 0019).
 */
export interface PeerCaret {
  readonly session: string;
  readonly user: string;
  readonly name?: string | null;
  readonly status: 'active' | 'idle';
  /** Null when the position cannot be mapped: then nothing is drawn (UX-027 criterion 3). */
  readonly caret: ShellRect | null;
  readonly selection: readonly ShellRect[];
}

export interface SearchOptions {
  readonly matchCase?: boolean;
  readonly wholeWord?: boolean;
}

/** One match of a search over what this reader holds (ADR 0019): text around it, for context. */
export interface SearchMatch {
  readonly index: number;
  readonly blockId: string;
  readonly before: string;
  readonly text: string;
  readonly after: string;
}

export interface SearchResults {
  readonly query: string;
  readonly total: number;
  readonly matches: readonly SearchMatch[];
}

/** Export targets (05 §6.2). */
export type ExportTarget = 'pdf' | 'tex' | 'docx' | 'cdm' | 'html' | 'md';

/** The options of EXP-005 that the dialog offers. */
export interface ExportOptions {
  readonly profile?: 'preview' | 'final';
  readonly tagging?: 'on' | 'draft' | 'off';
  readonly fields?: 'flatten' | 'blank';
}

/** A diagnostic of an export (09 §9.2; EXP-065). */
export interface ExportDiagnostic {
  readonly severity: string;
  readonly code: string;
  readonly blockId: string | null;
  readonly message: string;
}

/** An export job as the dialog follows it (05 §6.2 `ExportJob`; `export.progress` events). */
export interface ExportJobView {
  readonly id: string;
  readonly target: ExportTarget;
  readonly seq: number;
  readonly state: 'queued' | 'converting' | 'compiling' | 'completed' | 'failed' | 'cancelled';
  /** Per cent done; null while unknown. */
  readonly progress: number | null;
  readonly result: {
    readonly url: string;
    readonly pages: number | null;
    readonly converged: boolean | null;
  } | null;
  readonly diagnostics: readonly ExportDiagnostic[];
  readonly error?: { readonly code: string; readonly message: string };
}

/** Export jobs through the element (the `exports` port; PRO-086). */
export interface ExportService {
  /** The targets the deployment announces, in the order to offer them. */
  readonly targets: ReadView<readonly ExportTarget[]>;
  /** True when an export leaves out parts hidden from this reader (ADR 0019; UX-104). */
  readonly projected?: ReadView<boolean>;
  /**
   * The warnings of the preflight shared with the converter (09 §1; EXP-003), for the document as
   * the core holds it now, before any job is created. Empty when nothing was found. Absent when
   * the core has no preflight; the dialog then creates the job at once.
   */
  preflight?(
    target: ExportTarget,
  ): readonly ExportDiagnostic[] | Promise<readonly ExportDiagnostic[]>;
  /** Starts a job; resolves with its identifier, or rejects with an error that has a `code`. */
  request(target: ExportTarget, options: ExportOptions): Promise<{ jobId: string }>;
  /** The job as `export.*` events report it; null for an unknown job. */
  job(jobId: string): ReadView<ExportJobView | null>;
  cancel(jobId: string): Promise<void>;
}

/** Roles a region grant may give (07 §2). */
export type RegionRole = 'viewer' | 'commenter' | 'suggester' | 'editor';

/** A region grant (05 §6.2 `RegionGrant`). */
export interface RegionGrant {
  readonly region: string;
  /** `user:<id>`, `group:<id>`, `everyone` or `role:<id>`. */
  readonly principal: string;
  readonly role: RegionRole;
  readonly expiresAt?: string | null;
}

export interface GrantsSnapshot {
  readonly etag: string;
  readonly grants: readonly RegionGrant[];
}

/** The document's region grants through the permissions port (PRM-035). */
export interface GrantsService {
  /** `GET /documents/{id}/grants`. */
  load(): Promise<GrantsSnapshot>;
  /**
   * `PATCH /documents/{id}/grants` with `If-Match: etag`. Rejects with an error whose `code` is
   * `precondition_failed` when someone changed the grants first; nothing is overwritten.
   */
  save(grants: readonly RegionGrant[], etag: string): Promise<GrantsSnapshot>;
}

/** A field of the document as fill mode shows it (FRW-076, FRW-077, FRW-078). */
export interface FillField {
  readonly id: string;
  /** The field's `label`: document content. */
  readonly label: string;
  readonly required: boolean;
  readonly filled: boolean;
  /** Why the value is invalid, as a reason code (`format`, `range`, `required`, ...); else null. */
  readonly invalid: string | null;
  /**
   * The `role_def` identifier the field is assigned to, or null for a field only authors set
   * (FRW-077). Absent: the core does not say, and the field is the participant's own (a core that
   * lists only those). A core that gives assignees also gives `FillSummary.roles`.
   */
  readonly assignee?: string | null;
  /**
   * The assigned role's name, colour and place in the document's role list, when this reader may
   * see the role (FRW-074, FRW-077). The icon is derived from `order`.
   */
  readonly role?: FieldRoleInfo | null;
}

/** A `role_def` as a fill-mode field shows it (FRW-074, FRW-077). */
export interface FieldRoleInfo {
  readonly name: string;
  readonly color: string;
  /** Position among the document's roles, in definition order (0 for the first). */
  readonly order: number;
}

/** Fill mode as this participant sees it (12 §11; FRW-076). */
export interface FillSummary {
  /** False while the participant may not fill: waiting for an earlier one, or paused. */
  readonly active: boolean;
  readonly inactive?: 'waiting' | 'paused' | null;
  /**
   * The fields, in document order: every field of the document this reader may see, so that the
   * fields of other roles can be marked (FRW-077), or only the participant's own, without
   * `assignee`. The bar and the summary count only the participant's own (`shell/fields.ts`).
   */
  readonly fields: readonly FillField[];
  /** The `role_def` identifiers this participant holds (FRW-077); empty when the core does not say. */
  readonly roles?: readonly string[];
}

export interface CoreApi {
  readonly selection: ReadView<SelectionSummary>;
  readonly panel: ReadView<PanelInfo | null>;
  readonly outline: ReadView<readonly OutlineItem[]>;
  run(command: CommandName): boolean;
  closePanel(): void;
  focus(): void;
  /** Mounts the body view; returns the function that unmounts it. */
  mountBody(target: HTMLElement): () => void;
  /** Mounts the sub-editor of the open panel; returns the function that unmounts it. */
  mountPanel(target: HTMLElement): () => void;

  // Added for packet C (ADR 0041). All optional: see the file comment.

  /**
   * Evaluates a named query of the document API for the current selection (13 §4; 02 §5.1).
   * Returns undefined for a name the core does not answer. Must not change any state.
   */
  query?(name: string): boolean | undefined;
  /** The names `query` answers; when absent, the shell assumes `CoreQueryName`. */
  readonly queryNames?: readonly string[];
  /**
   * Increases whenever the answer of a query may have changed: any applied transaction, a
   * permission change, a change of the open panel. Notifies at most once per frame (02 §4).
   */
  readonly revision?: ReadView<number>;
  /** Effective access at the selection (07 §4), updated on selection moves and `perm.changed`. */
  readonly access?: ReadView<AccessSummary>;
  /** Connection and save state (FE-007), the same object `de-status` carries. */
  readonly status?: ReadView<StatusSummary>;
  /** Other sessions, limited to what this user may see (ADR 0019). Not this session. */
  readonly presence?: ReadView<readonly PresencePeer[]>;
  /**
   * Features both sides support (05 §1 rule 4; §8.3: the interface shows a feature only when its
   * port is present). Absent or empty: no optional feature is shown.
   */
  readonly features?: ReadView<readonly string[]>;
  /** Counts for the header buttons (13 §3). */
  readonly counts?: ReadView<ShellCounts>;
  /** The document's base direction (`settings.dir`, 03); the page keeps it whatever the interface's is. */
  readonly direction?: ReadView<'ltr' | 'rtl'>;
  /** Sets the accessible names the core puts on its surfaces, in the interface's locale. */
  setLabels?(labels: CoreLabels): void;

  // Added for packet U (phase 1b; ADR 0052). All optional, like the members above.

  /** The last local change the region guard refused; the shell shows and announces it. */
  readonly refusal?: ReadView<RefusalNotice | null>;
  /** The last deletion the core trimmed to the editable parts (FE-037 criterion 2); the shell announces it. */
  readonly trimmed?: ReadView<TrimNotice | null>;
  /** Work set aside (rejected or unsent); the shell lists it and announces new items (UX-017). */
  readonly recovered?: ReadView<RecoveredEdits>;

  /** Named commands beyond `CommandName` that `runNamed` runs (`CoreCommandName`). */
  readonly commandNames?: readonly string[];
  /** Runs a named command of `commandNames`; false when it did not apply or is unknown. */
  runNamed?(name: string, args?: unknown): boolean;
  /** Why a query answered false, as a reason code; null or undefined when it has none. */
  queryReason?(name: string): string | null | undefined;

  /** The DEP access in force (05 §5.5); null before any. The engine's `permissions` view. */
  readonly permissions?: ReadView<AccessObject | null>;

  /** The mode in effect (05 §8.1 `mode`). In `view` and `fill` no content command runs. */
  readonly mode?: ReadView<EditorMode>;
  /** The modes this build supports; the switcher offers no other (UX-015). */
  readonly modes?: ReadView<readonly EditorMode[]>;
  /**
   * `settings.trackChanges` is `everyone` (UX-038): every user edits as suggestions, and the mode
   * switcher shows `review` with the reason (`trackedModeFor`). Absent, the setting is off.
   */
  readonly trackedForEveryone?: ReadView<boolean>;
  /** Asks for a mode; false when it is refused. The server's permissions still apply. */
  setMode?(mode: EditorMode): boolean;
  /** The view in effect (05 §8.1 `view`) and those this build supports (UX-007 criterion 6). */
  readonly view?: ReadView<ViewName>;
  readonly views?: ReadView<readonly ViewName[]>;
  setView?(view: ViewName): boolean;

  /**
   * Spelling and grammar (UX-041; 13 §6.1). Absent, or `available` false, when the host gave no
   * proofing port: no proofing control is shown then.
   */
  readonly proofing?: ReadView<ProofingStatus>;
  /** Moves the caret to the next (or previous) finding, wrapping; false when there is none. */
  proofingStep?(direction?: 1 | -1): boolean;
  /** Applies one suggestion of a finding as an edit through the core's guards (UX-042). */
  applyFinding?(id: string, suggestion?: number): boolean;
  /** Hides a finding once, or everywhere for the session. */
  ignoreFinding?(id: string, everywhere?: boolean): boolean;
  /** Adds the finding's text to the port's custom dictionary. */
  addFindingToDictionary?(id: string): Promise<boolean>;

  /** Word and page counts (UX-018). */
  readonly stats?: ReadView<DocumentStats>;
  /** The document's default language (`settings.lang`), a BCP 47 tag; null when not set. */
  readonly language?: ReadView<string | null>;
  /**
   * The document's classification label (UX-085): a tenant's marking, as the document resource
   * holds it. Null when the document has none. The status bar shows its name as text.
   */
  readonly classification?: ReadView<ClassificationLabel | null>;
  /** The document's styles, in the document's order (UX-022). */
  readonly styles?: ReadView<readonly StyleSummary[]>;
  /** The derived region list, as this reader may see it (PRM-032; ADR 0019). */
  readonly regions?: ReadView<readonly RegionSummary[]>;
  /** The words for the lock indicators of regions the user cannot edit, by region id (PRM-026). */
  setRegionLabels?(labels: Readonly<Record<string, RegionLabel>>): void;
  /** Other sessions' carets and selections, mapped through local steps (UX-027). */
  readonly carets?: ReadView<readonly PeerCaret[]>;

  /** Puts the caret at the start of a block and scrolls it into view; false when it is gone. */
  selectBlock?(id: string): boolean;
  /**
   * Whether a block has changed after the commit `seq` (an export job's `seq`; EXP-065
   * criterion 3): true when it has, false when it has not, null when the core cannot tell (the
   * block is gone, or `seq` is older than what the core has followed). Never about hidden content
   * (ADR 0019).
   */
  blockChangedSince?(id: string, seq: number): boolean | null;
  /** Searches what this reader holds (ADR 0019: never hidden content). */
  search?(query: string, options?: SearchOptions): Promise<SearchResults>;
  /** Selects a match of the last search and scrolls it into view; false when it is gone. */
  selectMatch?(match: SearchMatch): boolean;
  /** The caret's rectangle in viewport coordinates, for menus opened from the keyboard. */
  caretRect?(): ShellRect | null;

  /** Export jobs (UX-101), when the backend announces `exports`. */
  readonly exports?: ExportService;
  /**
   * The document as this reader holds it (the engine's `getContent()`, a CDM envelope), for the
   * client export filters of extensions (UX-055; 13 §7.1). Never hidden content (ADR 0019).
   */
  getContent?(): unknown;
  /** The range-based document API for one extension (UX-053; 13 section 7.1). Absent: extensions get none. */
  extensionApi?(options: ExtensionApiOptions): ExtensionDocumentApi;
  /** Region grants (PRM-035), when the backend announces `regions`. */
  readonly grants?: GrantsService;
  /** Fill mode for this participant (FRW-076), or null outside fill mode. */
  readonly fill?: ReadView<FillSummary | null>;
  /** Moves focus to a field and scrolls it into view (FRW-078); false when it is gone. */
  focusField?(id: string): boolean;
  /** Comment threads (UX-028; 05 §6.2), when the backend announces `comments`. */
  readonly threads?: ThreadsService;
  /**
   * The history of the document (HIS-009; 08 §4): the host's read of `GET /history`, shaped for
   * the pane. Absent when the backend does not announce `history`; the history control then
   * does not show (05 §8.3).
   */
  readonly history?: HistoryPort;
  /** The sources the document cites (UX-103; CDM-052). Absent: the sources pane is not offered. */
  readonly sources?: SourcesService;
  /** The roles fields are assigned to (FRW-074). Absent: the roles manager is not offered. */
  readonly roles?: RolesService;
  /** The properties of form fields (FRW-073). Absent: the field properties pane is not offered. */
  readonly fieldProperties?: FieldPropertiesService;
  /** The math editor for equations (FE-070). Absent: an equation is not editable in the shell. */
  readonly mathEditor?: MathEditorService;
}

/** An equation as the math editor takes it (FE-070): where it is, its LaTeX source and its kind. */
export interface EquationRef {
  /** The node's position in the document; opaque to the shell. */
  readonly pos: number;
  readonly latex: string;
  /** True for a display equation, false for one in a line of text. */
  readonly display: boolean;
}

/** A request to open the math editor on an equation: a double click or Enter on it. */
export interface EquationEditRequest extends EquationRef {
  /** Counts requests, so that asking twice for the same equation opens it twice. */
  readonly n: number;
}

/** What confirming an equation came to (FE-070). */
export type EquationOutcome =
  | { readonly ok: true; readonly confirmed: boolean }
  | {
      readonly ok: false;
      /** `too-long` and `too-deep` are the limits (I7); `rejected` is the service's answer (I8). */
      readonly reason:
        'too-long' | 'too-deep' | 'read-only' | 'suggestion' | 'rejected' | 'refused';
      /** The document service's own reason, for `rejected`. */
      readonly message?: string;
    };

/** The visual field of the math editor, once its chunk has loaded. */
export interface MathFieldHandle {
  /** The LaTeX the field holds now. */
  readonly value: string;
  setValue(latex: string): void;
  focus(): void;
  /** Removes the field from the page. */
  destroy(): void;
}

export interface MathFieldOptions {
  latex: string;
  readOnly: boolean;
  /** The accessible name of the field. */
  label: string;
  /** Called with the new LaTeX when the person changes it in the field. */
  onInput(latex: string): void;
  /** Called when the person presses Escape in the field (the field would otherwise keep it). */
  onEscape(): void;
}

/**
 * The math editor's port (FE-070; 02 §2). The visual field is a third-party piece that registers
 * global custom elements, so it is loaded on demand by `mount` and by nothing earlier. The limits
 * and the confirmation are the core's: a source over a limit is not committed, and the answer to
 * `confirm` waits for the document service, which may reject the source (the math gate).
 */
export interface MathEditorService {
  /** The last request to open the editor on an equation, or null. */
  readonly request: ReadView<EquationEditRequest | null>;
  /** The equation the person selected in the document, or null. */
  readonly selected: ReadView<EquationRef | null>;
  /** Asks to open the editor on the selected equation (a command). False when none is selected. */
  edit(): boolean;
  /** Selects the equation at `pos` again, as the editor closes, so that focus returns to it. */
  select(pos: number): boolean;
  /** Whether this person may change the equation at `pos` now, and why not. */
  access(pos: number): { readonly canEdit: boolean; readonly reason?: string };
  /** The limits of a source (I7; 09 §6.3). */
  readonly limits: { readonly length: number; readonly depth: number };
  /** The limit a source breaks, or null. */
  check(latex: string): 'too-long' | 'too-deep' | null;
  /** Stores the source as one commit and waits for the service's answer. */
  confirm(pos: number, latex: string): Promise<EquationOutcome>;
  /** Loads the visual field and puts it into `container`; rejects when it cannot be loaded. */
  mount(container: HTMLElement, options: MathFieldOptions): Promise<MathFieldHandle>;
}

/** A person of a source: family and given name, or one literal name (CSL). */
export interface SourcePerson {
  readonly family?: string;
  readonly given?: string;
  readonly literal?: string;
}

/**
 * The attributes of a source by their CDM names (`kind`, `title`, `authors`, `issued`,
 * `containerTitle`, `doi`, `url` and the other CSL variables of `source_def`). Text, a list of
 * people, or null where the attribute is not set.
 */
export type SourceValues = Readonly<Record<string, string | readonly SourcePerson[] | null>>;

export interface SourceSummary {
  readonly id: string;
  readonly values: SourceValues;
  /** The text of each block that cites the source, in document order. */
  readonly citedAt: readonly { readonly excerpt: string }[];
}

export type SourceChangeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `invalid` names the attributes whose value its grammar refuses (I11). */
      readonly reason:
        'read-only' | 'duplicate' | 'not-defined' | 'no-change' | 'cited' | 'invalid';
      readonly fields?: readonly string[];
    };

/**
 * The sources of the document and the changes an author may make to them (UX-103). A change is a
 * commit to the source definition through the log; it needs `structure` (07 §4), which `canChange`
 * reports. Citing an existing source is a change of the text and follows the text's permissions.
 */
export interface SourcesService {
  readonly list: ReadView<readonly SourceSummary[]>;
  readonly canChange: ReadView<boolean>;
  /** The attributes (and `id`) whose value its grammar refuses; empty when all pass. */
  check(id: string | null, values: SourceValues): readonly string[];
  add(id: string, values: SourceValues): SourceChangeResult;
  update(id: string, values: SourceValues): SourceChangeResult;
  remove(id: string): SourceChangeResult;
  /** Whether a citation of an existing source can be inserted at the caret. */
  canCite(): boolean;
  /** Inserts a citation of the source at the caret; false where it cannot. */
  cite(id: string): boolean;
}

export type FieldChangeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'read-only' | 'not-found' | 'no-change' | 'invalid';
      /** For `invalid`: the properties whose value is refused; empty when the core names none. */
      readonly properties?: readonly string[];
    };

/**
 * The properties of the document's form fields and the changes an author may make to them
 * (FRW-073; 12 §3.2). A change is a commit of attribute changes through the log; it needs `edit`
 * where the field is, which `canChange` reports.
 */
export interface FieldPropertiesService {
  /** The form fields of the document in order; labels and keys are document content. */
  readonly fields: ReadView<
    readonly { readonly id: string; readonly key: string; readonly label: string }[]
  >;
  /** The field the person selected in the document, or null. */
  readonly selected: ReadView<string | null>;
  /** The field's properties as they are now; null when the field is gone. */
  read(id: string): FieldDraft | null;
  /** Whether this person may change the field's properties now. */
  canChange(id: string): boolean;
  /** The workflow's state when the document is in one (`sent`, `in_progress`, ...); else null. */
  workflow?(): string | null;
  apply(id: string, patch: Partial<FieldDraft>): FieldChangeResult;
}

/** A role of the document as the roles manager and the legend show it (FRW-074; 12 §3.1). */
export interface RoleSummary {
  readonly id: string;
  /** The role's name: document content. */
  readonly name: string;
  readonly color: string;
  /** Position among the document's roles, in definition order; the icon is derived from it. */
  readonly order: number;
  /** The fields assigned to the role, in document order; labels are document content. */
  readonly fields: readonly { readonly id: string; readonly label: string }[];
}

export type RoleChangeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'read-only'
        | 'duplicate'
        | 'not-defined'
        | 'no-change'
        | 'no-feature'
        | 'invalid'
        | 'in-use';
      /** For `invalid`: the attributes (`name`, `color`) whose value is refused. */
      readonly fields?: readonly string[];
    };

/**
 * The roles of the document and the changes an author may make to them (FRW-074). A change is a
 * commit to the role definition through the log; it needs `structure` (07 §4), which `canChange`
 * reports. A role that fields are assigned to is not deleted (I13): `remove` answers `in-use`, and
 * the role's `fields` are the references to show.
 */
export interface RolesService {
  readonly list: ReadView<readonly RoleSummary[]>;
  readonly canChange: ReadView<boolean>;
  add(values: { readonly name: string; readonly color: string }): RoleChangeResult;
  update(id: string, values: { readonly name?: string; readonly color?: string }): RoleChangeResult;
  remove(id: string): RoleChangeResult;
}

/** One group of editing sessions, or one named version, as the history pane lists it (HIS-008). */
export type HistoryPaneItem =
  | {
      readonly kind: 'group';
      readonly id: string;
      /** The day, as the service computed it (`YYYY-MM-DD`). */
      readonly day: string;
      readonly from: string;
      readonly to: string;
      /** Identifiers of the people in the group; names come from `resolveUsers` (UX-025). */
      readonly authors: readonly string[];
      readonly changes: number;
      readonly origins: readonly string[];
    }
  | {
      readonly kind: 'version';
      readonly id: string;
      readonly name: string;
      readonly note?: string | null;
      readonly creator: string;
      readonly time: string;
      readonly seq: number;
    };

/** What the pane asks for: the filters of HIS-009 criterion 2 and an opaque cursor. */
export interface HistoryPaneQuery {
  readonly namedOnly: boolean;
  readonly region: string | null;
  readonly field: string | null;
  readonly user: string | null;
  readonly cursor: string | null;
}

export interface HistoryPaneResult {
  readonly items: readonly HistoryPaneItem[];
  readonly nextCursor: string | null;
  /** True for a reader who sees named versions only (HIS-024); the pane then says why. */
  readonly namedOnly: boolean;
}

/** A choice the filters offer: a region, a field or a person (HIS-009 criterion 2). */
export interface HistoryChoice {
  readonly id: string;
  readonly label: string;
}

export interface HistoryChoices {
  readonly regions: readonly HistoryChoice[];
  readonly fields: readonly HistoryChoice[];
  readonly people: readonly HistoryChoice[];
}

/**
 * The host's history port. The element adapts the document service's `/history` and `/versions`
 * routes to this shape; the pane itself never calls the network.
 */
export interface HistoryPort {
  list(query: HistoryPaneQuery): Promise<HistoryPaneResult>;
  choices(): Promise<HistoryChoices>;
  /** The host's directory (UX-025); null for an identifier the host does not know, such as an erased person. */
  readonly resolveUsers?: ResolveUsers;
}

/**
 * What a new comment thread would be created on (UX-028; 05 §6.2 `target`; 07 §12): a text range
 * with the sequence it was read at, or one block (a figure, a table or an equation), and the
 * capabilities of every scope the selection covers.
 */
export interface CommentAnchor {
  readonly selection:
    | {
        readonly kind: 'range';
        readonly from: number;
        readonly to: number;
        readonly baseSeq: number;
      }
    | { readonly kind: 'block'; readonly id: string };
  readonly scopes: ReadonlyArray<readonly Capability[]>;
}

/**
 * A piece of a comment body: typed text, or a mention that holds only the principal identifier
 * (UX-031; 07 §1). The body format is not defined in 03 or 05; this is the editor's working shape.
 */
export type CommentBodyPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly principal: string };

/** The request for `POST /documents/{id}/threads` (05 §6.2): the target and the first comment. */
export interface ThreadRequest {
  readonly target:
    | { readonly range: { readonly from: number; readonly to: number; readonly baseSeq: number } }
    | { readonly block: string };
  readonly body: readonly CommentBodyPart[];
}

/** The answer to a thread request: the new thread, or the service's error code (05 §5.8). */
export type ThreadOutcome =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly code: string };

/**
 * One thread as the comments pane lists it (UX-030 criterion 1; 05 §6.2): what the core reports for
 * the threads this reader may see, in any order. `position` is the document order.
 */
export interface ThreadSummary {
  readonly id: string;
  readonly position: number;
  readonly state: 'open' | 'resolved';
  readonly author: string;
  readonly createdAt: string;
  readonly replyCount: number;
  readonly assignee: string | null;
  readonly target: ThreadRequest['target'];
  /** The commented text, when the target is a range and the text is still there. */
  readonly excerpt: string | null;
  /** The block kind (figure, table, equation, ...), when the target is a block. */
  readonly blockKind: string | null;
}

/** Comment threads (05 §6.2). Creating one is a control-plane request, never a commit (13 §5). */
export interface ThreadsService {
  /** The anchor for the current selection; null when nothing that can carry a thread is selected. */
  anchor(): CommentAnchor | null;
  /** The threads the document holds now, open or resolved (the 5,000 limit of UX-028). */
  count(): number;
  /** The threads the reader may see, for the comments pane (UX-030). */
  list(): readonly ThreadSummary[];
  /** Creates a thread with its first comment. A refusal resolves with its code; it never throws for one. */
  create(request: ThreadRequest): Promise<ThreadOutcome>;
}

export type PaneName = 'outline';

/** Panes the header opens (13 §3); each loads on demand (02 §2). */
export type HeaderPaneName = 'comments' | 'catch-up' | 'history';

/**
 * A person from the host's directory (05 §8.1 `resolveUsers`; 13 §5). The same shape as
 * `UserInfo` in `@docedit/protocol` (ports/host.ts, S6 decision G92), repeated here so that `ui`
 * does not depend on the protocol package.
 */
export interface UserInfo {
  id: string;
  name: string;
  avatarUrl?: string;
}

/** Resolves identifiers to people, in the order given; null for an identifier the host does not know. */
export type ResolveUsers = (ids: readonly string[]) => Promise<ReadonlyArray<UserInfo | null>>;

/** A query of the host's directory (05 §8.1 `searchPrincipals`; the shape S6 fixed, G92). */
export interface PrincipalQuery {
  text: string;
  docId: string;
  purpose: 'grant' | 'mention' | 'participant';
  kinds?: ReadonlyArray<'user' | 'group'>;
  limit?: number;
}

/** A user or group from the host's directory. */
export interface PrincipalInfo {
  /** `user:<sub>` or `group:<id>` (07 §1). */
  principal: string;
  name: string;
  detail?: string;
}

/** Finds users and groups in the host's directory. */
export type SearchPrincipals = (query: PrincipalQuery) => Promise<PrincipalInfo[]>;
