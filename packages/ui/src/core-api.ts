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
import type {
  DataInput as AssistantDataInput,
  PromptStructure as AssistantPromptStructure,
} from './assistant/prompt.ts';
import type { ExtensionApiOptions, ExtensionDocumentApi } from './extensions/document-api.ts';
import type { FieldDraft } from './shell/field-properties.ts';
import type { MarkupView } from './shell/markup-views.ts';
import type { SendFailure } from './shell/send-checklist.ts';

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
  /** The character style at the selection, or null when there is none or the runs differ (UX-022). */
  charStyleId?: string | null;
  /** The style of the table the selection is in, or null (UX-022). */
  tableStyleId?: string | null;
}

export interface PanelInfo {
  kind: 'footnote' | 'story';
  id: string;
  /** Kept for spike S1; the shell names panels from its own string tables by `kind` (UX-064). */
  label: string;
  /** For a header or footer story: which one (FE-057). */
  part?: StoryPart;
  /** For a header or footer story: the variant the page setup names it for; null when it names none. */
  variant?: StoryVariant | null;
}

/** The part of the page a story is set in (03 §4.1). */
export type StoryPart = 'header' | 'footer';

/** The pages a header or footer is used on: every page, the first page, or the even pages. */
export type StoryVariant = 'default' | 'first' | 'even';

/** One variant of the header or the footer, as the panel offers it (FE-057 criterion 1). */
export interface StoryVariantInfo {
  readonly part: StoryPart;
  readonly variant: StoryVariant;
  /** The story the page setup names for it, or null when it has none yet. */
  readonly story: string | null;
  /** Whether the person may edit it, or create it when it has none. */
  readonly editable: boolean;
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
 * `structure`, `manage`, `read-only`, `placeholder`, `redacted`, `identifier`, `step`, `invariant`,
 * `referenced` (a cross-reference still names what was deleted; `count` is the number of references);
 * the shell explains an unknown code in general words. `scopes` are DEP scope identifiers; the shell
 * never shows them, so a notice names nothing the reader cannot see (ADR 0019).
 */
export interface RefusalNotice {
  readonly n: number;
  readonly reason: string;
  readonly scopes: readonly string[];
  /** Suggestions a suggestion command skipped, when it counts them (FE-047 criterion 6). */
  readonly count?: number;
  /** The quota a refused picture upload reached, when the service named it (UX-078 criterion 3). */
  readonly quota?: QuotaWaitNotice['quota'];
}

/**
 * A commit the service refused with `quota_exceeded`, naming the quota, which the engine sends again
 * after the delay the service gave (UX-078 criterion 3; the core's `quotaWait` view). `n` counts the
 * waits. The shell says which quota was reached and that nothing is lost.
 */
export interface QuotaWaitNotice {
  readonly n: number;
  readonly quota:
    | 'connections'
    | 'openDocuments'
    | 'commitRate'
    | 'roomCpuBudget'
    | 'storage'
    | 'exportConcurrency'
    | 'exportMinutes';
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
 * What a Replace or Replace all did (FE-060 criterion 3; the core's `replaced` view). `n` counts
 * them, so the same counts twice are two reports. `replaced` and `skipped` are the real numbers of
 * matches changed and left alone; the report names no scope and no text.
 */
export interface ReplaceNotice {
  readonly n: number;
  readonly all: boolean;
  readonly replaced: number;
  readonly skipped: number;
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
  /** For a rejection that named a rule of the document: the rule and its own words (FRW-023). */
  readonly rule?: { readonly id: string; readonly message: string | null };
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
  /** Accessible name of the footer sub-editor; `story` is used when it is not given. */
  readonly footer?: string;
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
 * - `canInsertField`: a field may be inserted at the selection (FRW-072);
 * - `canSetTableSize`: the caret is in a table whose column widths and row height may be changed
 *   (FE-104);
 * - `canMoveBlockUp`, `canMoveBlockDown`: the blocks at the selection have a sibling above or below
 *   to change places with, in a scope the user may change (FE-104).
 */
export type CoreQueryName1b =
  | 'canCopyFormat'
  | 'canPasteFormat'
  | 'canMarkRegion'
  | 'hasNextEditableRegion'
  | 'canInsertField'
  | 'canSetTableSize'
  | 'canMoveBlockUp'
  | 'canMoveBlockDown';

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
 * - `renameRegion`: `{ region, title }`; the core refuses it without `structure` and `edit` in the
 *   region (PRM-034);
 * - `nextEditableRegion`: none (PRM-027);
 * - `insertField`: `{ kind }` (FRW-072);
 * - `insertRecovered`, `discardRecovered`: `{ id }`, the item's `id` or its index as a string
 *   (UX-017);
 * - `finishFill`: none (FRW-076);
 * - `setAltText`: `{ asset, alt }`; stores the text on the first picture of that asset that has none
 *   (FE-132 criterion 5);
 * - `showReferences`: none; moves the selection to a cross-reference that blocked the last refused
 *   deletion, the next at each call (FE-133 criterion 5);
 * - `insertCaption`: none; numbers the figure, the table or the selected equation the selection is
 *   on, in its caption sequence (FE-134 criterion 1);
 * - `insertCrossReference`: `{ target, format? }`, a target of `referenceTargets` and `null` or
 *   `page` as the format; inserts a `ref` field at the caret (FE-134 criterion 2);
 * - `insertCitation`: `{ items, mode? }`, items of `{ source, prefix?, suffix?, locator? }` for sources of the
 *   `sources` service and the mode `normal`, `narrative` or `suppressAuthor`; inserts a citation at the
 *   caret through the guards (FE-140 criterion 1);
 * - `setParagraphFormat`: a patch of `indentLeft`, `indentRight`, `indentFirstLine` (twips) and
 *   `tabs` (the whole list, or null for none) for the selected paragraphs; the ruler and the
 *   paragraph dialog both run it (UX-102 criterion 2; FE-129);
 * - `setTableSize`: `{ columnWidths?, rowHeight? }` in twips for the caret's table: the width of
 *   every column and the height of the caret's row, or null for the natural height (FE-104);
 * - `moveBlockUp`, `moveBlockDown`: none; the blocks at the selection change places with the block
 *   above or below (FE-104);
 * - `setTrackedForEveryone`: `{ on }`; switches `settings.trackChanges` between `everyone` and `off`,
 *   for a user with `manage` only (UX-038; owner decision 118).
 */
export type CoreCommandName =
  | 'insertCitation'
  | 'setParagraphFormat'
  | 'setTableSize'
  | 'moveBlockUp'
  | 'moveBlockDown'
  | 'setTrackedForEveryone'
  | 'copyFormat'
  | 'pasteFormat'
  | 'paragraphStyle'
  | 'characterStyle'
  | 'tableStyle'
  | 'createStyle'
  | 'changeStyle'
  | 'deleteStyle'
  | 'setLanguage'
  | 'markRegion'
  | 'setRegionPolicy'
  | 'renameRegion'
  | 'nextEditableRegion'
  | 'insertField'
  | 'insertRecovered'
  | 'discardRecovered'
  | 'finishFill'
  | 'showReferences'
  | 'setAltText'
  | 'insertCaption'
  | 'insertCrossReference';

/** One target the cross-reference dialog offers (FE-134 criterion 2). */
export interface ReferenceTargetItem {
  readonly kind: 'bookmark' | 'heading' | 'numbered' | 'caption' | 'equation';
  /** The `target` of the `ref` field: `node:`, `bookmark:` or `eq:`. */
  readonly target: string;
  /** What a reference to it prints. */
  readonly label: string;
  /** The text or name the person knows the target by. */
  readonly text: string;
}

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

/** What an assistant request is for (13 §6.2): the port's own task names. */
export type AssistantTaskName = 'draft' | 'rewrite' | 'summarise' | 'answer';

/** One piece of an assistant's answer, as the pane reads it (UX-045). */
export type AssistantStreamChunk =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

/**
 * The assistant as the shell sees it (UX-045). `request` builds the request from the selection, the
 * blocks around it and the outline the reader may view (UX-047), sends it to the port and streams the
 * answer. It changes nothing in the document. Aborting `signal` stops the request at the port.
 */
export interface AssistantApi {
  /** True while the host's assistant port is attached. */
  readonly available: ReadView<boolean>;
  request(
    task: AssistantTaskName,
    prompt: string,
    signal: AbortSignal,
    /**
     * Builds the request's structure from the user's request and the document text as data parts
     * (UX-048 criterion 1); the pane gives `buildPrompt`, which loads with the pane. The API sends the
     * result to the port beside the plain request.
     */
    structure?: (request: string, data: readonly AssistantDataInput[]) => AssistantPromptStructure,
  ): AsyncIterable<AssistantStreamChunk>;
  /**
   * What the last request was built from, for the output guard (UX-048): the text of the context, in
   * which a link may be found, and the identifiers of the assets attached to the document. Without
   * it no link and no image passes.
   */
  source?(): { readonly text: string; readonly assets: readonly string[] };
  /**
   * Puts an approved result at the selection as suggestions, never as a direct edit (UX-046). Absent
   * where the core cannot; the pane then offers no insertion. Nothing is applied when it refuses.
   */
  insert?(text: string): AssistantInsertResult;
}

/** One piece of document text for the assistant's request, with its source and label (UX-048). */
export type { AssistantDataInput };

/** What `AssistantApi.insert` did; `reason` is the core's (UX-046 criterion 4). */
export type AssistantInsertResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

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
/** Whose list a dictionary word is on: the person's own, or the tenant's shared one (decision 34). */
export type DictionaryScope = 'user' | 'tenant';

export interface DictionaryEntryView {
  readonly word: string;
  readonly scope: DictionaryScope;
  /** False for a shared word that only an administrator removes. */
  readonly removable: boolean;
}

export interface DictionaryService {
  /** The words for a language; null when the port cannot list them or the request failed. */
  words(lang: string): Promise<readonly DictionaryEntryView[] | null>;
  /** Adds a word; false when the port refused (a shared word needs an administrator) or failed. */
  add(word: string, lang: string, scope: DictionaryScope): Promise<boolean>;
  remove(word: string, lang: string, scope: DictionaryScope): Promise<boolean>;
}
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

/** One tab stop of a paragraph (03 §7): its place from the left margin, in twips. */
export interface TabStopView {
  readonly position: number;
  readonly align: 'left' | 'center' | 'right' | 'decimal';
  readonly leader: 'none' | 'dot' | 'hyphen' | 'underscore' | 'middleDot' | 'heavy';
}

export type ParagraphBorderSideView = 'top' | 'bottom' | 'left' | 'right' | 'between';

/** One border of a paragraph (03 §4.5): width in eighths of a point, space in twentieths. */
export interface ParagraphBorderView {
  readonly style: 'none' | 'single' | 'double' | 'dotted' | 'dashed' | 'thick';
  readonly width?: number;
  readonly color?: string | null;
  readonly space?: number;
}

/**
 * The options of the paragraph dialog besides indents and tab stops (FE-129 criterion 6). Each
 * value is the first selected paragraph's own, with the CDM's default when it sets none; `mixed`
 * names the options the selected paragraphs do not share.
 */
export interface ParagraphOptionsView {
  readonly align: 'start' | 'center' | 'end' | 'justify' | 'distribute';
  /** Twips. */
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  /** Thousandths of a line under `multiple`, twips under `exact` and `atLeast`. */
  readonly lineSpacing: number;
  readonly lineRule: 'multiple' | 'exact' | 'atLeast';
  readonly keepNext: boolean;
  readonly keepLines: boolean;
  readonly pageBreakBefore: boolean;
  readonly widowControl: boolean;
  readonly contextualSpacing: boolean;
  /** The sides that have a border; a side with none is absent. */
  readonly borders: Readonly<Partial<Record<ParagraphBorderSideView, ParagraphBorderView>>>;
  /** The fill colour (`#RRGGBB`) of the shading; null for none. */
  readonly shading: string | null;
  readonly mixed: readonly string[];
}

/**
 * The indents and tab stops of the paragraphs at the selection, for the ruler and the paragraph
 * dialog (UX-102; 13 §2). Lengths are twips, as the document stores them. A value the selected
 * paragraphs do not share is null.
 */
export interface ParagraphFormatView {
  /** How many paragraphs the selection covers. */
  readonly count: number;
  readonly indentLeft: number | null;
  readonly indentRight: number | null;
  /** From the left indent; negative for a hanging indent. */
  readonly indentFirstLine: number | null;
  /** By position. */
  readonly tabs: readonly TabStopView[] | null;
  /** Where a tab goes when no tab stop lies ahead. */
  readonly defaultTabStop: number;
  /** The page the PDF sets this section on; null when the document names none. */
  readonly page: {
    readonly width: number;
    readonly marginLeft: number;
    readonly marginRight: number;
  } | null;
  /** Whether the paragraphs may be changed now. */
  readonly editable: boolean;
  /** Alignment, spacing, keep rules, borders and shading; absent when the core gives none. */
  readonly options?: ParagraphOptionsView;
}

/**
 * The table at the caret, for the table size dialog (FE-104; 03 §4.3). Lengths are twips, as the
 * document stores them.
 */
export interface TableSizeView {
  /** The width of every column. */
  readonly columnWidths: readonly number[];
  /** The height of the caret's row, or null for its natural height. */
  readonly rowHeight: number | null;
  /** The caret's row and column, zero based. */
  readonly row: number;
  readonly column: number;
  /** Whether the sizes may be changed now. */
  readonly editable: boolean;
}

/** The pages of the view on screen, as the navigation pane's thumbnails need them (UX-021). */
export interface PagesInfo {
  /** How many pages the view's layout has. */
  readonly count: number;
  /** The page the view shows now, counted from 0. */
  readonly current: number;
  /** A number that grows with every new layout: a thumbnail drawn before it may be out of date. */
  readonly revision: number;
}

/**
 * Page thumbnails for the navigation pane (UX-021; 13 §2), offered by a view that has pages and a
 * layout tree to draw them from. The shell draws nothing itself: it gives an element to `paint`.
 */
export interface PageThumbnails {
  /** Null while the view on screen shows no pages (the web view, 02 §7): no thumbnails are offered. */
  readonly state: ReadView<PagesInfo | null>;
  /** The size of page `index` in points; null when there is no such page. */
  size(index: number): { readonly width: number; readonly height: number } | null;
  /**
   * Draws page `index` into `target`, `width` CSS pixels wide, in place of what `target` held. The
   * drawing is a picture for the eye: the shell hides it from assistive technology and names the
   * thumbnail itself. False when there is no such page.
   */
  paint(index: number, target: HTMLElement, width: number): boolean;
  /** Moves the view to the page; false when there is no such page. */
  goTo(index: number): boolean;
}

/** A style the document defines (03 §4 `style_def`; UX-022). Names are content. */
export interface StyleSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: 'paragraph' | 'character' | 'table';
  /** The parent style of the same kind, when the core says (UX-022). */
  readonly basedOn?: string | null;
}

/** What a user may do with the definitions of styles (UX-022 criteria 2 and 3). */
export type StyleEditOp = 'create' | 'change' | 'delete';

/**
 * Why a style cannot be created, changed or deleted now: the user's right (`read-only`,
 * `suggestion`, `no-access`, or `region`: a region the user may not edit uses the style, 07 §5.3),
 * or the document (`unknown-style`, `built-in`, `in-use`, `duplicate-name`, `bad-name`,
 * `bad-based-on`).
 */
export type StyleEditReason =
  | 'read-only'
  | 'suggestion'
  | 'no-access'
  | 'region'
  | 'unknown-style'
  | 'built-in'
  | 'in-use'
  | 'duplicate-name'
  | 'bad-name'
  | 'bad-based-on';

/**
 * Whether an edit may be tried. `regions` are the regions that use the style; with `region` as the
 * reason, those the user may not edit. The server decides the rule again, and refuses a change while
 * a region that uses the style is approved (PRM-047), which the core cannot see.
 */
export type StyleEditCheck =
  | { readonly ok: true; readonly regions: readonly string[] }
  | { readonly ok: false; readonly reason: StyleEditReason; readonly regions: readonly string[] };

/** Who can edit a region (05 §6.2 `RegionEditors`; PRM-032). */
export interface RegionEditors {
  /** Document roles that may edit by role alone (`editor`, `owner`). */
  readonly roles: readonly string[];
  /** Principals with an `editor` grant (`user:<id>`, `group:<id>`). */
  readonly principals: readonly string[];
  /** The holder of a lease: while it holds, only they may edit (07 §10). */
  readonly leasedTo?: string;
  /** When that lease expires (RFC 3339; PRM-048); present when `leasedTo` is. */
  readonly leaseExpiresAt?: string;
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
 * The words of a region the user cannot edit that has no label of its own (PRM-026): `unlisted` for
 * a region the access in force does not list yet (05 §5.5), `locked` for any other, which is every
 * locked region when the backend gives no region list.
 */
export interface RegionLabelDefaults {
  readonly locked?: RegionLabel;
  readonly unlisted?: RegionLabel;
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
  /** A standard of the published schema (09 §9.1); absent, the service uses its default. */
  readonly pdfStandard?: 'ua-2' | 'a-4';
  /** A language tag for dates and language-dependent text; absent, the schema's default applies. */
  readonly locale?: string;
  /** An IANA time zone name; absent, the schema's default applies. */
  readonly timeZone?: string;
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
   * the core has no preflight; the dialog then creates the job at once. `options` are the ones the
   * job would be asked for, so that a finding has the severity the job would give it.
   */
  preflight?(
    target: ExportTarget,
    options?: ExportOptions,
  ): readonly ExportDiagnostic[] | Promise<readonly ExportDiagnostic[]>;
  /** Starts a job; resolves with its identifier, or rejects with an error that has a `code`. */
  request(target: ExportTarget, options: ExportOptions): Promise<{ jobId: string }>;
  /** The job as `export.*` events report it; null for an unknown job. */
  job(jobId: string): ReadView<ExportJobView | null>;
  cancel(jobId: string): Promise<void>;
  /**
   * The newest job of target `pdf` that this service started, as its reports arrive; null before
   * the first. The PDF pane shows it (EXP-001). Absent: the core does not follow one, and the pane
   * is not offered.
   */
  readonly latestPdf?: ReadView<ExportJobView | null>;
}

/**
 * The viewer of a typeset PDF (FE-071; 09 §9.3 rule 7): the core puts a sandboxed frame of another
 * origin into `container` and opens the PDF in it. The shell never fetches or parses the file.
 */
export interface PdfViewService {
  /**
   * Opens the PDF at a signed URL in a new frame inside `container`; resolves with the page count
   * once the first page is drawn, and rejects when the viewer or the file cannot be loaded.
   * `destroy()` removes the frame.
   */
  open(
    container: Element,
    source: { readonly url: string },
  ): Promise<{ readonly viewer: { destroy(): void }; readonly pages: number }>;
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

/** A region lease this session holds (05 §6.2 `Lease`; 07 §10). */
export interface HeldLease {
  readonly region: string;
  /** The holder: the host's user identifier. */
  readonly holder: string;
  /** When the lease ends unless it is extended (RFC 3339). */
  readonly expiresAt: string;
}

/**
 * Check-out of a region through the backend's leases port (PRM-043): the user holds a region
 * alone for a short time. The lease is kept alive until it is released (the port sends the
 * heartbeats, 07 §10). Absent when the backend does not announce `leases` (05 §8.3), and then the
 * shell offers no check-out.
 */
export interface LeasesService {
  /**
   * The leases this session took and has not released, as a view. A lease that lapsed or that
   * someone broke stays here until the next `acquire` or `release` of its region; the shell compares
   * its holder with the region list (`RegionEditors.leasedTo`) before it says the user holds it.
   */
  readonly held: ReadView<readonly HeldLease[]>;
  /**
   * `POST /documents/{id}/regions/{rid}/lease`. Rejects with an error whose `code` is `forbidden`
   * (no `edit` in the region, or an approved region) or `conflict` (another user holds it).
   */
  acquire(region: string): Promise<HeldLease>;
  /** `DELETE /documents/{id}/regions/{rid}/lease`: the holder gives the region back. */
  release(region: string): Promise<void>;
}

/** A field of the document as fill mode shows it (FRW-076, FRW-077, FRW-078). */
export interface FillField {
  readonly id: string;
  /** The field's kind (signature, initials, 	ext, ...); absent when the core does not say. */
  readonly kind?: string;
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
  /**
   * Why the participant may not fill: `waiting` for an earlier participant, `paused` while the owner
   * corrects, `unverified` until the access code of the participant is submitted (FRW-039).
   */
  readonly inactive?: 'waiting' | 'paused' | 'unverified' | null;
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
  /** The variants of the header and footer the page setup uses (FE-057); absent: no variant tabs. */
  storyVariants?(): readonly StoryVariantInfo[];
  /** Opens a variant in the panel, creating its story when it has none (FE-057). */
  editStory?(part: StoryPart, variant: StoryVariant): boolean;
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
  /** The last picture inserted without alternative text; the shell asks for it (FE-132 criterion 5). */
  readonly altRequest?: ReadView<{ readonly n: number; readonly asset: string } | null>;
  /**
   * The last symbol inserted in a font that has no glyph for it (FE-136 criterion 4; 09 §3.2); the
   * shell flags it. `family` is null for the default face.
   */
  readonly glyphNotice?: ReadView<{
    readonly n: number;
    readonly char: string;
    readonly family: string | null;
  } | null>;
  /** The last deletion the core trimmed to the editable parts (FE-037 criterion 2); the shell announces it. */
  readonly trimmed?: ReadView<TrimNotice | null>;
  /** A commit refused for a quota the service named, sent again later (UX-078 criterion 3); the shell says which. */
  readonly quotaWait?: ReadView<QuotaWaitNotice | null>;
  /** What the last Replace or Replace all did, with the counts (FE-060 criterion 3); the shell reports it. */
  readonly replaced?: ReadView<ReplaceNotice | null>;
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
   * How suggestions are shown (UX-035; 13 §5): ll until it is set. Choosing a view is a setting of
   * this reader. It changes no content and sends no commit.
   */
  readonly markupView?: ReadView<MarkupView>;
  setMarkupView?(view: MarkupView): void;
  /**
   * Gives the body the words that name a suggestion for assistive technology, for example
   * Inserted by Ada (UX-035 criterion 4); null removes them.
   */
  setSuggestionLabel?(label: ((kind: 'ins' | 'del' | 'fmt', user: string) => string) | null): void;
  /**
   * Gives the body the words of the card that names a suggestion's author and the time of the commit
   * that introduced it (FE-046 criterion 2): the author's identifier and the time (ISO 8601 UTC, or
   * null when it is not known) in, one line out. Null removes the card.
   */
  setSuggestionCard?(format: ((user: string, time: string | null) => string) | null): void;
  /**
   * The suggestions of the document in order, with what the user may do with each (UX-036,
   * UX-037). Read again when `revision` moves. Absent: the review tools are not offered.
   */
  suggestionItems?(): readonly ReviewItem[];
  /** Moves to the next (1) or previous (-1) suggestion after the selection and shows it; null when none (UX-036). */
  stepSuggestion?(direction: 1 | -1): ReviewItem | null;
  /** Selects a suggestion and shows it; false for an unknown identifier (UX-036, UX-037). */
  revealSuggestion?(id: string): boolean;
  /** Accepts or rejects the suggestions in the selection, or the one the caret is in: one commit (UX-036). */
  resolveAtSelection?(action: 'accept' | 'reject'): ReviewReport;
  /**
   * Accepts or rejects every suggestion in the selection, the document or one region (`{ id }`, the
   * region's identifier), or only an author's, or only one suggestion: one commit; those in a scope
   * without `edit` stay pending and are counted.
   */
  resolveSuggestions?(
    action: 'accept' | 'reject',
    target?: 'selection' | 'document' | { readonly id: string },
    author?: string,
    suggestion?: string,
  ): ReviewReport;

  /**
   * The assistant port as the pane uses it (UX-045; 13 §6.2). Absent, or `available` false, when the
   * host gave no assistant port: no assistant pane or command is offered then.
   */
  readonly assistant?: AssistantApi;

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
  /**
   * The custom dictionaries (UX-042; owner decision 34): the person's own and the tenant's shared
   * one. Offered, with its controls, only while `proofing` says the port supports dictionaries.
   */
  readonly dictionary?: DictionaryService;
  /**
   * The finding with this identifier, while it is shown; null otherwise. The editing surface marks a
   * finding's text with `data-de-finding`, and a context click on the mark asks for that finding
   * (UX-008 criterion 5). Absent: the menu uses the finding at the caret.
   */
  proofingFinding?(id: string): ProofingFindingView | null;

  /** Word and page counts (UX-018). */
  readonly stats?: ReadView<DocumentStats>;
  /** The pages of the view on screen, for the navigation pane's thumbnails (UX-021). */
  readonly pages?: PageThumbnails;
  /**
   * The indents and tab stops at the selection (UX-102); null when the selection covers no
   * paragraph. Absent: the shell offers no ruler and no paragraph dialog.
   */
  readonly paragraphFormat?: ReadView<ParagraphFormatView | null>;
  /** The widths of the caret's table and its row height, for the table size dialog (FE-104); null outside a table. */
  readonly tableSize?: ReadView<TableSizeView | null>;
  /** The document's default language (`settings.lang`), a BCP 47 tag; null when not set. */
  readonly language?: ReadView<string | null>;
  /**
   * The document's classification label (UX-085): a tenant's marking, as the document resource
   * holds it. Null when the document has none. The status bar shows its name as text.
   */
  readonly classification?: ReadView<ClassificationLabel | null>;
  /** The document's styles, in the document's order (UX-022). */
  readonly styles?: ReadView<readonly StyleSummary[]>;
  /** Whether a style may be created, changed or deleted now (UX-022 criteria 2 and 3). */
  styleEdit?(op: StyleEditOp, id?: string): StyleEditCheck;
  /** The derived region list, as this reader may see it (PRM-032; ADR 0019). */
  readonly regions?: ReadView<readonly RegionSummary[]>;
  /**
   * The words for the lock indicators of regions the user cannot edit, by region id (PRM-026).
   * The core decides from the access which regions are locked and shades them; `defaults` are the
   * words of a locked region that `labels` does not name.
   */
  setRegionLabels?(
    labels: Readonly<Record<string, RegionLabel>>,
    defaults?: RegionLabelDefaults,
  ): void;
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
  /**
   * Has the core read the browser's selection now, where it would otherwise follow it on a later
   * event. The context menu calls it before it reads `selection`, so that the menu is built for the
   * place that was clicked (UX-008). Absent: the views are taken as current.
   */
  syncSelection?(): void;

  /** Export jobs (UX-101), when the backend announces `exports`. */
  readonly exports?: ExportService;
  /** The viewer of the typeset PDF, for the PDF pane (EXP-001; FE-071). Absent: no PDF pane. */
  readonly pdf?: PdfViewService;
  /**
   * The document as this reader holds it (the engine's `getContent()`, a CDM envelope), for the
   * client export filters of extensions (UX-055; 13 §7.1). Never hidden content (ADR 0019).
   */
  getContent?(): unknown;
  /**
   * Inserts a CDM fragment in place of the selection through the guards of typing (FE-027): the
   * region guard, the identifier plugin and the read restrictions. Used by the client import filters
   * of extensions (UX-055). A refusal changes nothing and says why.
   */
  insertContent?(fragment: unknown): { ok: true } | { ok: false; reason: string; message: string };
  /**
   * What a cross-reference may point at in the document this reader holds (FE-134 criterion 2): each
   * target with the text a reference to it prints. Absent when the core cannot insert references.
   */
  referenceTargets?(): readonly ReferenceTargetItem[];
  /** The range-based document API for one extension (UX-053; 13 section 7.1). Absent: extensions get none. */
  extensionApi?(options: ExtensionApiOptions): ExtensionDocumentApi;
  /** Region grants (PRM-035), when the backend announces `regions`. */
  readonly grants?: GrantsService;
  /**
   * Sets a region's state (`PUT /documents/{id}/regions/{rid}/state`, PRM-048 criterion 4), when the
   * backend offers it. It needs `manage`; the server decides, and a refusal rejects with an error
   * whose `code` says why. Absent: the permissions pane has no state control.
   */
  setRegionState?(region: string, state: RegionSummary['state']): Promise<void>;
  /**
   * Check-out of regions (PRM-043), when the backend announces `leases`. Absent: the permissions
   * pane shows no check-out control.
   */
  readonly leases?: LeasesService;
  /** Fill mode for this participant (FRW-076), or null outside fill mode. */
  readonly fill?: ReadView<FillSummary | null>;
  /** Moves focus to a field and scrolls it into view (FRW-078); false when it is gone. */
  focusField?(id: string): boolean;
  /**
   * The role the author previews the document as (FRW-075), or null. While it is set the core is in
   * fill mode for a participant who holds only that role, and what is entered is never committed.
   */
  readonly rolePreview?: ReadView<string | null>;
  /** Starts, or switches, the preview as `role`; false for a role the document does not define. */
  startRolePreview?(role: string): boolean;
  /** Leaves the preview; the caret returns to where it was. False when none is active. */
  endRolePreview?(): boolean;
  /** Comment threads (UX-028; 05 §6.2), when the backend announces `comments`. */
  readonly threads?: ThreadsService;
  /**
   * The history of the document (HIS-009; 08 §4): the host's read of `GET /history`, shaped for
   * the pane. Absent when the backend does not announce `history`; the history control then
   * does not show (05 §8.3).
   */
  readonly history?: HistoryPort;
  /**
   * What others did since the user's last visit (HIS-028; 08 §10): the host's read of
   * `GET /activity` and `PUT /read-marker`, shaped for the catch-up pane. Absent when the backend
   * does not announce `history`; the catch-up control is then offered only if the host gives counts.
   */
  readonly catchUp?: CatchUpPort;
  /** The sources the document cites (UX-103; CDM-052). Absent: the sources pane is not offered. */
  readonly sources?: SourcesService;
  /** The roles fields are assigned to (FRW-074). Absent: the roles manager is not offered. */
  readonly roles?: RolesService;
  /** The properties of form fields (FRW-073). Absent: the field properties pane is not offered. */
  readonly fieldProperties?: FieldPropertiesService;
  /** The rules of the document and the builder's changes to them (FRW-024). Absent: no rules pane. */
  readonly rules?: RulesService;
  /** The workflow's participants and their order (FRW-026). Absent: the roles pane lists none. */
  readonly participants?: ParticipantsService;
  /** The send dialog's checks and the send action (FRW-028). Absent: no "send for completion" command. */
  readonly workflowSend?: WorkflowSendService;
  /** Adopting a signature and signing a field (FRW-045, FRW-046). Absent: signature fields cannot be signed here. */
  readonly signing?: SigningService;
  /** Finishing the participant's part (FRW-048, FRW-071). Absent: the Finish control runs the named command only. */
  readonly completion?: CompletionService;
  /** Submits the participant's access code (FRW-039). Absent: the bar shows no code input. */
  readonly accessCode?: AccessCodeService;
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
  /**
   * Loads what the service's changes need, when that is not in the first load (FND-008). The pane host
   * awaits it before it opens the pane; the service's other members are not called before it resolves.
   */
  readonly prepare?: () => Promise<void>;
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
  /**
   * Loads what the service's changes need, when that is not in the first load (FND-008). The pane host
   * awaits it before it opens the pane; the service's other members are not called before it resolves.
   */
  readonly prepare?: () => Promise<void>;
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

/** One side of a rule's comparison: a field's key, or a literal as typed (FRW-024). */
export type RuleOperandView = { readonly field: string } | { readonly literal: string };

/** The effect words the builder offers (12 §5.2): the field effects. */
export type RuleEffectName = 'show' | 'hide' | 'require' | 'enable' | 'disable';

/** The comparison operators the builder offers, in the rules language's own spelling. */
export type RuleOperatorName = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface RuleEffectView {
  readonly effect: RuleEffectName;
  readonly keys: readonly string[];
}

/** A rule of the sentence form as parts; the words are the shell's own strings (FRW-024). */
export interface RulePartsView {
  readonly left: RuleOperandView;
  readonly operator: RuleOperatorName;
  readonly right: RuleOperandView;
  readonly then: readonly RuleEffectView[];
  /** Null when the rule has no `else`. */
  readonly otherwise: readonly RuleEffectView[] | null;
}

/** A rule of the document as the builder lists it. */
export interface RuleItem {
  readonly id: string;
  /** The sentence parts, or null for a rule of another shape, which the builder shows as JSON. */
  readonly parts: RulePartsView | null;
  /** The rule's JSON tree as text, for a rule with no parts. */
  readonly json: string;
}

export type RuleChangeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'read-only' | 'no-feature' | 'duplicate' | 'not-defined' | 'no-change';
    }
  | {
      readonly ok: false;
      readonly reason: 'rule_limit';
      readonly limit: number;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid_rules';
      /** Each problem of the rule set, with the field keys it concerns (I14). */
      readonly problems: readonly { readonly message: string; readonly keys: readonly string[] }[];
    };

/**
 * The rule builder's port over the core (FRW-024; 12 §5, §11). A change is a commit of the
 * definitions through the log, and needs `structure`, which `canEdit` reports.
 */
export interface RulesService {
  /**
   * Loads what the service's changes need, when that is not in the first load (FND-008). The pane host
   * awaits it before it opens the pane; the service's other members are not called before it resolves.
   */
  readonly prepare?: () => Promise<void>;
  readonly rules: ReadView<readonly RuleItem[]>;
  /** The fields rules may name: key and label, document content. */
  readonly fields: ReadView<readonly { readonly key: string; readonly label: string }[]>;
  readonly canEdit: ReadView<boolean>;
  /** An identifier for a new rule that no rule of the document uses. */
  nextId(): string;
  /** Saves a rule of the sentence form: a new one, or one that replaces `replace`. */
  save(rule: {
    readonly id: string;
    readonly parts: RulePartsView;
    readonly replace?: string;
  }): RuleChangeResult;
  remove(id: string): RuleChangeResult;
  /** Moves to the field with this key in the document; false when there is none. */
  showField(key: string): boolean;
}

/** A participant of the workflow as the participants list shows it (FRW-026; 12 §6.1). */
export interface ParticipantItem {
  readonly id: string;
  /** The person's name as the owner or the host wrote it; null when none. */
  readonly name: string | null;
  /** The host's identifier of the person; null when none. There is no contact detail (13 §3). */
  readonly sub: string | null;
  readonly roles: readonly string[];
  readonly kind: 'filler' | 'signer' | 'approver' | 'cc';
  /** Equal values are parallel, ascending values are sequential (12 §6.1). */
  readonly order: number;
  readonly state: string | null;
}

/** What the participants form sends: a new participant, or the one it replaces when `id` is given. */
export interface ParticipantInput {
  readonly id?: string;
  readonly name: string;
  readonly sub: string;
  readonly roles: readonly string[];
  readonly kind: ParticipantItem['kind'];
  readonly order: number;
}

export type ParticipantChangeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `not_draft`: the workflow has been sent. `stale`: someone else changed it and the list was
       * read again. `invalid`: the values are not valid; `fields` names them.
       */
      readonly reason: 'read-only' | 'forbidden' | 'not_draft' | 'stale' | 'invalid' | 'failed';
      readonly fields?: readonly string[];
    };

/**
 * The participants of the document's workflow (FRW-026; 12 §6.1): read from the workflow resource,
 * written to it with `If-Match` while the workflow is a draft. People a host wrote through the API
 * appear without being entered again, and the list follows `wf.changed`.
 */
export interface ParticipantsService {
  /** Reads the workflow; the pane host awaits it before it opens the pane. */
  readonly prepare?: () => Promise<void>;
  readonly participants: ReadView<readonly ParticipantItem[]>;
  /** The workflow's state; null before the first read, `draft` for a document with no workflow yet. */
  readonly state: ReadView<string | null>;
  /** True while the caller has `manage` and the workflow is a draft. */
  readonly canEdit: ReadView<boolean>;
  save(input: ParticipantInput): Promise<ParticipantChangeResult>;
  remove(id: string): Promise<ParticipantChangeResult>;
}

/**
 * What the send dialog got from the server (FRW-028; 12 §6.2 `send`). A refusal for the checklist
 * carries the server's verdict, which replaces the editor's own.
 */
export type WorkflowSendOutcome =
  | { readonly ok: true; readonly state: string }
  | {
      readonly ok: false;
      readonly reason: 'checklist_failed';
      readonly failures: readonly SendFailure[];
    }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_draft' | 'failed' };

/** A participant of the workflow as the lock banner names them; the name is the owner's text. */
export interface WorkflowParticipantView {
  readonly id: string;
  /** The name the owner gave; null when none. */
  readonly name: string | null;
  readonly roles: readonly string[];
  /** The participant's state in the workflow resource; null when the resource does not say. */
  readonly state: string | null;
}

/**
 * The send dialog's port over the core and the backend's workflow port (FRW-028; 12 §6.2). The
 * checks run over the document the reader holds and the participants the workflow resource lists.
 */
/** What the server said to an access code (FRW-039; 12 §7). The code itself is never kept. */
export type AccessCodeOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `wrong`: not the code; `rate_limited`: too many attempts, see `retryAfterMs`; `failed`: anything else. */
      readonly reason: 'wrong' | 'rate_limited' | 'failed';
      readonly retryAfterMs?: number;
    };

/** The participant's access code, submitted to the participant's verify endpoint (FRW-039). */
export interface AccessCodeService {
  submit(code: string): Promise<AccessCodeOutcome>;
}

export interface WorkflowSendService {
  /** The workflow's state (`draft`, `sent`, ...); null while it has not been read. */
  readonly state: ReadView<string | null>;
  /** The failures of the editor's own checks; empty when every check passes. */
  readonly failures: ReadView<readonly SendFailure[]>;
  /**
   * The people bound to the workflow and where each stands (`active`, `pending`, `completed`, ...),
   * for the lock banner: who may still act (FRW-029 criterion 6). Empty until the resource is read.
   */
  readonly participants: ReadView<readonly WorkflowParticipantView[]>;
  /**
   * The sequence number of the commit the document was sent at (12 §6.1 `sentSeq`); null before the
   * send or while the resource has not been read. The copy a stopped workflow offers starts from it
   * (FRW-033 criterion 5). Absent: no copy is offered.
   */
  readonly sentSeq?: ReadView<number | null>;
  /** Reads the workflow resource again (the participants and the state). */
  refresh(): Promise<void>;
  /** Moves to the form field with this key; false when there is none. */
  showField(key: string): boolean;
  /** Selects the suggestion with this identifier; false when there is none. */
  showSuggestion(id: string): boolean;
  /** Asks the server to send; the state follows the answer. */
  send(): Promise<WorkflowSendOutcome>;
  /** Stops following the workflow; called when the editor is destroyed. */
  dispose?(): void;
}

/** How a signature or initials image was made (12 §3.3; FRW-045). */
export type SignatureMode = 'typed' | 'drawn' | 'uploaded';
export type SignatureKind = 'signature' | 'initials';

/** The value a signature field takes: the image asset and how it was made. */
export interface SignatureAdoption {
  readonly asset: string;
  readonly mode: SignatureMode;
}

export type AdoptOutcome =
  | { readonly ok: true; readonly adoption: SignatureAdoption }
  // `rejected`: the asset worker refused the image (`asset.failed`); `failed`: anything else.
  | { readonly ok: false; readonly reason: 'rejected' | 'failed' };

export type SignOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'consent' | 'forbidden' | 'not_active' | 'failed' };

/** A signature or initials field the participant activated (FRW-046 criterion 1). */
export interface SignRequest {
  /** Counts the requests, so that the same field activated twice is two requests. */
  readonly n: number;
  readonly id: string;
  readonly key: string;
  readonly kind: SignatureKind;
  /** The field's label, the document's text. */
  readonly label: string;
  /** The name of the role the field belongs to, the document's text; null when it has none. */
  readonly role: string | null;
}

/** The consent text the workflow names, as the service holds it, and the acceptance on record (FRW-044). */
export interface ConsentView {
  readonly textId: string;
  readonly version: number;
  /** The text in full: the service's, never the client's. */
  readonly text: string;
  /** The server time of the acceptance on record for this text, or null. */
  readonly acceptedAt: string | null;
}

export type ConsentLoadOutcome =
  | { readonly ok: true; readonly consent: ConsentView }
  /** `none`: this participant has no consent text to accept (the workflow names none, or the kind accepts none). */
  | { readonly ok: false; readonly reason: 'none' | 'failed' };

export type ConsentAcceptOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'failed' | 'forbidden' };

export type ConsentDeclineOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'reason_required' | 'failed' };

/** The first step of the ceremony: the consent text, its acceptance and the way out (FRW-044; FRW-033). */
export interface ConsentService {
  /** Reads the text and whether it was accepted (`GET .../consent`). */
  load(): Promise<ConsentLoadOutcome>;
  /** Records the acceptance (`POST .../consent`); the service holds the text and takes the hash and time. */
  accept(): Promise<ConsentAcceptOutcome>;
  /** Declines instead (`POST .../decline`); a reason is required (FRW-033). */
  decline(reason: string): Promise<ConsentDeclineOutcome>;
}

/** How many of the participant's signature and initials fields are signed, of how many (FRW-048). */
export interface SignProgress {
  readonly signed: number;
  readonly total: number;
}

/** What finishing the participant's part answered (FRW-048; FRW-071). */
export type CompletionOutcome =
  | { readonly ok: true }
  /** Fields still need attention: the first has focus, and nothing was sent. */
  | { readonly ok: false; readonly reason: 'invalid'; readonly count: number }
  | { readonly ok: false; readonly reason: 'not_active' | 'failed' };

/** Completes the participant's part (POST .../complete) after the fields are checked. */
export interface CompletionService {
  complete(): Promise<CompletionOutcome>;
}

/** The signing ceremony's adoption and sign steps over the backend (FRW-045, FRW-046). */
export interface SigningService {
  /** The consent step that comes before any signing action. Absent: the step is not shown. */
  readonly consent?: ConsentService;
  /** The field the participant activated, until the step is closed. */
  readonly request: ReadView<SignRequest | null>;
  /** The adoption made earlier for this kind and kept for the rest of the visit; null when none. */
  adopted(kind: SignatureKind): SignatureAdoption | null;
  /** Uploads the image through the asset worker and resolves once it is `ready`, or says why not. */
  adopt(
    kind: SignatureKind,
    mode: SignatureMode,
    image: Blob,
    filename: string,
  ): Promise<AdoptOutcome>;
  /** Asks the server to sign the field with the adoption (`POST /documents/{id}/fields/{fid}/sign`). */
  sign(fieldId: string, adoption: SignatureAdoption): Promise<SignOutcome>;
  /**
   * The participant's own signature and initials fields, signed of all, counting signedField as
   * signed (the value arrives through the channel a moment after the sign call answers); null when the
   * core cannot say.
   */
  progress?(signedField?: string): SignProgress | null;
  /** Closes the step without signing. */
  dismiss(): void;
  dispose?(): void;
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
  /**
   * Loads what the service's changes need, when that is not in the first load (FND-008). The pane host
   * awaits it before it opens the pane; the service's other members are not called before it resolves.
   */
  readonly prepare?: () => Promise<void>;
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
      /**
       * The people an assistant acted for in the group, with the agent (HIS-017). Absent or empty when
       * every change is the person's own.
       */
      readonly assisted?: ReadonlyArray<{ readonly user: string; readonly agent: string }>;
      readonly changes: number;
      readonly origins: readonly string[];
      /** The last `seq` of the group: the state a reader opens (HIS-010); absent when the host gives none. */
      readonly toSeq?: number;
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

/**
 * An old version opened as a second, read-only editor state (HIS-010; 08 §5). It is never connected to the live
 * channel, and no command can submit a commit from it. The pane draws it with `mount` and says so in its name.
 */
export interface HistoryVersionView {
  readonly seq: number;
  /** When the version was made (ISO 8601). */
  readonly time: string;
  /** The version's name; null for a state that was not named. */
  readonly name: string | null;
  /** Draws the version in `target`; returns the function that removes it. */
  mount(target: HTMLElement): () => void;
  /**
   * Draws the changes of a comparison whose newer version this is (HIS-013): insertions and formatting
   * with the marks of suggestions, a change bar on each changed block. Absent when the host cannot draw one.
   * An empty list removes the marks (the pane sends one when a restore preview is cancelled, HIS-021).
   */
  showComparison?(changes: readonly HistoryChange[]): void;
  /** Shows or hides deleted text; hidden, the layout does not move. */
  showDeletions?(on: boolean): void;
  /** Puts the caret at change `index` and scrolls it into view; false when it has no place in this version. */
  focusChange?(index: number): boolean;
  /**
   * The identifiers of the blocks the user has selected in this version (HIS-015: "who wrote this"
   * for a passage). Empty when nothing is selected; absent when the host cannot tell.
   */
  selectedBlocks?(): string[];
  /** Releases the state. Called once, when the user leaves the version. */
  close(): void;
}

/** What "who wrote this" is asked about: a region, a list of blocks, or the whole body (both null). */
export interface HistoryWhoQuery {
  readonly seq: number;
  readonly region: string | null;
  readonly blocks: readonly string[] | null;
}

/** One author of the passage, with the times of the commits that wrote it (HIS-015; 08 §7). */
export interface HistoryAuthorLine {
  readonly user: string;
  /** Set when an assistant acted for the user. */
  readonly agent?: string;
  /** Set when the text was brought back by a restore: the user who restored it (HIS-018). */
  readonly restoredBy?: string;
  /** The runs of this author that cover the passage. */
  readonly runs: number;
  /** The server times (ISO 8601) of the first and last commit that wrote them. */
  readonly firstTime: string;
  readonly lastTime: string;
}

export type HistoryWhoResult =
  | { readonly ok: true; readonly seq: number; readonly authors: readonly HistoryAuthorLine[] }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_found' | 'failed' };

/** One change of a comparison, as `GET /diff` gives it (08 §6). */
export interface HistoryChange {
  readonly kind: string;
  readonly blockId?: string;
  readonly fieldId?: string;
  readonly region?: string;
  readonly type?: string;
  readonly user?: string;
  readonly seq?: number;
  /** Set when an assistant acted for `user` (HIS-017). */
  readonly agent?: string;
  readonly attrs?: readonly string[];
  readonly spans?: ReadonlyArray<{
    readonly op: 'insert' | 'delete';
    readonly at: number;
    readonly text: string;
    readonly user?: string;
    readonly seq?: number;
    readonly agent?: string;
  }>;
}

export interface HistoryComparison {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly changes: readonly HistoryChange[];
}

export type HistoryCompareResult =
  | { readonly ok: true; readonly comparison: HistoryComparison }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_found' | 'failed' };

export type HistoryVersionOpen =
  | { readonly ok: true; readonly view: HistoryVersionView }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_found' | 'failed' };

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

/** What the user typed to name a version (HIS-006): a name and an optional note, both plain text. */
export interface HistoryVersionInput {
  readonly name: string;
  readonly note: string | null;
}

export type HistoryVersionResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

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

/** What a restore from the history pane asks for (`POST /restore`; 08 §8). */
export interface HistoryRestoreRequest {
  /** The state to return to. */
  readonly toSeq: number;
  /** One region (HIS-018), or null for the whole document (HIS-019). */
  readonly region: string | null;
}

/** Why the service refuses a restore or its dry run (05 §6.2; 07 §13; 12 §10). */
export type HistoryRestoreRefusal =
  'forbidden' | 'not_found' | 'conflict' | 'workflow_active' | 'too_large' | 'failed';

/** The dry run of a restore (HIS-021): what it would change. Nothing is committed for it. */
export interface HistoryRestorePreview {
  /** The head the dry run was computed against. */
  readonly headSeq: number;
  /** True when the restore would change nothing. */
  readonly unchanged: boolean;
  /** The comparison between the current content and the result, as `GET /diff` gives one. */
  readonly comparison: HistoryComparison;
  /** Definitions the restore would bring back, a style for example (HIS-020). */
  readonly recreated?: readonly string[];
  /** Definitions it cannot bring back for this user; the restored text takes the default instead. */
  readonly replaced?: readonly string[];
}

export type HistoryRestorePreviewResult =
  | { readonly ok: true; readonly preview: HistoryRestorePreview }
  | { readonly ok: false; readonly reason: HistoryRestoreRefusal };

export type HistoryRestoreResult =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: HistoryRestoreRefusal };

/** What this user may restore (07 §13): the pane offers nothing else. */
export interface HistoryRestoreScopes {
  /** The whole document, which needs `manage`. */
  readonly document: boolean;
  /** The regions the user holds `edit` in. */
  readonly regions: readonly string[];
}

/**
 * The host's history port. The element adapts the document service's `/history` and `/versions`
 * routes to this shape; the pane itself never calls the network.
 */
export interface HistoryPort {
  list(query: HistoryPaneQuery): Promise<HistoryPaneResult>;
  choices(): Promise<HistoryChoices>;
  /**
   * Names the current state of the document (HIS-006; `POST /versions`). Present only when the
   * host lets this user name versions (`edit` somewhere in the document, 07 §12); the command to
   * name a version is offered only then. The service's refusal comes back as `forbidden`.
   */
  createVersion?(input: HistoryVersionInput): Promise<HistoryVersionResult>;
  /**
   * Opens the document at `seq` as a read-only state (HIS-010; a pinned read, never the live channel).
   * Present only when the host can read old content. A version below the user's gate comes back as
   * `forbidden`; the list never offers one (HIS-024).
   */
  openVersion?(
    seq: number,
    label: { time: string; name: string | null },
  ): Promise<HistoryVersionOpen>;
  /**
   * Compares two versions (`GET /diff`; HIS-013). `to` null is the current document. The service
   * refuses a version below the user's gate with `forbidden`; the pane offers only versions its list shows.
   */
  compare?(from: number, to: number | null): Promise<HistoryCompareResult>;
  /**
   * Who wrote a passage of the version at `seq` and when (`GET /attribution`, with the commit times
   * joined; HIS-015). The service limits the answer by the user's gate and projection.
   */
  whoWrote?(query: HistoryWhoQuery): Promise<HistoryWhoResult>;
  /**
   * The dry run of a restore (`POST /restore` with `dryRun`; HIS-021): the comparison between the
   * current content and what the restore would leave. It commits nothing, and the service asks for
   * the same permission and visibility as for the restore itself. The pane offers a restore only
   * when the host gives this method, `restore` and `openVersion`.
   */
  previewRestore?(request: HistoryRestoreRequest): Promise<HistoryRestorePreviewResult>;
  /**
   * Restores the whole document or one region to the state at `toSeq` (`POST /restore`; HIS-018,
   * HIS-019). The pane calls it only after the user has seen the dry run of the same request and
   * confirmed. `headSeq` is the head that dry run was computed against, so a host that knows the
   * document has moved since can answer `conflict`, and the pane then asks for a new preview.
   */
  restore?(
    request: HistoryRestoreRequest & { readonly headSeq: number },
  ): Promise<HistoryRestoreResult>;
  /**
   * What this user may restore (07 §13). Absent: the pane offers the whole document and every
   * region of `choices()`, and shows the service's refusal when it comes.
   */
  restoreScopes?(): Promise<HistoryRestoreScopes>;
  /**
   * Called by the host when the list may have changed (a version was named, for instance); the
   * pane then asks again. Returns the function that stops the calls.
   */
  onChange?(listener: () => void): () => void;
  /** The host's directory (UX-025); null for an identifier the host does not know, such as an erased person. */
  readonly resolveUsers?: ResolveUsers;
}

/** One thing that waits for the user in the catch-up: a mention of them, or a task assigned to them. */
export interface CatchUpForYou {
  readonly kind: 'mention' | 'task';
  readonly thread: string;
  /** Who mentioned the user or assigned the task, as the host knows them; null when unknown. */
  readonly author: string | null;
  /** The text of the comment that mentions the user, as plain text; null for a task. */
  readonly excerpt: string | null;
}

/**
 * The activity since the user's read marker (`GET /activity`; 08 §10), as the pane needs it. The
 * `changes` are the comparison from the marker to the head without the user's own changes.
 */
export interface CatchUpActivity {
  /** The user's marker, and the head the activity was computed against. */
  readonly marker: number;
  readonly head: number;
  readonly changes: readonly HistoryChange[];
  /** How many comments by other people were made since the marker. */
  readonly comments: number;
  readonly forYou: readonly CatchUpForYou[];
}

export type CatchUpResult =
  | { readonly ok: true; readonly activity: CatchUpActivity }
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

/** The host's catch-up port. The pane never calls the network. */
export interface CatchUpPort {
  load(): Promise<CatchUpResult>;
  /** Moves the user's read marker to `seq` (`PUT /read-marker`); markers only move forward. */
  markSeen(seq: number): Promise<{ readonly ok: boolean }>;
  /**
   * Whether the user has viewed the head: the marker moves only then (08 §10). Absent: the live
   * document is the head, so the answer is yes.
   */
  viewedHead?(): boolean;
  /** Called by the host when there may be new activity; the pane then asks again. */
  onChange?(listener: () => void): () => void;
  /** The host's directory (UX-025); null for an identifier the host does not know. */
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

/** One comment of a thread as the thread view shows it (UX-029; 05 §6.2). */
export interface CommentView {
  readonly id: string;
  /** The author's principal, `user:<sub>`. */
  readonly author: string;
  readonly createdAt: string;
  readonly body: readonly CommentBodyPart[];
  /** True once the author has edited the comment. */
  readonly edited: boolean;
  /** The reactions to the comment, in the order of `REACTIONS`, none that nobody holds (UX-033). */
  readonly reactions?: readonly ReactionView[];
}

/** The reactions a comment takes, in the order the service lists them (UX-033; ADR 0424). */
export type ReactionName = 'thumbsUp' | 'heart' | 'laugh' | 'celebrate' | 'eyes' | 'done';

/** One reaction of a comment with the people who made it, as principals (`user:<sub>`). */
export interface ReactionView {
  readonly reaction: ReactionName;
  readonly users: readonly string[];
}

/**
 * A thread with its comments, for the thread view (UX-029). `caps` are the capabilities the core
 * reports for the thread's scope (07 §12); `etag` is the version a write sends as `If-Match`.
 */
export interface ThreadDetail {
  readonly id: string;
  readonly state: 'open' | 'resolved';
  /** The author of the thread, who is the author of its first comment. */
  readonly author: string;
  /** True once the commented text was removed; the thread stays readable and is not re-attached. */
  readonly detached: boolean;
  /** The person the thread is assigned to as a task, `user:<sub>`; null or absent when nobody (UX-032). */
  readonly assignee?: string | null;
  readonly caps: readonly Capability[];
  readonly comments: readonly CommentView[];
  readonly etag: string;
}

/**
 * The answer to a write on a thread (UX-029): the thread as it is now, or the service's error code
 * (05 §5.8). `precondition_failed` (`If-Match` failed) carries the latest thread.
 */
export type ThreadWrite =
  | { readonly ok: true; readonly detail: ThreadDetail }
  | { readonly ok: false; readonly code: string; readonly latest?: ThreadDetail };

/** One suggestion as the review tools see it (UX-036, UX-037; 03 §5). */
export interface ReviewItem {
  readonly id: string;
  /** Insertion, deletion or formatting change; `block` says it is on a block, not on text. */
  readonly kind: 'ins' | 'del' | 'fmt';
  readonly block: boolean;
  /** The author's identifier, `user` on the suggestion mark. */
  readonly user: string;
  /** Position in the document, for order and for stepping. */
  readonly from: number;
  readonly to: number;
  /** The words the suggestion covers, cut when long; empty for a block with no text. */
  readonly text: string;
  /**
   * The server time of the commit that introduced it, when the core knows it (08 §14). Absent for
   * a suggestion that was already in the document when it was loaded: the core has no record of
   * its commit (the suggestion-to-commit index of HIS-042 would give it).
   */
  readonly committedAt?: string | null;
  /**
   * Set when the commit that introduced it was made on an assistant's agent connection (UX-046
   * criterion 6): the agent and its registered name, the model, or null when the name is gone. The
   * person it acted for is `user`.
   */
  readonly assistant?: { readonly agent: string; readonly name: string | null } | null;
  /** The capabilities the user has in the suggestion's scope. */
  readonly caps: readonly Capability[];
  /** Whether the user may accept or reject it now (`edit` in its scope, document not locked). */
  readonly canResolve: boolean;
  /** The identifier of the region the suggestion lies in; null in the body (UX-036 criterion 2). */
  readonly region?: string | null;
}

/** What an accept or reject did: the suggestions handled, those left pending, and where. */
export interface ReviewReport {
  readonly handled: number;
  readonly skipped: number;
  readonly skippedScopes: readonly string[];
}

/** Comment threads (05 §6.2). Creating one is a control-plane request, never a commit (13 §5). */
export interface ThreadsService {
  /** The signed-in user's principal (`user:<sub>`), for who may edit and delete (UX-029). */
  self?(): string;
  /**
   * Moves whenever a thread or a comment changes, here or on another client (`thread.*` and
   * `comment.*` events), so the pane reads `list` and `detail` again (UX-029 criteria 1 and 3).
   */
  readonly changes?: ReadView<number>;
  /**
   * Marks the thread in the document and brings its range or block into view (UX-030 criterion 2).
   * A reader's setting: no step, no commit. Called with the row the pane's reader chose.
   */
  reveal?(thread: ThreadSummary): void;
  /** The thread whose highlight the reader chose in the page; `n` counts the choices (UX-030). */
  readonly picked?: ReadView<{ readonly id: string; readonly n: number } | null>;
  /** One thread with its comments; null when it is gone or the reader may not see it. */
  detail?(id: string): ThreadDetail | null;
  /** Adds a reply (`POST .../comments`, `If-Match` with `etag`). */
  reply?(id: string, body: readonly CommentBodyPart[], etag: string): Promise<ThreadWrite>;
  /** Replaces the body of a comment. */
  editComment?(
    id: string,
    commentId: string,
    body: readonly CommentBodyPart[],
    etag: string,
  ): Promise<ThreadWrite>;
  /** Deletes a comment. */
  deleteComment?(id: string, commentId: string, etag: string): Promise<ThreadWrite>;
  /**
   * Asks the host for the address of a comment (UX-034; owner decision 88): the element raises
   * `de-comment-link-request` with the identifiers and a marker, and the host builds the address
   * from its own page address. False when the element can ask nobody. Absent: no control is offered.
   */
  requestLink?(id: string, commentId: string): boolean;
  /**
   * What became of the last address the host gave: it was copied (`ok`) or it could not be. `n`
   * counts the answers, so the same outcome twice is two changes. Null before the first.
   */
  readonly linkCopied?: ReadView<{ readonly n: number; readonly ok: boolean } | null>;
  /**
   * Adds the user to a reaction of a comment (`on`), or takes them out of it (UX-033). Absent
   * unless the backend announces the feature `reactions`: then no reaction control is offered.
   * It makes no commit and needs no tag; a user may react again to the same reaction safely.
   */
  react?(id: string, commentId: string, reaction: ReactionName, on: boolean): Promise<ThreadWrite>;
  /** Deletes a whole thread. */
  deleteThread?(
    id: string,
    etag: string,
  ): Promise<{ readonly ok: boolean; readonly code?: string }>;
  /** Resolves or reopens a thread. */
  setState?(id: string, state: 'open' | 'resolved', etag: string): Promise<ThreadWrite>;
  /**
   * Gives the thread to a person as a task, or clears the assignee with null (`PATCH` of `assignee`,
   * `If-Match` with `etag`; UX-032). The service raises `dep.task.assigned` for a person named.
   */
  assign?(id: string, assignee: string | null, etag: string): Promise<ThreadWrite>;
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
