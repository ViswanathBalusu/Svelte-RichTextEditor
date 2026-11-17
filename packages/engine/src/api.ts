/**
 * The document API (02 §5.1; ADR 0003; FE-026): what the user interface, extensions and host code
 * use to read and change a document. Plain data, named commands, queries and read-only views only:
 * no ProseMirror type appears here (a test checks this file's imports), which is what lets the
 * editing core be replaced later.
 *
 * `outline()` of 02 §5.1 is `outline.get()`: the outline is a read view, so that the interface can
 * subscribe to it.
 */
import type { StepJson } from '@docedit/authority';
import type {
  Access,
  Limits,
  PresencePeers,
  PresenceUpdate,
  SyncChannel,
  SyncPort,
  Unsubscribe,
} from '@docedit/protocol';
import type { ReadView } from './read-value.ts';
import type { TrimReport } from './trim.ts';
import type { Clock } from './sync/session.ts';
import type { JournalPort } from './sync/journal.ts';

/** A CDM document as stored and transferred (03 §2). */
export interface CdmEnvelope {
  cdm: number;
  requires: string[];
  doc: unknown;
}

/**
 * The named commands of the editing core. The command registry of 13 §4 (UX-003) maps its entries
 * onto these; `enabled` and `active` come from `queryCommand`.
 */
export type CommandName =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'smallCaps'
  | 'allCaps'
  | 'superscript'
  | 'subscript'
  | 'selectAll'
  | 'insertFootnote'
  | 'editHeader'
  | 'undo'
  | 'redo'
  | 'paragraphStyle'
  | 'fontFamily'
  | 'fontSize'
  | 'color'
  | 'highlight'
  | 'lang'
  | 'charStyle'
  | 'clearFormatting'
  | 'applyList'
  | 'removeList'
  | 'listLevelUp'
  | 'listLevelDown'
  | 'restartNumbering'
  | 'continueNumbering'
  | AuthoringCommandName
  | TableCommandName
  | 'setTableStyle'
  | 'sortTableRows'
  | 'resizeFigure'
  | 'setFigureLayout'
  | 'increaseIndent'
  | 'decreaseIndent'
  | 'nextEditableRegion'
  | 'markRegion'
  | 'setRegionPolicy'
  | 'renameRegion';

/**
 * The authoring commands that take arguments (FE-053, FE-070, FE-133 to FE-137, FE-140). Each one
 * asks the region guard's `canWrite` for the scope it would change, so it is unavailable where the
 * user may not change that scope (07 §5.3, §7).
 */
export type AuthoringCommandName =
  | 'insertCitation'
  | 'addLink'
  | 'insertBookmark'
  | 'followInternalLink'
  | 'setPageSetup'
  | 'insertBreak'
  | 'insertSectionBreak'
  | 'insertField'
  | 'insertToc'
  | 'insertSymbol'
  | 'insertCaption'
  | 'insertReference'
  | 'setEquationLatex';

/**
 * For `insertField` (FE-136): a page number, the page count, a date or the title. `page` and
 * `pageCount` go in a header or footer story, so `story` names the story and the caret in it as the
 * story's sub-editor counts positions (the story node is that editor's document). `date` takes the
 * server instant and the workflow's zone (03 §7); the core reads no clock.
 */
export interface FieldArgs {
  kind: 'page' | 'pageCount' | 'date' | 'title' | 'text' | 'number' | 'checkbox' | 'choice';
  format?: string | null;
  date?: { instant: string; timeZone: string };
  title?: string | null;
  story?: { id: string; pos: number };
  /**
   * True for a form field (the palette of FRW-072): `date` is then the form field kind, not the
   * page date (proposed, ADR 0367).
   */
  form?: boolean;
}

/** One source of a citation (CDM-052; 03 §4.4): the optional parts are stored only when set. */
export interface CitationItemArgs {
  source: string;
  prefix?: string;
  suffix?: string;
  locator?: string;
  /** One of the CDM's locator labels (`LOCATOR_LABELS`); another value makes the command unavailable. */
  label?: string;
}

/** The `page_setup` attributes `setPageSetup` may change; lengths in twentieths of a point. */
export interface PageSetupArgs {
  paperSize?: 'A4' | 'Letter';
  width?: number;
  height?: number;
  orientation?: 'portrait' | 'landscape';
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  gutter?: number;
  headerDistance?: number;
  footerDistance?: number;
  columns?: number;
  columnGap?: number;
  differentFirstPage?: boolean;
  differentOddEven?: boolean;
  pageNumberStart?: number | null;
  pageNumberFormat?: 'decimal' | 'lowerRoman' | 'upperRoman' | 'lowerLetter' | 'upperLetter';
  watermark?: string | null;
}

/** The table structure commands at the caret (FE-040; 03 §4.3). */
export type TableCommandName =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteRow'
  | 'deleteColumn'
  | 'deleteTable'
  | TableSpanCommandName;

/**
 * Merge and split of cells (FE-040 criterion 3; table-span.ts). `mergeCells` takes the rectangle in
 * `cells`; `splitCell` splits the merged cell at the caret.
 */
export type TableSpanCommandName = 'mergeCells' | 'splitCell';

/** A rectangle of grid slots of the caret's table, zero based and inclusive at both ends. */
export interface CellRectArgs {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface CommandArgs {
  /** For `mergeCells` (FE-040): the rectangle of whole cells to merge, in grid rows and columns. */
  cells?: CellRectArgs;
  /** For `paragraphStyle`: the identifier of a paragraph style the document defines. */
  style?: string;
  /** For `setTableStyle` (FE-131): a table style the document defines, or `null` to clear it. */
  tableStyle?: string | null;
  /** For `sortTableRows` (FE-131): the direction; `sortColumn` is the column, default the caret's. */
  sortDirection?: 'ascending' | 'descending';
  sortColumn?: number;
  /** For `resizeFigure` and `setFigureLayout` (FE-132): the figure's position in the document. */
  figurePos?: number;
  /** For `resizeFigure`: twips; the aspect ratio is kept unless `lockAspect` is false. */
  figureSize?: { width?: number; height?: number; lockAspect?: boolean };
  /** For `setFigureLayout`: `here` or `float`, and the alignment (null clears it). */
  figureLayout?: { placement?: 'here' | 'float'; align?: 'start' | 'center' | 'end' | null };
  /**
   * For the character value commands (FE-128): the value to set, or `null` to remove it. `fontFamily`
   * is a family name, `fontSize` an integer in twentieths of a point, `color` `#RRGGBB`, `highlight`
   * one of the CDM's highlight colours, `lang` a BCP 47 tag, `charStyle` a character style identifier.
   */
  fontFamily?: string | null;
  fontSize?: number | null;
  color?: string | null;
  highlight?: string | null;
  lang?: string | null;
  charStyle?: string | null;
  /** For `applyList` (FE-130): the identifier of the numbering definition the document defines. */
  numberingId?: string;
  /** For `insertCitation`: the sources to cite (1 to 32) and the citation mode (`normal` by default). */
  citation?: {
    items: readonly CitationItemArgs[];
    mode?: 'normal' | 'narrative' | 'suppressAuthor';
  };
  /** For `addLink` and `followInternalLink`: the link target (I9). */
  href?: string;
  /** For `addLink`: the link's title. */
  title?: string;
  /** For `setRegionPolicy` (PRM-036): the region's identifier and its new policy. */
  region?: string;
  policy?: 'inherit' | 'restricted';
  /** For `insertBookmark`: the bookmark's name, unique in the document. */
  name?: string;
  /** For `setPageSetup`: the identifier of the `page_setup` definition and the changes. */
  pageSetup?: { id: string; changes: PageSetupArgs };
  /** For `insertBreak`: the kind of break (03 §4.4). */
  breakKind?: 'line' | 'page' | 'column';
  /** For `insertSectionBreak`: how the new section starts (03 §4.2). The core names the new nodes. */
  section?: { start: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' };
  /** For `insertField`. */
  field?: FieldArgs;
  /** For `insertToc`: the outline levels (1 to 9) and `headings` or a caption sequence (03 §4.3). */
  toc?: { minLevel?: number; maxLevel?: number; of?: string };
  /** For `insertSymbol`: one character (09 §3.2). */
  symbol?: string;
  /** For `insertCaption`: the identifier of the figure that gets a numbered caption (FE-134). */
  figure?: string;
  /** For `insertReference`: the target (`node:`, `bookmark:` or `eq:`) and the field's format. */
  reference?: { target: string; format?: string | null };
  /**
   * For `setEquationLatex` (FE-070): the position of the `equation` or `equation_block` node in the
   * document, and the LaTeX source the user confirmed.
   */
  equation?: { pos: number; latex: string };
}

/**
 * Why a command is unavailable, where the core can say (FE-040):
 * - `read-only`: the document, the mode or a lock lets no change through;
 * - `no-access`: the user may not change the scope the command would change (`canEdit`);
 * - `not-in-table`: the caret is not in a table cell;
 * - `merged-cells`: the table has merged cells, which the row and column commands do not handle
 *   until merge and split are built;
 * - `column-limit`: the table already has 63 columns, the most a table may have (03 §8, I7);
 * - `last-row`, `last-column`: the change would leave the table with no row or no column;
 * - `scheme-not-allowed`: a link target whose scheme I9 does not allow (FE-133);
 * - `malformed-link`: a link target that is not a URL or an in-document target `#name` (I9);
 * - `bad-bookmark-name`: a bookmark name that does not follow the CDM's pattern (FE-133);
 * - `duplicate-bookmark`: a bookmark name the document already uses (FE-133).
 */
export type CommandUnavailable =
  | 'read-only'
  | 'no-access'
  | 'not-in-table'
  | 'merged-cells'
  | 'column-limit'
  | 'last-row'
  | 'last-column'
  | 'bad-rect'
  | 'span-crosses'
  | 'empty-row'
  | 'single-cell'
  | 'not-merged'
  | 'suggestion'
  | 'scheme-not-allowed'
  | 'malformed-link'
  | 'bad-bookmark-name'
  | 'duplicate-bookmark'
  | 'unknown-style'
  | 'no-column'
  | 'not-a-figure'
  | 'bad-size'
  | 'bad-placement'
  | 'float-in-cell';

export interface CommandState {
  enabled: boolean;
  active: boolean;
  /**
   * Why the command is unavailable. Present only when `enabled` is false and the core knows the
   * reason; today that is the table commands (FE-040) and the authoring commands (FE-133, FE-137,
   * FE-140). Other commands leave it out.
   */
  reason?: CommandUnavailable;
}

export interface SelectionSummary {
  empty: boolean;
  scope: 'body' | 'region';
  /** The region's title, when the selection is in a region. */
  region: string | null;
  /** The paragraph style at the selection, or null when the selected paragraphs differ. */
  style: string | null;
  marks: string[];
}

/** The shape of the `de-selection` detail (05 §8.1): a DEP scope identifier and a block. */
export interface SelectionScope {
  /** `body`, `region:<id>`, `story:<id>` (05 §5.3). */
  scope: string;
  /** The identifier of the block the selection starts in, or null. */
  blockId: string | null;
}

export interface PanelInfo {
  kind: 'footnote' | 'story';
  id: string;
  label: string;
}

export interface OutlineItem {
  /** The paragraph's identifier. */
  id: string;
  level: number;
  text: string;
}

export interface StyleInfo {
  id: string;
  name: string;
  /** Outline level (1 to 9) when paragraphs in this style are headings. */
  outlineLevel: number | null;
}

/** The save indicator of 02 §2.2 and `de-status.sync` (05 §8.1). */
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'readonly';

/** Capabilities of 07 §1. */
export type Capability = 'view' | 'comment' | 'suggest' | 'edit' | 'fill' | 'structure' | 'manage';

/**
 * What limits editing where the selection is (07 §4, §7), as the shell names it (ADR 0041). The core
 * reports what it can tell from the `access` object: `role`, `region`, `lease`, `unlisted`, `hidden`,
 * and `locked` after a `read_only` rejection; the others need the region and document states.
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

/** Effective access where the selection is (07 §4). */
export interface AccessSummary {
  /** The DEP scope (05 §5.3); for a selection across scopes, the one that limits it most. */
  readonly scope: string;
  readonly caps: readonly Capability[];
  /** What limits it when `edit` is missing; null otherwise. */
  readonly limit: AccessLimit | null;
}

/** Connection and save state: the `detail` of `de-status` (05 §8.1). */
export interface StatusSummary {
  readonly connection: 'online' | 'reconnecting' | 'offline';
  readonly sync: SaveState;
}

/**
 * Another session in the document (05 §5.4 `presence.state`), limited to what this reader may see
 * (ADR 0019): never a peer whose selection is in a hidden region. Not this session.
 */
export interface PresencePeerInfo {
  readonly session: string;
  /** The user identifier; the shell resolves names through the host's `resolveUsers`. */
  readonly user: string;
  /** The name the service reported, the fallback when the host gives none. */
  readonly name: string | null;
  readonly status: 'active' | 'idle';
}

/**
 * A peer with its selection as positions in the visible document of this reader (SYN-036): the
 * confirmed positions mapped through the reader's own unconfirmed steps. Every position lies inside
 * the visible document, so a caret drawn from it is never inside text the reader does not have.
 */
export interface PeerSelectionInfo extends PresencePeerInfo {
  readonly anchor: number;
  readonly head: number;
}

/**
 * A peer's caret and selection as rectangles in CSS pixels relative to the element the body view is
 * mounted in (ui `PeerCaret`, UX-027). `caret` is null when the view gives no position for it.
 */
export interface PeerCaretInfo extends PresencePeerInfo {
  readonly caret: { x: number; y: number; width: number; height: number } | null;
  readonly selection: readonly { x: number; y: number; width: number; height: number }[];
}

/** Counts shown on header buttons (13 §3); an absent member is unknown and shows no count. */
export interface ShellCounts {
  /** Open comment threads. */
  readonly comments?: number;
  /** Changes and comment activity since the reader's last visit (08 §10). */
  readonly catchUp?: number;
}

/** The presence port of 05 §8.3 (`backend.presence`), as the core uses it. */
export interface PresencePortLike {
  update(docId: string, update: PresenceUpdate): void;
  onPeers(docId: string, cb: (state: PresencePeers) => void): Unsubscribe;
}

/** The accessible names of the surfaces the core renders, in the interface's locale (UX-064). */
export interface CoreLabels {
  readonly body: string;
  readonly footnote: string;
  readonly story: string;
}

/** Named queries of the document API for the command registry (13 §4; ADR 0041). */
export type CoreQueryName =
  | 'canEditSelection'
  | 'canUndo'
  | 'canRedo'
  | 'isBold'
  | 'isItalic'
  | 'canInsertFootnote'
  | 'hasHeader'
  | 'canInsertField'
  // PRM-033 and FE-044 criterion 5: the selection's whole body blocks may become a region.
  | 'canMarkRegion';

/** `de-status.connection` (05 §8.1), plus `detached` before any channel is attached. */
export type ConnectionState = 'detached' | 'online' | 'reconnecting' | 'offline';

/**
 * Why the guard refused a local change: a scope without a write capability (`scope`), a region or
 * section break change without `structure`, a policy change without `manage`, read-only mode, a
 * placeholder or redacted value of a projection (ADR 0019), an invariant the change would break
 * (`invariant`, I10: a footnote inside a footnote or a caption), a step type the authority never
 * accepts (`step`, 04 §4), or a change suggestion mode cannot record as suggestions (`suggestion`:
 * a block change, FE-044, or no user identity to name in the marks; FE-041, FE-042).
 */
export type RefusalReason =
  | 'scope'
  | 'structure'
  | 'manage'
  | 'read-only'
  | 'placeholder'
  | 'redacted'
  | 'invariant'
  | 'step'
  | 'no-copy'
  | 'no-print'
  | 'suggestion';

/** The last local change the region guard refused (FE-036): `n` counts refusals. */
export interface RefusalNotice {
  n: number;
  reason: RefusalReason;
  /** DEP scope identifiers that blocked it. */
  scopes: string[];
  /** The number of suggestions a suggestion command skipped, when it counts them (FE-047 criterion 6). */
  count?: number;
}

/** One piece of work that was set aside (02 §2.2; 04 §8). */
export interface RecoveredItem {
  /** The rejection code, or `rebase`, `reload`, `reset`, `stale`. */
  reason: string;
  commit: string | null;
  /** The text it inserted. */
  text: string;
  seq: number;
  /**
   * For a `permission_denied` rejection: the scope whose change was refused, as the shell names it
   * (`body`, `region:<id>`, `defs`, `story:<id>`, `doc`); a `field:<id>` scope of the rejection is
   * given as the scope the field lies in (PRM-024; 07 §9). Absent for any other reason.
   */
  scope?: string | null;
  /** Every scope the rejection named, mapped as `scope` is, in the rejection's order (PRM-024). */
  scopes?: string[];
  /**
   * Who changed the permissions, when known: the author of the last control commit before the
   * rejection, unless the server authored it as `system` (04 §10; 07 §9; PRM-024). Null when unknown.
   */
  changedBy?: string | null;
  /** When that control commit was stored (its `serverTime`), or null when unknown. */
  changedAt?: string | null;
}

/** Work set aside so far: `de-recovered-edits` carries `count` (05 §8.1). */
export interface RecoveredEdits {
  count: number;
  items: RecoveredItem[];
}

/**
 * Something the core could not do, for `de-error` (05 §8.1): `n` counts problems. Fatal ones stop
 * the sync client: a reload or reset brought content of another CDM version or with a feature this
 * build does not support (`unsupported_cdm`, `unsupported_feature`; 03 §2).
 */
export interface CoreProblem {
  n: number;
  code: string;
  message: string;
  fatal: boolean;
}

/** The sync client's state as plain data (FE-033 criterion 7). */
export interface SyncSummary {
  seq: number;
  incarnation: string;
  /** The in-flight commit's identifier. */
  inflight: string | null;
  /** Local steps not yet sent. */
  queued: number;
}

/** What the journal (FE-009) keeps: the confirmed content and the unconfirmed work. */
export interface SyncSnapshot {
  seq: number;
  incarnation: string;
  view: string | null;
  confirmed: CdmEnvelope;
  inflight: { id: string; base: number; steps: StepJson[] } | null;
  queue: StepJson[];
}

export interface AttachOptions {
  /** The `seq` and incarnation of the content the core holds (from `loadContent`). */
  seq: number;
  incarnation: string;
  /** The `view` of the `ch.opened` the content came from, if any (ADR 0019; D28). */
  view?: string;
  /**
   * Lets the core reopen the channel with a resume (gaps, timeouts, closes) and load content for a
   * reload or a reset. Without it, any of these takes the core offline.
   */
  sync?: Pick<SyncPort, 'open' | 'loadContent'>;
  /** `welcome.limits` (`backend.auth.session.limits`). */
  limits?: Partial<Limits>;
  /** Batching bound for local edits in ms (04 §8: 100 ms target; the default). */
  batchMs?: number;
  newId?: () => string;
  clock?: Clock;
  /** Delays between attempts after refusals and failed reopens, doubling from `minMs` to `maxMs`. */
  retry?: { minMs: number; maxMs: number };
  /** `backend.presence`: the core publishes the selection and lists the peers (04 §11). */
  presence?: PresencePortLike;
  /** This session's identifier (`welcome.session`), so that it is never listed as a peer. */
  session?: string;
  /**
   * The user's identifier (`welcome.user.id`, the token's `sub`): the `user` that suggestion marks
   * name (03 §5; FE-042). It replaces `CoreConfig.user`.
   */
  user?: string;
  /** The features both sides support (`backend.features`), for the `features` view. */
  features?: readonly string[];
  /** The recovery journal (FE-008): commits are written here before they are sent. */
  journal?: JournalPort;
  /** The assets port: a pasted picture is uploaded through it (FE-053; 10 §3.1). */
  assets?: AssetsPort;
  /** The proofing port (13 §6.1; UX-041): the core checks spelling and grammar through it. */
  proofing?: ProofingPort;
}

/** The find state: `n of m` is `current` (1-based, null before a navigation) of `count` (FE-059). */
export interface FindState {
  readonly query: string;
  readonly count: number;
  readonly current: number | null;
}

/** One match for a navigation pane (FE-059 criterion 6): its place and the text around it. */
export interface FindResult {
  /** 0-based position in the match list. */
  readonly index: number;
  readonly blockId: string | null;
  readonly scope: string;
  readonly before: string;
  readonly text: string;
  readonly after: string;
}

/**
 * What a replace did (FE-060): `replaced` matches changed, `skipped` matches were left alone
 * because the user may not change their scope or the guard refused the change.
 */
export interface ReplaceReport {
  readonly replaced: number;
  readonly skipped: number;
}

/**
 * The editing mode (the `mode` attribute, 02 §5.2; FE-029): `edit`, `review` (suggestion mode, FE-041),
 * `view` (no changes) and `fill` (the body is read-only; field values are FRW's, FRW-076, FRW-079).
 */
export type EditMode = 'edit' | 'review' | 'view' | 'fill';

/**
 * Suggestion mode at the caret (FE-041 criterion 5; 02 §5.2): whether a change there is recorded as
 * suggestions, whether the user cannot switch that off, and why it is on (`rights`: `suggest` without
 * `edit`; `document-setting`: `settings.trackChanges` is `everyone`; `review-mode`: the mode is
 * `review`). `scope` is the DEP scope at the caret the answer is for.
 */
export interface SuggestionModeInfo {
  readonly on: boolean;
  readonly locked: boolean;
  readonly reason: 'rights' | 'document-setting' | 'review-mode' | null;
  readonly scope: string;
}

/** The mode the host asked for, and the one in force for this user (FE-029 criterion 4). */
export interface ModeState {
  /** What the host set. The core never changes it. */
  readonly requested: EditMode;
  /** The most restrictive mode the access allows; it is what the core enforces. */
  readonly effective: EditMode;
}

export type { CdmFragment, CdmJsonNode } from './cdm-fragment.ts';
export type * from './extension-api-types.ts';
import type { ExtensionApiOptions, ExtensionDocumentApi } from './extension-api-types.ts';

/**
 * The outcome of `insertContent` (FE-027). `unsupported`: another CDM version, or features the
 * document does not list in `requires` (`missing`) or this build lacks; `invalid`: the fragment fails
 * the schema; `refused`: the selection is in a scope the user may not change, or the guard refused the
 * change (`refusal` says why). Nothing changes unless the result is `ok`.
 */
export type InsertResult =
  | {
      readonly ok: true;
      /**
       * Pasted pictures (FE-053): the uploads under way, one result per picture, in order. The guard
       * was asked before any upload started; each picture is inserted when its upload completes.
       */
      readonly uploads?: Promise<readonly ImagePasteResult[]>;
    }
  | {
      readonly ok: false;
      readonly reason: 'unsupported' | 'invalid' | 'refused';
      readonly message: string;
      readonly missing?: readonly string[];
      readonly refusal?: RefusalReason;
    };

import type { CdmFragment } from './cdm-fragment.ts';
import type { ClipboardInput, ClipboardPayload, CutResult } from './clipboard.ts';
import type { AssetsPort, ImagePasteResult } from './image-paste.ts';
import type { ResolveAction, SuggestionReport, SuggestionTarget } from './suggestion-resolve.ts';
import type { MarkupView, SuggestionSpec } from './suggestion-markup.ts';
import type { ThreadRange } from './comment-ranges.ts';
import type { SectionWarning } from './breaks-sections.ts';
import type { SourceEdit, SourceEditOutcome, SourceInfo } from './source-edit.ts';
import type { LocatedFinding, ProofingClock, ProofingInfo, ProofingPort } from './proofing.ts';
import type { AssistantRequest, HostAttachment } from './assistant-context.ts';

export interface DocumentApi {
  readonly selection: ReadView<SelectionSummary>;
  /** The find state (FE-059): the query, the number of matches and the current one. */
  readonly findState: ReadView<FindState>;
  /** Spelling and grammar (UX-041): the state and the findings shown; `available` is false without a port. */
  readonly proofing: ReadView<ProofingInfo>;
  readonly panel: ReadView<PanelInfo | null>;
  readonly outline: ReadView<readonly OutlineItem[]>;
  /** The DEP `access` in force (`ch.opened`, then every `perm.changed`); null before any. */
  readonly permissions: ReadView<Access | null>;
  /** Effective access at the selection (the shell's `access`, ADR 0041). */
  readonly access: ReadView<AccessSummary>;
  readonly saveState: ReadView<SaveState>;
  readonly confirmedSeq: ReadView<number>;
  readonly connection: ReadView<ConnectionState>;
  /** `de-status`: connection and save state together. */
  readonly status: ReadView<StatusSummary>;
  readonly commands: ReadView<Readonly<Record<CommandName, CommandState>>>;
  /** Increases whenever a query's answer may have changed; notifies at most once per frame. */
  readonly revision: ReadView<number>;
  /** The document's base direction (`settings.dir`). */
  readonly direction: ReadView<'ltr' | 'rtl'>;
  readonly refusal: ReadView<RefusalNotice | null>;
  /** The requested and the effective editing mode (FE-029). */
  readonly mode: ReadView<ModeState>;
  /** Suggestion mode at the caret, and why (FE-041). */
  readonly suggestion: ReadView<SuggestionModeInfo>;
  /** The last deletion that kept protected content (FE-037): `n` counts them. */
  readonly trimmed: ReadView<TrimReport | null>;
  readonly recovered: ReadView<RecoveredEdits>;
  readonly syncSummary: ReadView<SyncSummary>;
  /** The last problem the sync client reported, for `de-error`. */
  readonly problem: ReadView<CoreProblem | null>;
  /** Other sessions this reader may see (04 §11; ADR 0019). */
  readonly presence: ReadView<readonly PresencePeerInfo[]>;
  /** Features both sides support (05 §1 rule 4); empty until a backend says. */
  readonly features: ReadView<readonly string[]>;
  /** Counts for the header buttons, as the host or the element sets them. */
  readonly counts: ReadView<ShellCounts>;
  /** Features the document lists in `requires` (03 §2). */
  readonly requires: readonly string[];
  /** The names `query` answers. */
  readonly queryNames: readonly CoreQueryName[];

  setFeatures(features: readonly string[]): void;
  setCounts(counts: ShellCounts): void;

  /** Answers a named query for the current selection; undefined for an unknown name. */
  query(name: string): boolean | undefined;
  /**
   * Why `query(name)` answered false, as a reason code the shell turns into its own words
   * (`reason.query.<code>`); null when the query is true or has no reason to give. For
   * `canMarkRegion`: `suggestion` (FE-044 criterion 5), `locked`, `nested`, `structure` or `blocks`.
   */
  queryReason(name: string): string | null;

  /** Runs a named command; false when it does not apply. */
  run(name: CommandName, args?: CommandArgs): boolean;
  /** `exec` of 05 §8.1: the same as `run`. */
  exec(name: CommandName, args?: CommandArgs): boolean;
  queryCommand(name: CommandName, args?: CommandArgs): CommandState;
  activeMarks(): string[];
  selectionScope(): SelectionScope;
  /** Whether the user may change a scope (`body`, `region:<id>`, `defs`, `story:<id>`, `doc`). */
  canEdit(scope: string): boolean;
  paragraphStyles(): StyleInfo[];
  /** The visible document. */
  getContent(): CdmEnvelope;
  /** The confirmed document and its `seq` (04 §7). */
  confirmedContent(): CdmEnvelope & { seq: number };
  syncSnapshot(): SyncSnapshot;
  /** Sets the access the region guard uses (the core also takes it from an attached channel). */
  setAccess(access: Access | null): void;
  /** Hosts the sync client on a document channel; returns the function that detaches it. */
  attach(channel: SyncChannel, opts: AttachOptions): () => void;
  /** Resolves when nothing is in flight or queued; rejects at the timeout (04 §8). */
  flush(opts?: { timeoutMs?: number }): Promise<void>;
  openFootnote(id: string): void;
  /** Opens the story's panel. Returns false, and opens nothing, when the user may not change the story (07 §7). */
  openStory(id: string): boolean;
  closePanel(): void;
  focus(): void;
  destroy(): void;

  /**
   * Finds `query` in the body and highlights nothing itself: the matches are the core's and the
   * view draws them (FE-059). An empty query clears the find. Changes no document.
   */
  findText(query: string): FindState;
  /** Moves the selection to the next match, wrapping at the end; false when there is none. */
  findNext(): boolean;
  /** Moves the selection to the previous match, wrapping at the start; false when there is none. */
  findPrevious(): boolean;
  clearFind(): void;
  /** The matches with their block identifiers and surrounding text (FE-059 criterion 6). */
  findResults(): FindResult[];
  /** Replaces the current match through the region guard (FE-060). */
  replaceCurrent(text: string): ReplaceReport;
  /** Replaces every match the user may change, in one change; reports the counts (FE-060). */
  replaceAll(text: string): ReplaceReport;
  /** The request for the assistant port: selection, surrounding blocks, outline and host attachments (UX-047). */
  assistantRequest(
    task: AssistantRequest['task'],
    prompt: string,
    attachments?: readonly HostAttachment[],
  ): AssistantRequest & { readonly omitted: number };
  /** Gives the core the proofing port (13 §6.1); returns the function that detaches it (UX-041). */
  attachProofing(
    port: ProofingPort,
    opts?: { docId?: string; clock?: ProofingClock; debounceMs?: number },
  ): () => void;
  /** The findings that hold for the document now, with their positions (the view draws them). */
  proofingFindings(): readonly LocatedFinding[];
  /** The identifier of the finding the last navigation chose, while it is shown. */
  proofingCurrentId(): string | null;
  /** Moves the selection to the next (or previous) finding, wrapping; false when there is none. */
  proofingStep(direction?: 1 | -1): boolean;
  /** Applies one suggestion of a finding as an ordinary edit through the guards (UX-042). */
  applyFinding(id: string, suggestion?: number): boolean;
  /** Whether the finding has a suggestion and the user may change its scope. */
  canApplyFinding(id: string): boolean;
  /** Hides a finding: once (until its text changes) or everywhere (for the session). */
  ignoreFinding(id: string, everywhere?: boolean): boolean;
  /** Adds the finding's text to the port's custom dictionary; false where the port has none. */
  addFindingToDictionary(id: string): Promise<boolean>;
  /** The custom dictionary's words for a language; null where the port has no dictionary. */
  dictionaryWords(lang: string): Promise<string[] | null>;
  /** Removes a word from the custom dictionary. */
  removeDictionaryWord(word: string, lang: string): Promise<boolean>;
  /** Pastes plain text at the selection, one paragraph per line (FE-052); false when refused. */
  pastePlainText(text: string): boolean;
  /** The clipboard payload of the selection (FE-050): `text/html` with the fragment, and `text/plain`. Null for an empty selection; changes nothing. */
  copySelection(): ClipboardPayload | null;
  /** Copies the selection, then deletes it through the guard (FE-050 criterion 2). */
  cutSelection(): CutResult;
  /** Pastes clipboard data: an embedded fragment, else plain text, else pictures (FE-051 to FE-053). */
  pasteFromClipboard(data: ClipboardInput): InsertResult;

  /** Sets the requested mode, the `mode` attribute of the host (FE-029). Keeps unconfirmed work. */
  setMode(mode: EditMode): void;
  /** The selection as a CDM fragment (FE-027); an empty selection gives an empty fragment. */
  getSelectionContent(): CdmFragment;
  /** Inserts a fragment at the selection through the same guards as typing (FE-027). */
  insertContent(fragment: CdmFragment): InsertResult;
  /**
   * Accepts or rejects every suggestion in the target, or only `author`'s, as one commit (FE-047);
   * suggestions in a scope without `edit` are skipped and counted.
   */
  resolveSuggestions(
    action: ResolveAction,
    target?: SuggestionTarget,
    author?: string,
  ): SuggestionReport;

  /**
   * The range-based API for one extension (UX-053; 13 §7.1): ranges held and mapped, reads, writes
   * through the guards of typing, and events delivered after the change. See extension-api-types.ts.
   */
  extensionApi(options: ExtensionApiOptions): ExtensionDocumentApi;

  /** The decorations of the markup view `view` for the current document, as plain specs (FE-046). */
  markupDecorations(view: MarkupView): SuggestionSpec[];
  /** The client's copy of every thread's range, mapped through every change (FE-048). */
  readonly threadRanges: ReadView<readonly (ThreadRange & { readonly id: string })[]>;
  /** Sets a thread's range as the service reports it at `seq` (FE-048). */
  setThreadRange(threadId: string, range: { from: number; to: number }, seq: number): void;
  /** Removes a thread's range (the thread was deleted) (FE-048). */
  removeThreadRange(threadId: string): void;
  /** Preserved atoms whose fallback text holds the current query, which the find skipped (FE-139). */
  skippedPreservedFind(): number;
  /** Resolves once every journal write requested so far is durable (FE-011). */
  flushJournal(): Promise<void>;
  /** The continuous section breaks whose page setup changes a margin (FE-135 criterion 6). */
  sectionWarnings(): SectionWarning[];
  /** The document's sources in the order of its definitions, each with where it is cited (UX-103). */
  sources(): SourceInfo[];
  /**
   * Adds, changes or deletes a source definition (UX-103; CDM-052): a change of the definitions,
   * which needs `structure` (07 §4) and leaves as a commit. A cited source is not deleted (I4).
   * With `check`, only says whether the change would be made.
   */
  editSource(edit: SourceEdit, check?: boolean): SourceEditOutcome;
}
