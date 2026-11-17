/**
 * The editing core without a view (02 §4, §5; ADR 0003; FE-121): plain TypeScript that owns all
 * document state. It runs in Node.js with no DOM: nothing here imports `prosemirror-view`. The web
 * view (view/web.ts) builds on it.
 *
 * What it holds:
 * - the editor state, with the schema generated from the CDM (FE-030) and the plugins of 02 §5.2:
 *   identifiers (FE-031), body-scoped selections (FE-032), region clamping and the paragraph after a
 *   region (FE-038, FE-039), the region guard (FE-036), undo history;
 * - the sync client (FE-033; SYN-017 to SYN-020): every local transaction's steps go to its queue,
 *   and every remote change arrives as one transaction marked as remote, rebuilt from the confirmed
 *   document. While a composition is open, a remote change to the block being composed waits for
 *   the composition to end (spike S1 finding 1; FE-034);
 * - the document API (FE-026) and small read-only views with one notification per frame (FE-023,
 *   FE-024).
 */
import { type StepJson, stepsToJson } from '@docedit/authority';
import type { RemoteCommit } from '@docedit/protocol';
import type { Access, SyncChannel } from '@docedit/protocol';
import { LOCATOR_LABELS, mayOpen, supportedFeatures } from '@docedit/model/definition';
import { toggleMark } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import {
  history,
  isHistoryTransaction,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from 'prosemirror-history';
import {
  Fragment,
  type Mark,
  type MarkType,
  Node as PMNode,
  type Schema,
  Slice,
} from 'prosemirror-model';
import {
  type Command,
  EditorState,
  Plugin,
  TextSelection,
  type Transaction,
} from 'prosemirror-state';
import { type Step, replaceStep } from 'prosemirror-transform';
import { nodeId } from '@docedit/model';
import type {
  AccessLimit,
  AccessSummary,
  AttachOptions,
  Capability,
  CdmEnvelope,
  CdmFragment,
  CommandArgs,
  CommandName,
  CommandState,
  CommandUnavailable,
  ConnectionState,
  CoreProblem,
  CoreQueryName,
  DocumentApi,
  EditMode,
  FindResult,
  FindState,
  InsertResult,
  ModeState,
  OutlineItem,
  PanelInfo,
  PeerSelectionInfo,
  PresencePeerInfo,
  RecoveredEdits,
  RecoveredItem,
  ReplaceReport,
  RefusalNotice,
  SaveState,
  SelectionScope,
  SelectionSummary,
  ShellCounts,
  StatusSummary,
  StyleInfo,
  SuggestionModeInfo,
  SyncSnapshot,
  SyncSummary,
} from './api.ts';
import { buildFragment, fragmentOf, fragmentProblem, isFragmentProblem } from './content.ts';
import { bodyGuard, initialSelection, selectAllInBody } from './body.ts';
import { effectiveMode, modeLocks } from './mode.ts';
import { insertFootnote } from './footnote.ts';
import { createVariantStory } from './header-footer.ts';
import { type CitationItemInput, insertCitation } from './citation-insert.ts';
import { addLink, followInternalLink, insertBookmark } from './links-bookmarks.ts';
import { type PageSetupChanges, setPageSetup } from './page-setup-commands.ts';
import { deleteSource } from './source-delete.ts';
import {
  type SourceEdit,
  type SourceEditOutcome,
  type SourceInfo,
  addSource,
  listSources,
  updateSource,
} from './source-edit.ts';
import {
  type SectionWarning,
  insertBreak,
  insertSectionBreak,
  sectionWarnings,
} from './breaks-sections.ts';
import { type InsertFieldOptions, insertField, insertSymbol, insertToc } from './fields-toc.ts';
import { insertCaption, insertReference } from './captions-refs.ts';
import { referenceGuardPlugin } from './referenced-targets.ts';
import { setEquationLatex } from './equation-commands.ts';
import { isValueFormat, valueFormatCommand } from './formatting-values.ts';
import { LIST_COMMANDS, listCommand } from './list-commands.ts';
import {
  type AssetsPort,
  type ImagePasteResult,
  type PastedImage,
  pasteImage,
} from './image-paste.ts';
import {
  addPlaceholder,
  newPlaceholderId,
  picturePlaceholderPlugin,
  removePlaceholder,
} from './picture-placeholder.ts';
import { type Refusal, canWrite, capsOf, depScope, guardPlugin } from './guard.ts';
import { idTypesOf, identifierPlugin } from './ids.ts';
import { type Internals, register } from './internals.ts';
import { INTERNAL, REMOTE, SUGGESTED } from './meta.ts';
import { scopeDiff } from './scope-diff.ts';
import { recordAsSuggestion } from './suggestion-edit.ts';
import { type MarkupView, type SuggestionSpec, suggestionSpecs } from './suggestion-markup.ts';
import { type SuggestionModeState, suggestionMode } from './suggestion-mode.ts';
import { CommentRanges, type ThreadRange } from './comment-ranges.ts';
import {
  type LocatedFinding,
  NO_PROOFING,
  type ProofingClock,
  ProofingController,
  type ProofingPort,
  type ProofingInfo,
} from './proofing.ts';
import { ReadValue, type Schedule, ViewHub, sameJson } from './read-value.ts';
import {
  placeholderAt,
  regionAt,
  regionClamp,
  regionParagraphs,
  withParagraphsAfterRegions,
} from './regions.ts';
import { nextEditableRegion } from './region-navigation.ts';
import { markRegion } from './prm-033-mark-region.ts';
import { setRegionPolicy } from './prm-036-region-policy.ts';
import { renameRegion } from './prm-034-rename-region.ts';
import {
  chooseClipboard,
  clipboardPayload,
  copyRefusal,
  withoutEmbeddedData,
  withoutNodeTypes,
  type ClipboardInput,
  type ClipboardPayload,
  type CutResult,
} from './clipboard.ts';
import { trimKey, trimPlugin, trimmedDeletion, type TrimReport } from './trim.ts';
import {
  isTableOp,
  locateCell,
  TABLE_OPS,
  type TableOp,
  tableCommand,
  tableRefusal,
} from './table.ts';
import { SUGGESTED_TABLE_OPS, suggestTableOp } from './suggestion-table.ts';
import { isCellRect, mergeCellsCommand, spanRefusal, splitCellCommand } from './table-span.ts';
import {
  setTableStyle,
  sortRefusal,
  sortTableRows,
  tableStyleRefusal,
} from './table-style-sort.ts';
import { figureRefusal, resizeFigure, setFigureLayout } from './figure-layout.ts';
import { changeIndent } from './paragraph-indent.ts';
import { PresenceClient } from './presence.ts';
import { type SearchMatch, findMatches } from './search.ts';
import { skippedPreservedAtoms } from './preserved-find.ts';
import {
  type ResolveAction,
  type SuggestionReport,
  type SuggestionTarget,
  resolveSuggestions,
} from './suggestion-resolve.ts';
import { onConfirmed, rebuildTransaction } from './remote.ts';
import { flattenSteps, withoutLostIdentifierSteps } from './steps.ts';
import { editingSchema, type FootnoteModel } from './schema.ts';
import {
  currentStyle,
  isParagraphStyle,
  outlineOf,
  paragraphStyles,
  sameOutline,
  setParagraphStyle,
  stylesOf,
} from './styles.ts';
import { type SyncEvent, type SyncHost, SyncSession } from './sync/session.ts';
import {
  type Discarded,
  type Effect,
  type SyncState,
  type Transition,
  initialState,
  local,
  receiveCommits,
  settled,
  unconfirmed,
} from './sync/state.ts';
import type { SelectionShim } from './view-support.ts';
import { CDM1 } from '@docedit/model/definition';

/** The engine this build implements and the CDM it reads (03 §11.1; FE-030 criterion 8). */
export const ENGINE = 'pm-steps/1';
export const CDM_VERSION = 1;

/** What a session announces: the engine, the CDM major version and the CDM features it supports. */
export function capabilities(): { engine: string; cdm: number; features: string[] } {
  return { engine: ENGINE, cdm: CDM_VERSION, features: supportedFeatures(CDM1) };
}

/**
 * Whether prosemirror-history recorded transaction `t` (applied with the root `root`) as one item
 * per step on the undo branch: not undo or redo, and neither it nor its root kept out of history.
 */
function recordedInHistory(t: Transaction, root: Transaction): boolean {
  if (isHistoryTransaction(t) || isHistoryTransaction(root)) return false;
  return t.getMeta('addToHistory') !== false && root.getMeta('addToHistory') !== false;
}

function historyCommand(command: Command): Command {
  return (state, dispatch) => command(state, dispatch);
}

export interface CoreConfig {
  doc: CdmEnvelope;
  /** @deprecated Ignored: the CDM has one footnote model (CDM-001). */
  footnoteModel?: FootnoteModel;
  /** Where the shadow root's `getSelection` comes from (02 §8); used by the web view. */
  selectionShim?: SelectionShim;
  /**
   * Defer a remote change to the block being composed until the composition ends (spike S1;
   * FE-034). Default true; false reproduces the failure, for the evidence.
   */
  deferRemoteWhileComposing?: boolean;
  /** The access the region guard starts with; null (the default) refuses nothing. */
  access?: Access | null;
  /** Identifier source for new nodes (03 §9); random by default. */
  generateId?: () => string;
  /** When read views notify (default: the next animation frame). */
  schedule?: Schedule;
  /** The `mode` the host asks for (FE-029); the effective mode follows the access. Default `edit`. */
  mode?: EditMode;
  /** The assets port for pasted pictures (FE-053); `attach` may give one instead. */
  assets?: AssetsPort;
  /**
   * The user's identifier, which suggestion marks name (03 §5; FE-042); `attach` may give one
   * instead. Without one, a change suggestion mode would record is refused.
   */
  user?: string;
  /**
   * The font alias of a family in the manifest (FE-062 criterion 1). The body and the panels draw a
   * family mark with the alias it returns; a family it does not know keeps its name. Read at each draw.
   */
  fontAlias?: (family: string) => string | undefined;
}

/** A document the core cannot open (03 §2, §11.1): the codes are DEP's (05 §5.8). */
export class UnsupportedDocumentError extends Error {
  readonly code: 'unsupported_cdm' | 'unsupported_feature' | 'validation_failed';
  readonly missing: readonly string[];

  constructor(
    code: 'unsupported_cdm' | 'unsupported_feature' | 'validation_failed',
    message: string,
    missing: readonly string[] = [],
  ) {
    super(message);
    this.name = 'UnsupportedDocumentError';
    this.code = code;
    this.missing = missing;
  }
}

/** Parses an envelope, refusing what this build cannot open without dropping content (03 §2). */
export function readEnvelope(env: CdmEnvelope, schema: Schema): PMNode {
  if (env.cdm !== CDM_VERSION)
    throw new UnsupportedDocumentError(
      'unsupported_cdm',
      `the document uses CDM version ${String(env.cdm)}; this editor supports version ${CDM_VERSION}`,
    );
  const decision = mayOpen(env.requires, supportedFeatures(CDM1));
  if (!decision.ok)
    throw new UnsupportedDocumentError(
      'unsupported_feature',
      `the document needs features this editor does not support: ${decision.missing.join(', ')}`,
      decision.missing,
    );
  let doc: PMNode;
  try {
    doc = PMNode.fromJSON(schema, env.doc);
    doc.check();
  } catch (e) {
    throw new UnsupportedDocumentError(
      'validation_failed',
      `the document is not valid CDM: ${(e as Error).message}`,
    );
  }
  return doc;
}

/** What `onTransaction` reports of a change, without ProseMirror types (FE-026). */
export interface TransactionInfo {
  readonly docChanged: boolean;
  getMeta(key: string): unknown;
}

/** What the web view gives the core (view/web.ts). */
export interface ViewBridge {
  /** The state changed; `transactions` were applied. */
  update(state: EditorState, transactions: readonly Transaction[]): void;
  /** Position of the block being composed, or null (spike S1; FE-034). */
  composing(): number | null;
  focus(): void;
  /**
   * Whether local changes are refused moved (the effective mode, a `read_only` rejection or its
   * end), with no new state: the view reads `editable` again (FE-029).
   */
  lockChanged?(locked: boolean): void;
  /**
   * The main-document position of the caret when this view's sub-editor has focus, or null (FE-026
   * criterion 3). `selectionScope()` reports the scope of that position.
   */
  focusedPosition?(): number | null;
}

const EMPTY_SUMMARY: SelectionSummary = {
  empty: true,
  scope: 'body',
  region: null,
  style: null,
  marks: [],
};

/** Without an access object nothing limits editing (no backend: a demo or a test). */
const FULL_CAPS: readonly Capability[] = ['view', 'comment', 'suggest', 'edit'];

const QUERY_NAMES: readonly CoreQueryName[] = [
  'canEditSelection',
  'canUndo',
  'canRedo',
  'isBold',
  'isItalic',
  'canInsertFootnote',
  'hasHeader',
  'canInsertField',
  'canMarkRegion',
];

/**
 * The title `canMarkRegion` asks `markRegion` with: the shell's dialog asks for the real title only
 * after the command is chosen, and the command refuses only an empty one (PRM-033).
 */
const REGION_QUERY_TITLE = 'Region';

const COMMANDS: readonly CommandName[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'smallCaps',
  'allCaps',
  'superscript',
  'subscript',
  'selectAll',
  'insertFootnote',
  'editHeader',
  'undo',
  'redo',
  'paragraphStyle',
  ...TABLE_OPS,
  // `mergeCells` takes its rectangle as an argument, so only `queryCommand` with it answers.
  'splitCell',
  'setTableStyle',
  'sortTableRows',
  'resizeFigure',
  'setFigureLayout',
  'increaseIndent',
  'decreaseIndent',
  'nextEditableRegion',
];

/**
 * The authoring commands (FE-070, FE-133 to FE-137, FE-140). They take arguments, so they are not in
 * the `commands` read view (which queries without arguments); `queryCommand` with the arguments
 * answers.
 */
/**
 * Commands that change a block other than a paragraph, a whole table row or a table (FE-044
 * criterion 5): a figure, a caption, a section break, a table of contents, an equation's source and
 * a region. Suggestion mode has no suggestion for these in version 1, so they are unavailable there
 * with the `suggestion` reason.
 */
const BLOCK_ONLY_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'insertSectionBreak',
  'insertToc',
  'insertCaption',
  'setEquationLatex',
  'resizeFigure',
  'setFigureLayout',
  'markRegion',
  'setRegionPolicy',
  'renameRegion',
]);

const AUTHORING: ReadonlySet<CommandName> = new Set<CommandName>([
  'insertCitation',
  'addLink',
  'insertBookmark',
  'followInternalLink',
  'setPageSetup',
  'insertBreak',
  'insertSectionBreak',
  'insertField',
  'insertToc',
  'insertSymbol',
  'insertCaption',
  'insertReference',
  'setEquationLatex',
]);

const isLocatorLabel = (v: string): v is (typeof LOCATOR_LABELS)[number] =>
  (LOCATOR_LABELS as readonly string[]).includes(v);

/** The citation items of the API as the command takes them, or null when a label is unknown. */
function citationItems(
  items: readonly NonNullable<CommandArgs['citation']>['items'][number][],
): CitationItemInput[] | null {
  const out: CitationItemInput[] = [];
  for (const item of items) {
    if (item.label !== undefined && !isLocatorLabel(item.label)) return null;
    out.push({
      source: item.source,
      ...(item.prefix !== undefined ? { prefix: item.prefix } : {}),
      ...(item.suffix !== undefined ? { suffix: item.suffix } : {}),
      ...(item.locator !== undefined ? { locator: item.locator } : {}),
      ...(item.label !== undefined ? { label: item.label } : {}),
    });
  }
  return out;
}

/** Whether an authoring command was given the arguments it needs. */
function hasAuthoringArgs(name: CommandName, args: CommandArgs): boolean {
  switch (name) {
    case 'insertCitation':
      return args.citation !== undefined;
    case 'addLink':
    case 'followInternalLink':
      return args.href !== undefined;
    case 'insertBookmark':
      return args.name !== undefined;
    case 'setPageSetup':
      return args.pageSetup !== undefined;
    case 'insertBreak':
      return args.breakKind !== undefined;
    case 'insertSectionBreak':
      return args.section !== undefined;
    case 'insertField':
      return args.field !== undefined;
    case 'insertToc':
      return args.toc !== undefined;
    case 'insertSymbol':
      return args.symbol !== undefined;
    case 'insertCaption':
      return args.figure !== undefined;
    case 'insertReference':
      return args.reference !== undefined;
    case 'setEquationLatex':
      return args.equation !== undefined;
    default:
      return false;
  }
}

/** The field options of the API as `insertField` takes them, without absent members. */
function fieldOptions(
  field: NonNullable<CommandArgs['field']>,
  writable: (pos: number) => boolean,
): InsertFieldOptions {
  return {
    writable,
    ...(field.format !== undefined ? { format: field.format } : {}),
    ...(field.date !== undefined ? { date: field.date } : {}),
    ...(field.title !== undefined ? { title: field.title } : {}),
  };
}

/**
 * A transaction on `state` with the steps of `tr`, which was made on a state with the same document
 * (a caret placed in a story, where the core's own selection never goes). The core's selection is
 * mapped through the steps and stays where it was.
 */
function replayOn(state: EditorState, tr: Transaction): Transaction {
  const out = state.tr;
  for (const step of tr.steps) out.step(step);
  return out.scrollIntoView();
}

/**
 * The API's reason for an authoring command's refusal, where it has one. `read-only` from a command
 * module means the guard's `canWrite` refused the scope; a lock is reported before the module runs.
 */
function authoringReason(reason: string): CommandUnavailable | null {
  switch (reason) {
    case 'read-only':
      return 'no-access';
    case 'scheme-not-allowed':
      return 'scheme-not-allowed';
    case 'malformed':
      return 'malformed-link';
    case 'bad-name':
      return 'bad-bookmark-name';
    case 'duplicate':
      return 'duplicate-bookmark';
    default:
      return null;
  }
}

/** What an authoring command reports: done or possible, or refused with the module's reason. */
type AuthoringOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function marksAt(state: EditorState): readonly Mark[] {
  const { selection } = state;
  if (selection.empty) return state.storedMarks ?? selection.$from.marks();
  // A range: the marks every text node in it carries.
  let common: readonly Mark[] | null = null;
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isText) return true;
    common = common === null ? node.marks : common.filter((m) => m.isInSet(node.marks));
    return false;
  });
  return common ?? selection.$from.marks();
}

/**
 * Where new style definitions go in the `defs` node: after its last style definition, or after the
 * settings when there is none (FE-027). Positions in the document, before the body.
 */
function styleInsertPos(doc: PMNode): number {
  let at = 1;
  doc.firstChild!.forEach((child, offset) => {
    if (child.type.name === 'style_def' || child.type.name === 'settings')
      at = 1 + offset + child.nodeSize;
  });
  return at;
}

/**
 * Where new numbering definitions go in the `defs` node (FE-050 criterion 3): after its last
 * numbering definition, else after its last style definition or the settings, so before the page
 * setups (CDM-019 order: `settings style_def* numbering_def* page_setup+ …`).
 */
function numberingInsertPos(doc: PMNode): number {
  let at = 1;
  doc.firstChild!.forEach((child, offset) => {
    const name = child.type.name;
    if (name === 'numbering_def' || name === 'style_def' || name === 'settings')
      at = 1 + offset + child.nodeSize;
  });
  return at;
}

/**
 * Toggles format the whole selection, the spaces at its edges included. ProseMirror's default
 * drops leading and trailing whitespace, which would leave an underlined run with unmarked spaces.
 */
const WHOLE_SELECTION = { includeWhitespace: true } as const;

function markActive(state: EditorState, name: string): boolean {
  return marksAt(state).some((m) => m.type.name === name && m.attrs['value'] !== false);
}

/** The marks of every text node that a range touches (FE-128 criterion 1). */
function rangeMarks(doc: PMNode, from: number, to: number): Mark[] {
  const out: Mark[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) out.push(...node.marks);
    return true;
  });
  return out;
}

/**
 * Superscript and subscript (FE-128 criterion 1): one `vertAlign` mark, so a subscript replaces a
 * superscript instead of removing it. The mark is removed when the selection already has that
 * position; a collapsed caret sets or clears the stored mark for the next typed text.
 */
function verticalAlignCommand(type: MarkType, value: 'super' | 'sub'): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const { from, to, empty, $from } = state.selection;
    const marks = empty ? (state.storedMarks ?? $from.marks()) : rangeMarks(state.doc, from, to);
    const on = marks.some((m) => m.type === type && m.attrs['value'] === value);
    const tr = state.tr;
    if (empty) {
      if (on) tr.removeStoredMark(type);
      else tr.addStoredMark(type.create({ value }));
    } else if (on) {
      tr.removeMark(from, to, type);
    } else {
      tr.addMark(from, to, type.create({ value }));
    }
    dispatch(tr);
    return true;
  };
}

export class DocumentCore implements DocumentApi {
  readonly #hub: ViewHub;
  readonly selection: ReadValue<SelectionSummary>;
  readonly panel: ReadValue<PanelInfo | null>;
  readonly outline: ReadValue<readonly OutlineItem[]>;
  readonly permissions: ReadValue<Access | null>;
  readonly access: ReadValue<AccessSummary>;
  readonly saveState: ReadValue<SaveState>;
  readonly confirmedSeq: ReadValue<number>;
  readonly connection: ReadValue<ConnectionState>;
  readonly status: ReadValue<StatusSummary>;
  readonly commands: ReadValue<Readonly<Record<CommandName, CommandState>>>;
  readonly revision: ReadValue<number>;
  readonly direction: ReadValue<'ltr' | 'rtl'>;
  readonly refusal: ReadValue<RefusalNotice | null>;
  readonly mode: ReadValue<ModeState>;
  /** Suggestion mode at the caret, and why (FE-041 criterion 5). */
  readonly suggestion: ReadValue<SuggestionModeInfo>;
  /** The last deletion that kept protected content (FE-037): `n` counts them. */
  readonly trimmed: ReadValue<TrimReport | null>;
  readonly recovered: ReadValue<RecoveredEdits>;
  readonly syncSummary: ReadValue<SyncSummary>;
  readonly presence: ReadValue<readonly PresencePeerInfo[]>;
  /** The peers of `presence` with their positions in the visible document (SYN-036). */
  readonly peerSelections: ReadValue<readonly PeerSelectionInfo[]>;
  readonly features: ReadValue<readonly string[]>;
  readonly counts: ReadValue<ShellCounts>;
  readonly problem: ReadValue<CoreProblem | null>;
  readonly findState: ReadValue<FindState>;
  /** The proofing state and findings (UX-041); `available` is false without a proofing port. */
  readonly proofing: ReadValue<ProofingInfo>;
  /** The client's copy of each thread's range, mapped through every change (FE-048). */
  readonly threadRanges: ReadValue<readonly (ThreadRange & { readonly id: string })[]>;
  readonly #comments = new CommentRanges();
  #commentSeq = 0;
  readonly queryNames: readonly CoreQueryName[] = QUERY_NAMES;
  #problems = 0;
  /** The find (FE-059): the query, its matches in the body and the current one (0-based). */
  #find: { query: string; matches: SearchMatch[]; current: number | null } = {
    query: '',
    matches: [],
    current: null,
  };
  #presenceClient: PresenceClient | null = null;

  readonly #schema: Schema;
  #state: EditorState;
  #sync: SyncState;
  /**
   * Whether the last items of the undo history are the unconfirmed steps, one item per step, so that
   * a rebuild may rebase the history through its pairing (remote.ts). Undo and redo, local steps the
   * history does not record, and steps the queue splits or drops break that until the queue is
   * empty again; a rebuild then maps the history instead of rebasing it.
   */
  #historyAligned = true;
  #requires: string[];
  #session: SyncSession | null = null;
  /** The journal could not write (FE-008): unconfirmed work is not protected, so it reads unsaved. */
  #journalFailed = false;
  /** The service's last answer to a commit of ours was `unavailable` (FE-008 criterion 4; 06 §8). */
  #serviceUnavailable = false;
  #accessValue: Access | null;
  #proofing: ProofingController | null = null;
  /** The `mode` the host set, and the one in force under the access (FE-029). */
  #requested: EditMode = 'edit';
  #effective: EditMode = 'edit';
  #readOnly = false;
  #readOnlyRev = -1;
  #refusals = 0;
  #trims = 0;
  #target: { kind: 'footnote' | 'story'; id: string } | null = null;
  readonly #bridges = new Set<ViewBridge>();
  readonly #deferRemote: boolean;
  /** Remote commits of the spike's stand-in path waiting for a composition to end. */
  #standIn: RemoteCommit[] = [];
  #standInHeld = false;
  #waiters: Array<{ resolve: () => void }> = [];
  #destroyed = false;
  /** The document the attached channel serves, for the proofing port's requests. */
  #docId = '';
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #listeners = new Set<(tr: Transaction, state: EditorState) => void>();
  /** Remote changes that waited for a composition, for the tests of FE-034. */
  #deferrals = 0;
  /** Identifiers for the nodes an authoring command creates (03 §9). */
  readonly #newId: () => string;
  /** The assets port of the configuration, and the one `attach` gave, which wins (FE-053). */
  readonly #configAssets: AssetsPort | null;
  #attachedAssets: AssetsPort | null = null;
  /** The user suggestion marks name (FE-042): the configuration's, then the one `attach` gave. */
  #user: string | null;
  /** `settings.trackChanges` of the last definitions read, by the definitions node (FE-041). */
  #trackChanges: { defs: PMNode | null; value: 'off' | 'everyone' | undefined } | null = null;

  constructor(config: CoreConfig, extraPlugins: (schema: Schema) => Plugin[] = () => []) {
    this.#newId = config.generateId ?? nodeId;
    this.#configAssets = config.assets ?? null;
    this.#user = config.user ?? null;
    this.#schema = editingSchema();
    this.#hub = new ViewHub(config.schedule);
    const hub = this.#hub;
    this.selection = new ReadValue<SelectionSummary>(EMPTY_SUMMARY, sameJson, hub);
    this.panel = new ReadValue<PanelInfo | null>(null, sameJson, hub);
    this.outline = new ReadValue<readonly OutlineItem[]>([], sameOutline, hub);
    this.permissions = new ReadValue<Access | null>(null, sameJson, hub);
    this.access = new ReadValue<AccessSummary>(
      { scope: 'body', caps: FULL_CAPS, limit: null },
      sameJson,
      hub,
    );
    this.saveState = new ReadValue<SaveState>('saved', Object.is, hub);
    this.confirmedSeq = new ReadValue<number>(0, Object.is, hub);
    this.connection = new ReadValue<ConnectionState>('detached', Object.is, hub);
    this.status = new ReadValue<StatusSummary>(
      { connection: 'offline', sync: 'saved' },
      sameJson,
      hub,
    );
    this.commands = new ReadValue<Readonly<Record<CommandName, CommandState>>>(
      {} as Record<CommandName, CommandState>,
      sameJson,
      hub,
    );
    this.revision = new ReadValue<number>(0, Object.is, hub);
    this.direction = new ReadValue<'ltr' | 'rtl'>('ltr', Object.is, hub);
    this.refusal = new ReadValue<RefusalNotice | null>(null, sameJson, hub);
    this.#requested = config.mode ?? 'edit';
    this.#accessValue = config.access ?? null;
    this.#effective = effectiveMode(this.#requested, this.#accessValue);
    this.mode = new ReadValue<ModeState>(
      { requested: this.#requested, effective: this.#effective },
      sameJson,
      hub,
    );
    this.suggestion = new ReadValue<SuggestionModeInfo>(
      { on: false, locked: false, reason: null, scope: 'body' },
      sameJson,
      hub,
    );
    this.trimmed = new ReadValue<TrimReport | null>(null, sameJson, hub);
    this.recovered = new ReadValue<RecoveredEdits>({ count: 0, items: [] }, sameJson, hub);
    this.syncSummary = new ReadValue<SyncSummary>(
      { seq: 0, incarnation: '', inflight: null, queued: 0 },
      sameJson,
      hub,
    );
    this.presence = new ReadValue<readonly PresencePeerInfo[]>([], sameJson, hub);
    this.peerSelections = new ReadValue<readonly PeerSelectionInfo[]>([], sameJson, hub);
    this.features = new ReadValue<readonly string[]>([], sameJson, hub);
    this.counts = new ReadValue<ShellCounts>({}, sameJson, hub);
    this.problem = new ReadValue<CoreProblem | null>(null, sameJson, hub);
    this.proofing = new ReadValue<ProofingInfo>(NO_PROOFING, sameJson, hub);
    this.findState = new ReadValue<FindState>(
      { query: '', count: 0, current: null },
      sameJson,
      hub,
    );
    this.threadRanges = new ReadValue<readonly (ThreadRange & { readonly id: string })[]>(
      [],
      sameJson,
      hub,
    );
    this.#deferRemote = config.deferRemoteWhileComposing ?? true;
    this.#requires = [...config.doc.requires];
    const doc = readEnvelope(config.doc, this.#schema);
    this.#sync = initialState(doc);
    this.#state = EditorState.create({
      doc,
      selection: initialSelection(doc),
      plugins: [...this.#plugins(config), ...extraPlugins(this.#schema)],
    });
    register(this, this.#internals());
    this.#publish();
  }

  #plugins(config: CoreConfig): Plugin[] {
    const ids = config.generateId
      ? { types: idTypesOf(CDM1), generate: config.generateId }
      : { types: idTypesOf(CDM1) };
    return [
      guardPlugin(
        {
          access: () => this.#accessValue,
          readOnly: () => this.#locked(),
          refused: (r) => this.#refused(r),
        },
        withParagraphsAfterRegions,
      ),
      referenceGuardPlugin(),
      identifierPlugin(ids),
      trimPlugin((scope) => canWrite(this.#accessValue, this.#locked(), scope)),
      regionParagraphs(),
      bodyGuard(),
      regionClamp(),
      // FE-053 criterion 3: the placeholder of a picture whose upload is under way.
      picturePlaceholderPlugin(),
      // FE-049 criterion 7: the undo and redo keys run through the command registry, so the
      // registry's own checks (the lock, the notice) apply. The key is taken either way.
      keymap({
        'Mod-z': () => {
          this.run('undo');
          return true;
        },
        'Shift-Mod-z': () => {
          this.run('redo');
          return true;
        },
        'Mod-y': () => {
          this.run('redo');
          return true;
        },
      }),
      // One history item per step, never merged, as prosemirror-collab asks: a rebuild's `rebased`
      // count is a count of steps (remote.ts).
      new Plugin({ historyPreserveItems: true }),
      history(),
    ];
  }

  // --- State ---------------------------------------------------------------------------------

  /**
   * Applies a transaction to the state, the sync client's queue and the views. While suggestion mode
   * is on where a local change lands, the change is recorded as suggestions first (FE-041 to FE-043).
   */
  protected dispatchTransaction(input: Transaction): void {
    if (this.#destroyed) return;
    const tr = this.#asSuggestion(input);
    if (tr === null) return; // suggestion mode could not record it, and refused it
    const before = this.#state;
    const { state, transactions } = before.applyTransaction(tr);
    if (state === before) return; // filtered out by the guard (or a sub-editor limit)
    this.#state = state;
    const trimmed = tr.getMeta(trimKey) as { skipped: readonly string[] } | undefined;
    if (trimmed) this.trimmed.set({ n: ++this.#trims, skipped: [...trimmed.skipped] });
    // Local steps go to the queue: the root unless it is remote, and anything appended to it.
    const localSteps: Step[] = [];
    for (const t of transactions)
      if (t.docChanged && t.getMeta(REMOTE) !== true) localSteps.push(...t.steps);
    if (localSteps.length) {
      // `markSet` (exact mark inverses, used by undo) is sent as its inner steps, and an `id`
      // step on a node the same change removes is not sent at all (steps.ts).
      const steps =
        tr.getMeta(REMOTE) === true
          ? localSteps
          : withoutLostIdentifierSteps(localSteps, before.doc, state.doc);
      const queued = flattenSteps(steps);
      if (unconfirmed(this.#sync).length === 0) this.#historyAligned = true;
      // The history holds one item per step of `localSteps`: the queue must hold the same steps.
      if (queued.length !== localSteps.length || queued.some((s, k) => s !== localSteps[k]))
        this.#historyAligned = false;
      for (const t of transactions)
        if (t.docChanged && t.getMeta(REMOTE) !== true && !recordedInHistory(t, tr))
          this.#historyAligned = false;
      this.#sync = local(this.#sync, queued, state.doc);
      this.#session?.localEdit();
    }
    // The comment ranges follow every change, local or remote, with the authority's mapping (FE-048).
    if (this.#comments.ids().length > 0) {
      for (const t of transactions)
        if (t.docChanged) this.#comments.apply(t.mapping.maps, ++this.#commentSeq);
      this.#publishThreadRanges();
    }
    for (const b of this.#bridges) b.update(state, transactions);
    this.#publish();
    const presence = this.#presenceClient;
    if (presence) {
      if (state.doc !== before.doc) presence.refresh();
      if (state.doc !== before.doc || !state.selection.eq(before.selection))
        presence.selectionChanged();
    }
    if (state.doc !== before.doc) this.#proofing?.textChanged();
    for (const listener of this.#listeners) listener(tr, state);
  }

  // --- Proofing (UX-041, UX-042) -------------------------------------------------------------

  /**
   * Gives the core the proofing port (13 §6.1). The body is checked at once and again, a block at
   * a time, after a pause in typing. Findings are drawn as decorations and never change the
   * document. Without a port `proofing.get().available` is false and no control is shown. Returns
   * the function that detaches the port.
   */
  attachProofing(
    port: ProofingPort,
    opts: { docId?: string; clock?: ProofingClock; debounceMs?: number } = {},
  ): () => void {
    this.#proofing?.dispose();
    const controller = new ProofingController(
      {
        doc: () => this.#state.doc,
        canView: (scope) => this.#canView(scope),
        docId: () => opts.docId ?? this.#docId,
        defaultLang: () => stylesOf(this.#state.doc).settings.lang,
        changed: () => {
          if (this.#proofing === controller) this.#publishProofing();
        },
      },
      port,
      {
        clock: opts.clock ?? {
          // Bound wrappers, as the sync client's clock has (browsers refuse an unbound `setTimeout`).
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as never),
        },
        ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
      },
    );
    this.#proofing = controller;
    controller.start();
    this.#publishProofing();
    return () => {
      if (this.#proofing !== controller) return;
      controller.dispose();
      this.#proofing = null;
      this.proofing.set(NO_PROOFING);
    };
  }

  #canView(scope: string): boolean {
    const access = this.#accessValue;
    return access === null || capsOf(access, depScope(scope)).includes('view');
  }

  #publishProofing(): void {
    const p = this.#proofing;
    if (!p || this.#destroyed) return;
    this.proofing.set(p.info(this.#state.selection.head));
  }

  /** The findings that hold for the document now, with their positions (the view draws them). */
  proofingFindings(): readonly LocatedFinding[] {
    return this.#proofing?.locate() ?? [];
  }

  /** The identifier of the finding the last navigation chose, while it is shown. */
  proofingCurrentId(): string | null {
    return this.#proofing?.currentId() ?? null;
  }

  /**
   * Moves the selection to the next finding after the caret (or the previous one), wrapping at the
   * ends. False when there is none. The caret lands on the finding's text; nothing is changed.
   */
  proofingStep(direction: 1 | -1 = 1): boolean {
    const p = this.#proofing;
    if (!p) return false;
    const sel = this.#state.selection;
    const f = p.step(direction === 1 ? sel.to : sel.from, direction, sel.empty);
    if (!f) return false;
    this.dispatchTransaction(
      this.#state.tr
        .setSelection(TextSelection.create(this.#state.doc, f.from, f.to))
        .scrollIntoView(),
    );
    this.#publishProofing();
    return true;
  }

  /**
   * Applies a suggestion of a finding as an ordinary edit (UX-042 criterion 2): it goes through the
   * same guards as typing, and in suggestion mode it is recorded as a suggestion. In a scope the
   * user may not change it is refused as any edit is (FE-036), and false is returned.
   */
  applyFinding(id: string, suggestion = 0): boolean {
    const f = this.#proofing?.find(id);
    const text = f?.suggestions[suggestion];
    if (!f || text === undefined) return false;
    if (!this.canEdit(f.scope)) {
      this.#refused({ reason: this.#locked() ? 'read-only' : 'scope', scopes: [f.scope] });
      return false;
    }
    const before = this.#state.doc;
    this.dispatchTransaction(this.#state.tr.insertText(text, f.from, f.to));
    return this.#state.doc !== before;
  }

  /** Whether a finding's suggestion can be applied now (the menu offers "apply" only then). */
  canApplyFinding(id: string): boolean {
    const f = this.#proofing?.find(id);
    return f !== undefined && f !== null && f.suggestions.length > 0 && this.canEdit(f.scope);
  }

  /** Hides one finding until its text changes (UX-042 criterion 1). */
  ignoreFinding(id: string, everywhere = false): boolean {
    const p = this.#proofing;
    if (!p) return false;
    return everywhere ? p.ignoreEverywhere(id) : p.ignoreOnce(id);
  }

  /** Adds a finding's text to the port's custom dictionary and checks again (UX-042 criterion 3). */
  addFindingToDictionary(id: string): Promise<boolean> {
    return this.#proofing?.addToDictionary(id) ?? Promise.resolve(false);
  }

  /** The words of the custom dictionary for a language; null when the port has no dictionary. */
  dictionaryWords(lang: string): Promise<string[] | null> {
    return this.#proofing?.words(lang) ?? Promise.resolve(null);
  }

  /** Removes a word from the custom dictionary and checks again. */
  removeDictionaryWord(word: string, lang: string): Promise<boolean> {
    return this.#proofing?.removeWord(word, lang) ?? Promise.resolve(false);
  }

  // --- Suggestion mode (FE-041, FE-042, FE-043) ----------------------------------------------

  /** `settings.trackChanges` of the document, read again only when the definitions change. */
  #trackChangesSetting(): 'off' | 'everyone' | undefined {
    const defs = this.#state.doc.firstChild;
    if (this.#trackChanges?.defs === defs) return this.#trackChanges.value;
    let value: 'off' | 'everyone' | undefined;
    defs?.forEach((node) => {
      if (node.type.name !== 'settings') return;
      const v: unknown = node.attrs['trackChanges'];
      if (v === 'off' || v === 'everyone') value = v;
    });
    this.#trackChanges = { defs, value };
    return value;
  }

  /** Suggestion mode in a DEP scope under the requested mode, the access and the document setting. */
  #suggestionIn(scope: string): SuggestionModeState {
    return suggestionMode({
      requested: this.#requested,
      access: this.#accessValue,
      readOnly: this.#locked(),
      trackChanges: this.#trackChangesSetting(),
      scope,
    });
  }

  /**
   * The transaction to apply for a local change: the change itself, or, when suggestion mode is on
   * in a scope it touches, the change recorded as suggestions by this user with identifiers from the
   * core's own source (FE-042, FE-043). Null when suggestion mode cannot record it (a block change,
   * or no user to name): the refusal is recorded, as the guard records one. Remote work, the core's
   * own additions, undo and redo, and a change already recorded or resolving suggestions pass.
   */
  #asSuggestion(tr: Transaction): Transaction | null {
    if (
      !tr.docChanged ||
      tr.getMeta(REMOTE) === true ||
      tr.getMeta(INTERNAL) === true ||
      tr.getMeta(SUGGESTED) === true ||
      isHistoryTransaction(tr)
    )
      return tr;
    const state = this.#state;
    if (tr.before !== state.doc) return tr; // not made from the current state: the guard decides
    const scopes = scopeDiff(state.doc, tr.doc)
      .changed.map(depScope)
      .filter((s) => s === 'body' || s.startsWith('region:') || s.startsWith('story:'));
    if (!scopes.some((s) => this.#suggestionIn(s).on)) return tr;
    const user = this.#user;
    const recorded =
      user === null ? null : recordAsSuggestion(state, tr, { user, nextId: this.#newId });
    if (recorded === null) {
      this.#refused({ reason: 'suggestion', scopes: [...new Set(scopes)].sort() });
      return null;
    }
    return recorded.setMeta(SUGGESTED, true);
  }

  setFeatures(features: readonly string[]): void {
    this.features.set([...features].sort());
  }

  setCounts(counts: ShellCounts): void {
    this.counts.set({ ...counts });
  }

  /** Bound for the views: `dispatchTransaction` of the body view and the sub-editors. */
  protected readonly dispatch = (tr: Transaction): void => this.dispatchTransaction(tr);

  /**
   * Calls `listener` after every applied change, with only whether the document changed and its
   * metadata (`REMOTE` marks remote work).
   *
   * @deprecated Use the read views (`saveState`, `confirmedSeq`); kept for the element's adapter.
   */
  onTransaction(listener: (change: TransactionInfo) => void): () => void {
    const wrapped = (tr: Transaction) => listener(tr);
    this.#listeners.add(wrapped);
    return () => this.#listeners.delete(wrapped);
  }

  protected get editorState(): EditorState {
    return this.#state;
  }

  protected get schema(): Schema {
    return this.#schema;
  }

  /** Registers a view; returns the function that removes it. */
  protected addView(bridge: ViewBridge): () => void {
    this.#bridges.add(bridge);
    return () => this.#bridges.delete(bridge);
  }

  /** What the queries read, at the last publication: a change of any of them is a new revision. */
  #published: {
    doc: PMNode;
    selection: EditorState['selection'];
    marks: readonly Mark[] | null;
    access: Access | null;
    locked: boolean;
  } | null = null;

  #publish(): void {
    const state = this.#state;
    const last = this.#published;
    const locked = this.#locked();
    const changed =
      !last ||
      last.doc !== state.doc ||
      !last.selection.eq(state.selection) ||
      last.marks !== state.storedMarks ||
      last.access !== this.#accessValue ||
      last.locked !== locked;
    if (changed) {
      this.#published = {
        doc: state.doc,
        selection: state.selection,
        marks: state.storedMarks,
        access: this.#accessValue,
        locked,
      };
      this.selection.set(this.#summary(state));
      if (!last || last.doc !== state.doc) {
        this.outline.set(outlineOf(state.doc));
        this.direction.set(stylesOf(state.doc).settings.dir);
      }
      const commands = {} as Record<CommandName, CommandState>;
      for (const name of COMMANDS) commands[name] = this.queryCommand(name);
      this.commands.set(commands);
      this.access.set(this.#accessSummary());
      if (last?.doc !== state.doc) this.#refreshFind();
      this.revision.set(this.revision.get() + 1);
      // A mounted view reads `editable` only when it is given a state or props: a lock that moves
      // without a state change (setMode, setAccess, `read_only`) is passed on here (FE-029).
      if (last && last.locked !== locked) for (const b of this.#bridges) b.lockChanged?.(locked);
    }
    // Outside the check above: a change of mode alone moves suggestion mode too (FE-041).
    const scope = this.#scopeAt(state.selection.from);
    this.suggestion.set({ ...this.#suggestionIn(scope), scope });
    this.#publishProofing();
    this.#publishSync();
  }

  /** Effective access at the selection (07 §4): the scope that limits the selection most. */
  #accessSummary(): AccessSummary {
    const { from, to } = this.#state.selection;
    // A selected placeholder (ADR 0019) is a region the reader may not see: nothing in it is theirs
    // to change, and the shell offers the access request for its scope (UX-104).
    const hiddenScopes = new Set<string>();
    // A node selection is recognised by its `node`, not by `instanceof`: the shell and the core may
    // hold different copies of the state module.
    const sel = this.#state.selection;
    if ('node' in sel && sel.node) {
      const id = placeholderAt(this.#state.doc.resolve(sel.from));
      if (id !== null) hiddenScopes.add(`region:${id}`);
    }
    const scopes = [...new Set([this.#scopeAt(from), this.#scopeAt(to), ...hiddenScopes])];
    const access = this.#accessValue;
    const summaries = scopes.map((scope): AccessSummary => {
      if (hiddenScopes.has(scope)) return { scope, caps: [], limit: 'hidden' };
      if (!access) return { scope, caps: FULL_CAPS, limit: this.#readOnly ? 'locked' : null };
      const caps = capsOf(access, depScope(scope)).filter((c): c is Capability =>
        (FULL_CAPS as readonly string[]).includes(c),
      );
      const writable = caps.includes('edit');
      let limit: AccessLimit | null = null;
      if (this.#readOnly) limit = 'locked';
      else if (!writable) {
        if (scope.startsWith('region:') && access.scopes[scope] === undefined) limit = 'unlisted';
        else if (access.leases[scope] !== undefined) limit = 'lease';
        else if (scope.startsWith('region:') && canWrite(access, false, 'body')) limit = 'region';
        else limit = 'role';
      }
      return {
        scope,
        caps: this.#readOnly ? caps.filter((c) => c === 'view' || c === 'comment') : caps,
        limit,
      };
    });
    // Hidden content is what limits the reader most: it is reported ahead of the other limits.
    const hiddenSummary = summaries.find((s) => s.limit === 'hidden');
    if (hiddenSummary) return hiddenSummary;
    return summaries.reduce((a, b) => (b.limit !== null && a.limit === null ? b : a));
  }

  /** Answers a named query of the document API (13 §4; ADR 0041). */
  query(name: string): boolean | undefined {
    switch (name as CoreQueryName) {
      case 'canEditSelection':
        return this.#selectionEditable();
      case 'canUndo':
        return this.queryCommand('undo').enabled;
      case 'canRedo':
        return this.queryCommand('redo').enabled;
      case 'isBold':
        return markActive(this.#state, 'bold');
      case 'isItalic':
        return markActive(this.#state, 'italic');
      case 'canInsertFootnote':
        return this.queryCommand('insertFootnote').enabled;
      case 'hasHeader':
        return this.queryCommand('editHeader').enabled;
      case 'canInsertField':
        // A form field of the palette's first kind stands for the palette (FRW-072 criterion 1).
        return this.queryCommand('insertField', { field: { kind: 'text' } }).enabled;
      case 'canMarkRegion':
        return this.queryCommand('markRegion', { title: REGION_QUERY_TITLE }).enabled;
      default:
        return undefined;
    }
  }

  /**
   * Why a named query answered false (13 §4; ui `CoreApi.queryReason`), as a code the shell states
   * as `reason.query.<code>`. Only `canMarkRegion` gives one: `suggestion` when suggestion mode
   * cannot record a region (FE-044 criterion 5), `locked`, `nested` inside a region (PRM-033
   * criterion 2), `structure` without the right to change the body and the document's structure, and
   * `blocks` for a selection that is not whole blocks of the body. Null otherwise.
   */
  queryReason(name: string): string | null {
    if (name !== 'canMarkRegion') return null;
    const state = this.queryCommand('markRegion', { title: REGION_QUERY_TITLE });
    if (state.enabled) return null;
    if (state.reason === 'suggestion') return 'suggestion';
    if (this.#locked()) return 'locked';
    const { from, to } = this.#state.selection;
    if (this.#scopeAt(from) !== 'body' || this.#scopeAt(to) !== 'body') return 'nested';
    if (!this.canEdit('body') || !this.canEdit('doc')) return 'structure';
    return 'blocks';
  }

  #publishSync(): void {
    const s = this.#sync;
    this.confirmedSeq.set(s.seq);
    this.syncSummary.set({
      seq: s.seq,
      incarnation: s.incarnation,
      inflight: s.inflight?.id ?? null,
      queued: s.queue.length,
    });
    const conn = this.connection.get();
    const save: SaveState = this.#readOnly
      ? 'readonly'
      : settled(s)
        ? 'saved'
        : conn === 'online' && !this.#journalFailed && !this.#serviceUnavailable
          ? 'saving'
          : 'unsaved';
    this.saveState.set(save);
    this.status.set({ connection: conn === 'detached' ? 'offline' : conn, sync: save });
    // Presence carries the confirmed seq: a new one is published (deduplicated, rate-limited).
    this.#presenceClient?.selectionChanged();
    if (settled(s)) for (const w of this.#waiters.splice(0)) w.resolve();
  }

  #summary(state: EditorState): SelectionSummary {
    const { $from, empty } = state.selection;
    const r = regionAt($from);
    let title: string | null = null;
    if (r) {
      const node = state.doc.nodeAt(r.pos);
      title = typeof node?.attrs['title'] === 'string' ? node.attrs['title'] : '';
    }
    const marks = marksAt(state)
      .filter((m) => m.attrs['value'] !== false)
      .map((m) => m.type.name)
      .sort();
    return {
      empty,
      scope: r ? 'region' : 'body',
      region: title,
      style: currentStyle(state),
      marks: [...new Set(marks)],
    };
  }

  // --- Region guard and access (FE-036) ------------------------------------------------------

  #refused(r: Refusal): void {
    this.#refusals++;
    this.refusal.set({
      n: this.#refusals,
      reason: r.reason,
      scopes: [...r.scopes],
      ...(r.count === undefined ? {} : { count: r.count }),
    });
  }

  setAccess(access: Access | null): void {
    this.#accessValue = access;
    this.permissions.set(access);
    this.#proofing?.accessChanged();
    // `read_only` ends when an access with a newer revision grants a write capability again.
    if (
      this.#readOnly &&
      access &&
      access.rev > this.#readOnlyRev &&
      access.caps.some((c) => c === 'edit' || c === 'suggest' || c === 'fill')
    )
      this.#readOnly = false;
    this.#refreshMode();
    this.#publish();
  }

  #setReadOnly(on: boolean): void {
    this.#readOnly = on;
    if (on) this.#readOnlyRev = this.#accessValue?.rev ?? -1;
    this.#publish();
  }

  /**
   * Whether local edits are refused: a `read_only` rejection (04 §8) or the effective mode (FE-029:
   * `view` and `fill`). The editing surface follows it (the view's `editable`).
   */
  get readOnly(): boolean {
    return this.#locked();
  }

  /** Whether no local change is allowed now, for whichever reason. */
  #locked(): boolean {
    return this.#readOnly || modeLocks(this.#effective);
  }

  /** Recomputes the effective mode under the access in force; publishes it when it moved (FE-029). */
  #refreshMode(): void {
    const effective = effectiveMode(this.#requested, this.#accessValue);
    if (effective === this.#effective && this.mode.get().requested === this.#requested) return;
    this.#effective = effective;
    this.mode.set({ requested: this.#requested, effective });
  }

  /**
   * Sets the requested mode (the host's `mode` attribute). The effective mode is the most restrictive
   * one the access allows. Nothing is sent or dropped: unconfirmed work stays in the queue (FE-029
   * criterion 7).
   */
  setMode(mode: EditMode): void {
    this.#requested = mode;
    this.#refreshMode();
    this.#publish();
  }

  /** The DEP scope of a position (05 §5.3). */
  #scopeAt(pos: number): string {
    const r = regionAt(this.#state.doc.resolve(pos));
    return r ? `region:${r.id ?? ''}` : 'body';
  }

  /**
   * The DEP scope of any position of `doc` (05 §5.3): the definitions, a story, a region or the body.
   * The authoring commands ask the guard about this scope, so a page setup is checked as `defs`.
   */
  #scopeIn(doc: PMNode, pos: number): string {
    const $pos = doc.resolve(pos);
    const top = $pos.depth > 0 ? $pos.node(1) : null;
    if (top?.type.name === 'defs') return 'defs';
    if (top?.type.name === 'story') return `story:${String(top.attrs['id'])}`;
    const r = regionAt($pos);
    return r ? `region:${r.id ?? ''}` : 'body';
  }

  /**
   * What a permission rejection names, for the recovered-edits pane (PRM-024; 07 §9): the scopes it
   * refused, with a `field:<id>` scope given as the scope the field lies in on the confirmed
   * document and an authority `defs:*` scope as `defs`; who changed the permissions, and when, as
   * the last control commit the client received says. Nothing for any other reason.
   */
  #rejectionWords(
    i: Discarded,
  ): Pick<RecoveredItem, 'scope' | 'scopes' | 'changedBy' | 'changedAt'> | Record<string, never> {
    if (!i.scopes) return {};
    const doc = this.#sync.confirmed;
    const scopes: string[] = [];
    for (const raw of i.scopes) {
      let scope: string | null = raw.startsWith('defs:') ? 'defs' : raw;
      if (raw.startsWith('field:')) {
        const id = raw.slice('field:'.length);
        let at = -1;
        doc.descendants((n, pos) => {
          if (at < 0 && n.type.name === 'form_field' && n.attrs['id'] === id) at = pos;
          return at < 0;
        });
        scope = at < 0 ? null : this.#scopeIn(doc, at);
      }
      if (scope !== null && !scopes.includes(scope)) scopes.push(scope);
    }
    return {
      scope: scopes.find((s) => s.startsWith('region:')) ?? scopes[0] ?? null,
      scopes,
      changedBy: i.change?.user ?? null,
      changedAt: i.change?.time ?? null,
    };
  }

  canEdit(scope: string): boolean {
    return canWrite(this.#accessValue, this.#locked(), scope);
  }

  selectionScope(): SelectionScope {
    // A focused sub-editor (a header, a footer or a footnote panel) holds the caret, so its
    // position in the main document is the one that counts (FE-026 criterion 3).
    return this.#scopeOfPosition(this.#focusedPosition() ?? this.#state.selection.$from.pos);
  }

  /** The main-document position of a focused sub-editor's caret, or null when none has focus. */
  #focusedPosition(): number | null {
    for (const b of this.#bridges) {
      const pos = b.focusedPosition?.() ?? null;
      if (pos !== null) return pos;
    }
    return null;
  }

  /** The main selection's scope, whatever sub-editor has focus (presence reports this). */
  #mainScope(): string {
    return this.#scopeOfPosition(this.#state.selection.$from.pos).scope;
  }

  /** The scope and block identifier of a position of the main document (FE-026 criterion 3). */
  #scopeOfPosition(pos: number): SelectionScope {
    const doc = this.#state.doc;
    const $from = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    // The scope of the position in the whole document: the definitions and a story as well as a
    // region and the body.
    const scope = this.#scopeIn(doc, $from.pos);
    let blockId: string | null = null;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.isTextblock && typeof node.attrs['id'] === 'string') {
        blockId = node.attrs['id'];
        break;
      }
    }
    if (blockId === null) {
      const after = $from.nodeAfter;
      if (after && typeof after.attrs['id'] === 'string') blockId = after.attrs['id'];
    }
    return { scope, blockId };
  }

  // --- Commands (FE-026; FE-127) -------------------------------------------------------------

  /**
   * Runs or checks an authoring command (FE-133, FE-137, FE-140), or null when its arguments are
   * missing. `writable` is the region guard's `canWrite` for the scope of a position, so a scope the
   * user may not change refuses the command before any transaction is made (07 §5.3, §7).
   */
  #authoring(
    name: CommandName,
    args: CommandArgs,
    state: EditorState,
    dispatch?: (tr: Transaction) => void,
  ): AuthoringOutcome | null {
    const writable = (pos: number): boolean => this.canEdit(this.#scopeIn(state.doc, pos));
    switch (name) {
      case 'insertCitation': {
        if (args.citation === undefined) return null;
        const items = citationItems(args.citation.items);
        if (items === null) return { ok: false, reason: 'bad-label' };
        const mode = args.citation.mode;
        return insertCitation(
          state,
          items,
          mode === undefined ? { writable } : { writable, mode },
          dispatch,
        );
      }
      case 'addLink': {
        if (args.href === undefined) return null;
        const options = args.title === undefined ? { writable } : { writable, title: args.title };
        return addLink(state, args.href, options, dispatch);
      }
      case 'insertBookmark':
        return args.name === undefined
          ? null
          : insertBookmark(state, args.name, { writable }, dispatch);
      case 'followInternalLink': {
        if (args.href === undefined) return null;
        const moved = followInternalLink(state, args.href, dispatch);
        return moved === 'moved' ? { ok: true } : { ok: false, reason: moved };
      }
      case 'setPageSetup': {
        if (args.pageSetup === undefined) return null;
        const { id, changes } = args.pageSetup;
        // Turning on a variant creates its stories in the same step (FE-137 criterion 2).
        return setPageSetup(
          state,
          id,
          changes as PageSetupChanges,
          { writable, storyIdOf: () => this.#newId() },
          dispatch,
        );
      }
      case 'insertBreak':
        return args.breakKind === undefined
          ? null
          : insertBreak(state, args.breakKind, { writable }, dispatch);
      case 'insertSectionBreak':
        // The guard also asks for `structure` (P2) when the change adds a section break (guard.ts).
        return args.section === undefined
          ? null
          : insertSectionBreak(
              state,
              {
                start: args.section.start,
                sectionId: this.#newId(),
                pageSetupId: this.#newId(),
                writable,
              },
              dispatch,
            );
      case 'insertField': {
        const field = args.field;
        if (field === undefined) return null;
        const options = {
          ...fieldOptions(field, writable),
          formFields: this.#requires.includes('fields'),
        };
        if (field.story === undefined) return insertField(state, field.kind, options, dispatch);
        const inStory = this.#caretInStory(state, field.story.id, field.story.pos);
        if (inStory === null) return { ok: false, reason: 'not-in-story' };
        return insertField(
          inStory,
          field.kind,
          options,
          dispatch && ((tr) => dispatch(replayOn(state, tr))),
        );
      }
      case 'insertToc':
        return args.toc === undefined
          ? null
          : insertToc(state, this.#newId(), args.toc, { writable }, dispatch);
      case 'insertSymbol':
        return args.symbol === undefined
          ? null
          : insertSymbol(state, args.symbol, { writable }, dispatch);
      case 'insertCaption':
        return args.figure === undefined
          ? null
          : insertCaption(state, args.figure, { writable }, dispatch);
      case 'insertReference': {
        const ref = args.reference;
        if (ref === undefined) return null;
        return insertReference(state, ref.target, ref.format ?? null, { writable }, dispatch);
      }
      case 'setEquationLatex': {
        const eq = args.equation;
        if (eq === undefined) return null;
        const { pos, latex } = eq;
        if (!Number.isInteger(pos) || pos < 0 || pos >= state.doc.content.size)
          return { ok: false, reason: 'not-equation' };
        if (typeof latex !== 'string') return { ok: false, reason: 'not-latex' };
        return setEquationLatex(state, pos, latex, { writable }, dispatch);
      }
      default:
        return null;
    }
  }

  /**
   * A state on the same document with the caret at `pos` of the story `id`, counted as the story's
   * sub-editor counts it (the story node is its document, so the main position is the story's
   * position plus one plus `pos`). Null when there is no such story or `pos` is outside it. The core's
   * own selection stays in the body (body.ts); this is how a command reaches a header or footer.
   */
  #caretInStory(state: EditorState, id: string, pos: number): EditorState | null {
    let start = -1;
    let size = 0;
    state.doc.forEach((node, offset) => {
      if (start < 0 && node.type.name === 'story' && node.attrs['id'] === id) {
        start = offset + 1;
        size = node.content.size;
      }
    });
    if (start < 0 || !Number.isInteger(pos) || pos < 1 || pos >= size) return null;
    const $pos = state.doc.resolve(start + pos);
    if (!$pos.parent.inlineContent) return null;
    return EditorState.create({
      doc: state.doc,
      selection: TextSelection.create(state.doc, $pos.pos),
    });
  }

  #command(name: CommandName, args: CommandArgs = {}): Command | null {
    const s = this.#schema;
    if (isTableOp(name)) return tableCommand(name);
    if (name === 'mergeCells') return isCellRect(args.cells) ? mergeCellsCommand(args.cells) : null;
    if (name === 'splitCell') return splitCellCommand();
    if (name === 'setTableStyle')
      return args.tableStyle === undefined ? null : setTableStyle(args.tableStyle);
    if (name === 'sortTableRows')
      return args.sortDirection === undefined
        ? null
        : sortTableRows(args.sortDirection, args.sortColumn);
    if (name === 'resizeFigure')
      return args.figurePos === undefined || args.figureSize === undefined
        ? null
        : resizeFigure(args.figurePos, args.figureSize);
    if (name === 'setFigureLayout')
      return args.figurePos === undefined || args.figureLayout === undefined
        ? null
        : setFigureLayout(args.figurePos, args.figureLayout);
    if (name === 'increaseIndent' || name === 'decreaseIndent')
      return changeIndent(name === 'increaseIndent' ? 'increase' : 'decrease', (pos) =>
        this.canEdit(this.#scopeAt(pos)),
      );
    if (name === 'nextEditableRegion') return nextEditableRegion((scope) => this.canEdit(scope));
    if (name === 'markRegion')
      return args.title === undefined
        ? null
        : markRegion(args.title, this.#newId, this.canEdit('body') && this.canEdit('doc'));
    if (name === 'renameRegion')
      return args.region === undefined || args.title === undefined
        ? null
        : renameRegion(
            args.region,
            args.title,
            (this.#accessValue?.caps.includes('structure') ?? false) &&
              this.canEdit(`region:${args.region}`),
          );
    if (name === 'setRegionPolicy')
      return args.region === undefined || args.policy === undefined
        ? null
        : setRegionPolicy(
            args.region,
            args.policy,
            this.#accessValue?.caps.includes('manage') ?? false,
          );
    switch (name) {
      case 'insertCitation':
      case 'addLink':
      case 'insertBookmark':
      case 'followInternalLink':
      case 'setPageSetup':
      case 'insertBreak':
      case 'insertSectionBreak':
      case 'insertField':
      case 'insertToc':
      case 'insertSymbol':
      case 'insertCaption':
      case 'insertReference':
      case 'setEquationLatex':
        if (!hasAuthoringArgs(name, args)) return null;
        return (state, dispatch) => this.#authoring(name, args, state, dispatch)?.ok === true;
      case 'bold':
        return toggleMark(s.marks['bold']!, { value: true }, WHOLE_SELECTION);
      case 'italic':
        return toggleMark(s.marks['italic']!, { value: true }, WHOLE_SELECTION);
      case 'underline':
        return toggleMark(s.marks['underline']!, { style: 'single' }, WHOLE_SELECTION);
      case 'strike':
        return toggleMark(s.marks['strike']!, { value: true }, WHOLE_SELECTION);
      case 'smallCaps':
        return toggleMark(s.marks['smallCaps']!, { value: true }, WHOLE_SELECTION);
      case 'allCaps':
        return toggleMark(s.marks['allCaps']!, { value: true }, WHOLE_SELECTION);
      case 'superscript':
        return verticalAlignCommand(s.marks['vertAlign']!, 'super');
      case 'subscript':
        return verticalAlignCommand(s.marks['vertAlign']!, 'sub');
      case 'fontFamily':
      case 'fontSize':
      case 'color':
      case 'highlight':
      case 'lang':
      case 'charStyle':
      case 'clearFormatting':
        return valueFormatCommand(name, args, s);
      case 'applyList':
      case 'removeList':
      case 'listLevelUp':
      case 'listLevelDown':
      case 'restartNumbering':
      case 'continueNumbering':
        return listCommand(name, args, (pos) => this.canEdit(this.#scopeAt(pos)));
      case 'selectAll':
        return selectAllInBody;
      case 'undo':
        return historyCommand(undo);
      case 'redo':
        return historyCommand(redo);
      case 'paragraphStyle':
        return args.style === undefined
          ? null
          : setParagraphStyle(args.style, (pos) => this.canEdit(this.#scopeAt(pos)));
      case 'insertFootnote':
        return (state, dispatch) => {
          const insert = insertFootnote(s);
          if (!dispatch) return insert(state);
          const at = state.selection.from;
          return insert(state, (tr) => {
            dispatch(tr);
            const node = this.#state.doc.nodeAt(tr.mapping.map(at, -1));
            const id = node?.type.name === 'footnote' ? node.attrs['id'] : null;
            if (typeof id === 'string') this.openFootnote(id);
          });
        };
      case 'editHeader':
        return (state, dispatch) => {
          let id: string | null = null;
          state.doc.forEach((node) => {
            if (id === null && node.type.name === 'story' && node.attrs['kind'] === 'header')
              id = String(node.attrs['id']);
          });
          // FE-057 criterion 2: with no header story yet, the default header is created first.
          if (id === null) return this.#createHeaderStory(state, dispatch);
          // 07 §7 (FE-056 criterion 6): disabled for a person who may not change the story.
          if (!this.canEdit(`story:${id}`)) return false;
          return dispatch ? this.openStory(id) : true;
        };
    }
  }

  /**
   * FE-057 criterion 2: a document with no header story gets its default header story when the
   * person starts to edit the header. The creation is one transaction through the guard, so a
   * refusal leaves no story behind and the command reports false.
   */
  #createHeaderStory(
    state: EditorState,
    dispatch: ((tr: Transaction) => void) | undefined,
  ): boolean {
    let setupId: string | null = null;
    state.doc.forEach((node) => {
      if (node.type.name !== 'defs') return;
      node.forEach((child) => {
        if (setupId === null && child.type.name === 'page_setup')
          setupId = String(child.attrs['id']);
      });
    });
    if (setupId === null) return false;
    // An availability check (no dispatch) must not draw from the id source: the toolbar asks on
    // every update, and each draw would shift the ids later suggestions and stories receive.
    if (!dispatch) return createVariantStory(state, setupId, 'header', 'default', 'probe') !== null;
    const storyId = this.#newId();
    const tr = createVariantStory(state, setupId, 'header', 'default', storyId);
    if (tr === null) return false;
    dispatch(tr);
    let present = false;
    this.#state.doc.forEach((node) => {
      if (node.type.name === 'story' && node.attrs['id'] === storyId) present = true;
    });
    return present ? this.openStory(storyId) : false;
  }

  /**
   * Whether a command needs the selection to be editable. Undo and redo do not (the guard refuses
   * them where they would touch a protected scope); a paragraph style filters paragraphs itself.
   */
  static #needsEditableSelection(name: CommandName): boolean {
    return (
      name === 'bold' ||
      name === 'italic' ||
      name === 'underline' ||
      name === 'strike' ||
      name === 'smallCaps' ||
      name === 'allCaps' ||
      name === 'superscript' ||
      name === 'subscript' ||
      name === 'insertFootnote' ||
      isValueFormat(name) ||
      LIST_COMMANDS.has(name)
    );
  }

  /** Whether a command changes the document. */
  static #changes(name: CommandName): boolean {
    return (
      name !== 'selectAll' &&
      name !== 'editHeader' &&
      name !== 'followInternalLink' &&
      name !== 'nextEditableRegion'
    );
  }

  #allowed(name: CommandName): boolean {
    if (this.#locked() && DocumentCore.#changes(name)) return false;
    return !DocumentCore.#needsEditableSelection(name) || this.#selectionEditable();
  }

  /** Whether the caret's table lies in a scope where suggestion mode records a change (FE-045). */
  #suggestsTable(): boolean {
    const loc = locateCell(this.#state.selection.$from);
    return loc !== null && this.#suggestionIn(this.#scopeAt(loc.tablePos)).on;
  }

  /**
   * A row or table operation recorded as suggestions by this user (FE-045). Any operation the
   * suggestion builder does not record is refused with the `suggestion` reason, as a change
   * suggestion mode cannot record is.
   */
  #runSuggestedTable(op: TableOp): boolean {
    const state = this.#state;
    const loc = locateCell(state.selection.$from);
    const user = this.#user;
    const result =
      loc === null || user === null
        ? null
        : suggestTableOp(state, op, { user, nextId: this.#newId });
    if (result === null || !('tr' in result)) {
      this.#refused({
        reason: 'suggestion',
        scopes: loc === null ? [] : [this.#scopeAt(loc.tablePos)],
      });
      return false;
    }
    this.dispatch(result.tr.setMeta(SUGGESTED, true).scrollIntoView());
    this.focus();
    return true;
  }

  /**
   * Merging or splitting cells under suggestion mode (FE-045 criterion 5): no block suggestion for
   * cells is defined in version 1, so the command is refused with the `suggestion` reason and the
   * document does not change.
   */
  #refuseSuggestedSpan(): false {
    const loc = locateCell(this.#state.selection.$from);
    this.#refused({
      reason: 'suggestion',
      scopes: loc === null ? [] : [this.#scopeAt(loc.tablePos)],
    });
    return false;
  }

  run(name: CommandName, args?: CommandArgs): boolean {
    const command = this.#command(name, args);
    if (!command || !this.#allowed(name)) return false;
    if (isTableOp(name) && this.#suggestsTable()) return this.#runSuggestedTable(name);
    if ((name === 'mergeCells' || name === 'splitCell') && this.#suggestsTable())
      return this.#refuseSuggestedSpan();
    // FE-131 criterion 4: a sort under suggestion mode is unavailable (ADR 0365, proposed), and it
    // is refused as a span change is: with the `suggestion` reason and no change.
    if (name === 'sortTableRows' && this.#suggestsTable()) return this.#refuseSuggestedSpan();
    if (BLOCK_ONLY_COMMANDS.has(name) && this.queryCommand(name, args).reason === 'suggestion') {
      // FE-044 criterion 5: refused with the reason, and the document does not change.
      this.#refused({
        reason: 'suggestion',
        scopes: [this.#scopeAt(args?.figurePos ?? this.#state.selection.from)],
      });
      return false;
    }
    const done = command(this.#state, this.dispatch);
    if (done && name !== 'insertFootnote' && name !== 'editHeader') this.focus();
    return done;
  }

  exec(name: CommandName, args?: CommandArgs): boolean {
    return this.run(name, args);
  }

  #selectionEditable(): boolean {
    if (this.#locked()) return false;
    const { from, to } = this.#state.selection;
    return this.canEdit(this.#scopeAt(from)) && this.canEdit(this.#scopeAt(to));
  }

  /**
   * The decorations of the review tools' markup view `view` for the current document (FE-046), as
   * plain specs; the web view builds the decoration set from them.
   */
  markupDecorations(view: MarkupView): SuggestionSpec[] {
    return suggestionSpecs(this.#state.doc, view);
  }

  /**
   * The continuous section breaks whose page setup changes a margin (FE-135 criterion 6). The core
   * only computes them; the view decides how to show them, and the criterion stays open until it does.
   */
  sectionWarnings(): SectionWarning[] {
    return sectionWarnings(this.#state.doc);
  }

  /** The document's sources in the order of its definitions, each with where it is cited (UX-103). */
  sources(): SourceInfo[] {
    return listSources(this.#state.doc);
  }

  /**
   * Adds, changes or deletes a source definition (UX-103; CDM-052). The change is a transaction on
   * the definitions, so it passes the region guard (`defs` needs `structure`, 07 §4) and leaves as a
   * commit like any other. A cited source is not deleted (I4): the answer names where it is cited.
   * With `check`, only says whether the change would be made.
   */
  editSource(edit: SourceEdit, check = false): SourceEditOutcome {
    if (this.#locked()) return { ok: false, reason: 'read-only' };
    const state = this.#state;
    const writable = (pos: number): boolean => this.canEdit(this.#scopeIn(state.doc, pos));
    const dispatch = check ? undefined : this.dispatch;
    let outcome: SourceEditOutcome;
    if (edit.op === 'add') outcome = addSource(state, edit.id, edit.values, { writable }, dispatch);
    else if (edit.op === 'update')
      outcome = updateSource(state, edit.id, edit.values, { writable }, dispatch);
    else if (!this.canEdit('defs')) outcome = { ok: false, reason: 'read-only' };
    else outcome = deleteSource(state, edit.id, dispatch);
    // The guard has the last word: a transaction it refused leaves the document as it was.
    if (outcome.ok && !check && this.#state.doc.eq(state.doc))
      return { ok: false, reason: 'read-only' };
    return outcome;
  }

  /**
   * Sets the client's copy of a thread's range, as the service reports it at `seq` (FE-048). The
   * range is drawn at once and mapped through every later change.
   */
  setThreadRange(threadId: string, range: { from: number; to: number }, seq: number): void {
    this.#comments.set(threadId, range, seq);
    this.#publishThreadRanges();
  }

  /** Removes a thread's range (the thread was deleted) (FE-048). */
  removeThreadRange(threadId: string): void {
    this.#comments.remove(threadId);
    this.#publishThreadRanges();
  }

  #publishThreadRanges(): void {
    this.threadRanges.set(this.#comments.ids().map((id) => ({ id, ...this.#comments.get(id)! })));
  }

  queryCommand(name: CommandName, args?: CommandArgs): CommandState {
    const state = this.#state;
    if (BLOCK_ONLY_COMMANDS.has(name)) {
      // A block change suggestion mode cannot record is unavailable there, and says why (FE-044
      // criterion 5). Suggestion mode is off in a locked document, so the lock needs no check here.
      const at = args?.figurePos ?? state.selection.from;
      if (this.#suggestionIn(this.#scopeAt(at)).on)
        return { enabled: false, active: false, reason: 'suggestion' };
    }
    if (isTableOp(name)) {
      // A table command says why it is unavailable (FE-040): a lock first, then the table.
      // Under suggestion mode a row or table change is recorded as a suggestion; the rest is refused.
      const suggestionRefusal =
        this.#suggestsTable() && !SUGGESTED_TABLE_OPS.has(name) ? 'suggestion' : null;
      const reason = this.#locked()
        ? 'read-only'
        : (tableRefusal(state, name) ?? suggestionRefusal);
      return reason === null
        ? { enabled: true, active: false }
        : { enabled: false, active: false, reason };
    }
    if (name === 'mergeCells' || name === 'splitCell') {
      // Merge and split (FE-040 criterion 3) say why they are unavailable, as the table commands do:
      // a lock first, then the caret's table (outside one, a scope `canEdit` refuses, the spans).
      if (this.#locked()) return { enabled: false, active: false, reason: 'read-only' };
      // Under suggestion mode neither can be recorded (FE-045 criterion 5), whatever the spans are.
      if (this.#suggestsTable()) return { enabled: false, active: false, reason: 'suggestion' };
      if (name === 'mergeCells' && args?.cells === undefined)
        return { enabled: false, active: false };
      const refusal = spanRefusal(state, name, args?.cells);
      return refusal === null
        ? { enabled: true, active: false }
        : { enabled: false, active: false, reason: refusal };
    }
    if (name === 'setTableStyle' || name === 'sortTableRows') {
      // Table styles and sorting (FE-131) say why they are unavailable, as the table commands do.
      if (this.#locked()) return { enabled: false, active: false, reason: 'read-only' };
      // Under suggestion mode a sort cannot be recorded (FE-131 criterion 4; ADR 0365, proposed).
      if (name === 'sortTableRows' && this.#suggestsTable())
        return { enabled: false, active: false, reason: 'suggestion' };
      if (name === 'sortTableRows' && args?.sortDirection === undefined)
        return { enabled: false, active: false };
      const refusal =
        name === 'setTableStyle'
          ? tableStyleRefusal(state, args?.tableStyle ?? null)
          : sortRefusal(state, args?.sortColumn);
      return refusal === null
        ? { enabled: true, active: false }
        : { enabled: false, active: false, reason: refusal };
    }
    if (name === 'resizeFigure' || name === 'setFigureLayout') {
      // Figure size and layout (FE-132) say why they are unavailable, through the figure's guard.
      if (this.#locked()) return { enabled: false, active: false, reason: 'read-only' };
      if (args?.figurePos === undefined) return { enabled: false, active: false };
      const refusal =
        name === 'resizeFigure'
          ? args.figureSize === undefined
            ? undefined
            : figureRefusal(state, args.figurePos, { size: args.figureSize })
          : args.figureLayout === undefined
            ? undefined
            : figureRefusal(state, args.figurePos, { layout: args.figureLayout });
      if (refusal === undefined) return { enabled: false, active: false };
      return refusal === null
        ? { enabled: true, active: false }
        : { enabled: false, active: false, reason: refusal };
    }
    if (AUTHORING.has(name)) {
      // An authoring command says why it is unavailable where the reason is the guard (a lock, or a
      // scope the user may not change: 07 §5.3, §7) or the link and bookmark rules (I9; FE-133).
      if (this.#locked() && DocumentCore.#changes(name))
        return { enabled: false, active: false, reason: 'read-only' };
      const outcome = this.#authoring(name, args ?? {}, state);
      if (outcome === null) return { enabled: false, active: false };
      if (outcome.ok) return { enabled: true, active: false };
      const reason = authoringReason(outcome.reason);
      return reason === null
        ? { enabled: false, active: false }
        : { enabled: false, active: false, reason };
    }
    const command = this.#command(name, args);
    const applicable = command !== null && command(state);
    let enabled = applicable && this.#allowed(name);
    let active = false;
    switch (name) {
      case 'bold':
      case 'italic':
      case 'strike':
      case 'smallCaps':
      case 'allCaps':
        active = markActive(state, name);
        break;
      case 'underline':
        active = marksAt(state).some(
          (m) => m.type.name === 'underline' && m.attrs['style'] !== 'none',
        );
        break;
      case 'superscript':
      case 'subscript':
        active = marksAt(state).some(
          (m) =>
            m.type.name === 'vertAlign' &&
            m.attrs['value'] === (name === 'superscript' ? 'super' : 'sub'),
        );
        break;
      case 'undo':
        enabled = enabled && undoDepth(state) > 0;
        break;
      case 'redo':
        enabled = enabled && redoDepth(state) > 0;
        break;
      case 'paragraphStyle':
        active = args?.style !== undefined && currentStyle(state) === args.style;
        break;
      case 'editHeader': {
        // FE-056 criterion 6 (07 §7): a header the user may not change disables the command and
        // says why; with no header there is no reason to give.
        let headerId: string | null = null;
        state.doc.forEach((node) => {
          if (headerId === null && node.type.name === 'story' && node.attrs['kind'] === 'header')
            headerId = String(node.attrs['id']);
        });
        if (headerId !== null && !this.canEdit(`story:${headerId}`))
          return { enabled: false, active: false, reason: 'no-access' };
        break;
      }
      default:
        break;
    }
    return { enabled, active };
  }

  activeMarks(): string[] {
    return this.#summary(this.#state).marks;
  }

  paragraphStyles(): StyleInfo[] {
    return paragraphStyles(this.#state.doc);
  }

  /** Whether `id` names a paragraph style of the document. */
  hasParagraphStyle(id: string): boolean {
    return isParagraphStyle(this.#state.doc, id);
  }

  // --- Find and replace (FE-059, FE-060) -----------------------------------------------------

  /** Recomputes the matches after a change of the document; the current one stays in range. */
  #refreshFind(): void {
    const f = this.#find;
    f.matches = findMatches(this.#state.doc, f.query);
    if (f.matches.length === 0) f.current = null;
    else if (f.current !== null) f.current = Math.min(f.current, f.matches.length - 1);
    this.#publishFind();
  }

  #publishFind(): void {
    const f = this.#find;
    this.findState.set({
      query: f.query,
      count: f.matches.length,
      current: f.current === null ? null : f.current + 1,
    });
  }

  /** Preserved atoms whose fallback text holds the current query, which the search skipped (FE-139 criterion 4). */
  skippedPreservedFind(): number {
    return skippedPreservedAtoms(this.#state.doc, this.#find.query);
  }

  findText(query: string): FindState {
    this.#find = { query, matches: findMatches(this.#state.doc, query), current: null };
    this.#publishFind();
    return this.findState.get();
  }

  clearFind(): void {
    this.#find = { query: '', matches: [], current: null };
    this.#publishFind();
  }

  findResults(): FindResult[] {
    return this.#find.matches.map((m, index) => ({
      index,
      blockId: m.blockId,
      scope: m.scope,
      before: m.before,
      text: m.text,
      after: m.after,
    }));
  }

  /** Moves the selection to the next or previous match; the selection is the only change. */
  #stepFind(direction: 1 | -1): boolean {
    const f = this.#find;
    const n = f.matches.length;
    if (n === 0) return false;
    const next =
      f.current === null ? (direction === 1 ? 0 : n - 1) : (f.current + direction + n) % n;
    f.current = next;
    const m = f.matches[next]!;
    const selection = TextSelection.create(this.#state.doc, m.from, m.to);
    // The match scrolls into view in the web view (FE-059 criterion 2).
    this.dispatchTransaction(this.#state.tr.setSelection(selection).scrollIntoView());
    this.#publishFind();
    return true;
  }

  findNext(): boolean {
    return this.#stepFind(1);
  }

  findPrevious(): boolean {
    return this.#stepFind(-1);
  }

  /**
   * Replaces the current match. A match in a scope the user may not change is not touched: the
   * refusal is recorded as the guard records one (FE-036).
   */
  replaceCurrent(text: string): ReplaceReport {
    const f = this.#find;
    const m = f.current === null ? undefined : f.matches[f.current];
    if (!m) return { replaced: 0, skipped: 0 };
    if (!this.canEdit(m.scope)) {
      this.#refused({ reason: this.#locked() ? 'read-only' : 'scope', scopes: [m.scope] });
      return { replaced: 0, skipped: 1 };
    }
    const before = this.#state.doc;
    this.dispatchTransaction(this.#state.tr.insertText(text, m.from, m.to));
    // The guard may still refuse the change (a placeholder, an invariant): the document says so.
    const done = this.#state.doc !== before;
    return { replaced: done ? 1 : 0, skipped: done ? 0 : 1 };
  }

  /**
   * Replaces every match in a scope the user may change, as one change, so that one undo takes
   * them back. Matches in other scopes are skipped and counted; when nothing is replaced, the
   * refusal is recorded once with the scopes that blocked it.
   */
  replaceAll(text: string): ReplaceReport {
    const f = this.#find;
    const tr = this.#state.tr;
    const blocked = new Set<string>();
    let editable = 0;
    // Last match first: a change does not move the matches before it.
    for (let i = f.matches.length - 1; i >= 0; i--) {
      const m = f.matches[i]!;
      if (!this.canEdit(m.scope)) {
        blocked.add(m.scope);
        continue;
      }
      tr.insertText(text, m.from, m.to);
      editable++;
    }
    const skipped = f.matches.length - editable;
    const notice = (): void => {
      if (blocked.size === 0) return;
      const reason = this.#locked() ? 'read-only' : 'scope';
      this.#refused({ reason, scopes: [...blocked].sort() });
    };
    if (editable === 0) {
      notice();
      return { replaced: 0, skipped };
    }
    const before = this.#state.doc;
    this.dispatchTransaction(tr);
    if (this.#state.doc === before) {
      // The guard refused the whole change: nothing was replaced (it recorded its own refusal).
      return { replaced: 0, skipped: f.matches.length };
    }
    notice();
    return { replaced: editable, skipped };
  }

  // --- Accept and reject suggestions (FE-047) ------------------------------------------------

  /**
   * Accepts or rejects every suggestion in `target`, or only `author`'s, as one transaction and so
   * one commit (FE-047 criterion 5; 02 §5.2). A suggestion in a scope where the user lacks `edit` is
   * skipped and counted (criterion 6): `suggest` alone may not accept or reject (rule P4, 07 §5.2).
   * When any is skipped, the refusal is recorded as Replace all records one. Block marks
   * (criterion 4) are not handled yet.
   */
  resolveSuggestions(
    action: ResolveAction,
    target: SuggestionTarget = 'selection',
    author?: string,
  ): SuggestionReport {
    const state = this.#state;
    const range = this.#suggestionRange(target);
    if (range === null) return { handled: 0, skipped: 0, skippedScopes: [] };
    const blocked = new Set<string>();
    const editable = (from: number): boolean => {
      const scope = this.#scopeIn(state.doc, from);
      if (this.#mayResolve(scope)) return true;
      blocked.add(scope);
      return false;
    };
    const r = resolveSuggestions(
      state,
      action,
      author === undefined ? { ...range, editable } : { ...range, author, editable },
    );
    const skippedScopes = [...blocked].sort();
    const notice = (): void => {
      if (blocked.size === 0) return;
      this.#refused({
        reason: this.#locked() ? 'read-only' : 'scope',
        scopes: skippedScopes,
        count: r.skipped,
      });
    };
    if (!r.tr.docChanged) {
      notice();
      return { handled: 0, skipped: r.skipped, skippedScopes };
    }
    const before = state.doc;
    // Accepting or rejecting is never itself recorded as a suggestion (FE-041).
    this.dispatchTransaction(r.tr.setMeta(SUGGESTED, true));
    if (this.#state.doc === before) {
      // The guard refused the whole change (it recorded its own refusal).
      return { handled: 0, skipped: r.handled + r.skipped, skippedScopes };
    }
    notice();
    return { handled: r.handled, skipped: r.skipped, skippedScopes };
  }

  /** Whether the user may accept or reject suggestions in a scope: `edit` there (P4). */
  #mayResolve(scope: string): boolean {
    if (this.#locked()) return false;
    const access = this.#accessValue;
    return access === null || capsOf(access, depScope(scope)).includes('edit');
  }

  /** The document range of a suggestion target, or null when the identifier names nothing. */
  #suggestionRange(target: SuggestionTarget): { from: number; to: number } | null {
    const doc = this.#state.doc;
    if (target === 'selection') {
      const { from, to } = this.#state.selection;
      return { from, to };
    }
    if (target === 'document') return { from: 0, to: doc.content.size };
    let range: { from: number; to: number } | null = null;
    doc.descendants((node, pos) => {
      if (range !== null) return false;
      if (node.attrs['id'] === target.id) range = { from: pos, to: pos + node.nodeSize };
      return range === null;
    });
    return range;
  }

  // --- Plain-text paste (FE-052) -------------------------------------------------------------

  /**
   * Pastes plain text at the selection (FE-052). The first line replaces the selection and takes
   * the formatting at it; each further line starts a new paragraph in the same scope. The identifier
   * plugin gives each new paragraph a fresh identifier (a split copies the attributes, FE-031). A
   * selection in a scope the user may not change refuses the whole paste.
   */
  pastePlainText(text: string): boolean {
    const { from, to } = this.#state.selection;
    if (!this.#selectionEditable()) {
      const scopes = [...new Set([this.#scopeAt(from), this.#scopeAt(to)])];
      this.#refused({ reason: this.#locked() ? 'read-only' : 'scope', scopes });
      return false;
    }
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const first = lines[0] ?? '';
    const before = this.#state.doc;
    const tr = this.#state.tr.insertText(first, from, to);
    let at = from + first.length;
    for (const line of lines.slice(1)) {
      tr.split(at);
      at += 2; // the closing and opening tokens of the split paragraphs
      if (line !== '') {
        tr.insertText(line, at);
        at += line.length;
      }
    }
    if (!tr.docChanged) return false;
    this.dispatchTransaction(tr);
    return this.#state.doc !== before;
  }

  // --- Copy, cut and paste through the clipboard (FE-050, FE-051, FE-052) -------------------

  /**
   * What a copy writes, or null when the selection is empty or the access lists `no-copy` (FE-055).
   * A refused copy is recorded as a refusal and writes nothing; the shell explains it (UX-040).
   * `range` names main-document positions to copy instead of the selection: a sub-editor's selection
   * (footnote, header, footer) goes through the same checks as the body's (FE-055 criterion 1).
   */
  copySelection(range?: { readonly from: number; readonly to: number }): ClipboardPayload | null {
    const { from, to } = range ?? this.#state.selection;
    if (from === to) return null;
    const restrictions: readonly string[] = this.#accessValue?.restrictions ?? [];
    if (restrictions.includes('no-copy')) {
      this.#refused({ reason: 'no-copy', scopes: [] });
      return null;
    }
    const fragment = range
      ? fragmentOf(this.#state.doc, from, to, CDM_VERSION, this.#requires)
      : this.getSelectionContent();
    // ADR 0019: a placeholder or a redacted value is not copied; the copy is refused whole (FE-141).
    const carried = copyRefusal(fragment.content);
    if (carried) {
      this.#refused({ reason: carried, scopes: [] });
      return null;
    }
    return clipboardPayload(fragment);
  }

  cutSelection(): CutResult {
    const payload = this.copySelection();
    if (!payload) return { payload: null, deleted: false };
    const { from, to } = this.#state.selection;
    const before = this.#state.doc;
    if (!this.#selectionEditable()) {
      // A cut across protected content removes only the editable text, as a deletion does (FE-037
      // criterion 6). A selection with nothing editable in it is refused, as before.
      const canEdit = trimKey.getState(this.#state);
      const trimmed = canEdit ? trimmedDeletion(this.#state, canEdit) : null;
      if (!trimmed || trimmed.doc.eq(before)) {
        const scopes = [...new Set([this.#scopeAt(from), this.#scopeAt(to)])];
        this.#refused({ reason: this.#locked() ? 'read-only' : 'scope', scopes });
        return { payload, deleted: false };
      }
      this.dispatchTransaction(trimmed);
      return { payload, deleted: this.#state.doc !== before };
    }
    this.dispatchTransaction(this.#state.tr.deleteSelection());
    return { payload, deleted: this.#state.doc !== before };
  }

  pasteFromClipboard(data: ClipboardInput): InsertResult {
    const choice = chooseClipboard(data);
    if (choice.kind === 'none')
      return {
        ok: false,
        reason: 'invalid',
        message: 'the clipboard holds nothing this editor takes',
      };
    if (choice.kind === 'text') {
      const refusals = this.#refusals;
      if (this.pastePlainText(choice.text)) return { ok: true };
      const refusal = this.refusal.get();
      const refused = this.#refusals > refusals && refusal ? refusal.reason : null;
      return {
        ok: false,
        reason: 'refused',
        message: refused ? `the guard refused the change: ${refused}` : 'the text was not pasted',
        ...(refused ? { refusal: refused } : {}),
      };
    }
    if (choice.kind === 'images') return this.#pasteImages(choice.images);
    // A foreign fragment loses its bookmarks (FE-051 criterion 2). Inside a region it also loses
    // its regions and section breaks, which may not sit in a region (FE-051 criterion 5). A node
    // whose asset attribute holds anything but an asset identifier is dropped (FE-053 criterion 2).
    const inRegion = regionAt(this.#state.doc.resolve(this.#state.selection.from)) !== null;
    const drop = new Set<string>(['anchor']);
    if (inRegion) {
      drop.add('region');
      drop.add('section_break');
    }
    const inserted = this.insertContent({
      ...choice.fragment,
      content: withoutEmbeddedData(withoutNodeTypes(choice.fragment.content, drop)),
    });
    // FE-054 criterion 6: pictures inside the pasted HTML are uploaded after its text, as pasted
    // picture files are (FE-053). The text stays pasted when a picture is refused or has no port.
    const pictures = choice.pictures ?? [];
    if (!inserted.ok || pictures.length === 0) return inserted;
    const uploaded = this.#pasteImages(pictures);
    if (!uploaded.ok) return inserted;
    return uploaded.uploads ? { ok: true, uploads: uploaded.uploads } : inserted;
  }

  /** The assets port in force: the one `attach` gave, else the configuration's (FE-053). */
  get #assets(): AssetsPort | null {
    return this.#attachedAssets ?? this.#configAssets;
  }

  /**
   * Pasted pictures (FE-053): the guard is asked first, so a selection the user may not change
   * uploads nothing (criterion 4). Each picture is then uploaded through the assets port and inserted
   * as an `image` node that names the asset (criteria 1 and 2), one after the other, at the selection
   * as it stands when its upload completes.
   */
  #pasteImages(images: readonly PastedImage[]): InsertResult {
    const { from, to } = this.#state.selection;
    if (!this.#selectionEditable()) {
      const scopes = [...new Set([this.#scopeAt(from), this.#scopeAt(to)])];
      const reason = this.#locked() ? 'read-only' : 'scope';
      this.#refused({ reason, scopes });
      return {
        ok: false,
        reason: 'refused',
        message: `the selection is in ${scopes.join(', ')}, which the user may not change`,
        refusal: reason,
      };
    }
    const port = this.#assets;
    if (port === null)
      return {
        ok: false,
        reason: 'unsupported',
        message: 'no assets port is available, so a picture cannot be uploaded',
      };
    const host = {
      state: () => this.#state,
      dispatch: (tr: Transaction) => this.dispatchTransaction(tr),
    };
    const writable = (pos: number): boolean => this.canEdit(this.#scopeAt(pos));
    // FE-053 criterion 3: a placeholder shows at the selection for each picture until its upload has
    // finished, whether it succeeded or failed (the placeholder is metadata, not a change to the document).
    const ids = images.map(() => newPlaceholderId());
    for (const id of ids) host.dispatch(addPlaceholder(this.#state.tr, id, from));
    const uploads = (async (): Promise<readonly ImagePasteResult[]> => {
      const out: ImagePasteResult[] = [];
      for (const [i, image] of images.entries()) {
        try {
          out.push(await pasteImage(host, image, port, { writable }));
        } finally {
          host.dispatch(removePlaceholder(this.#state.tr, ids[i] ?? 0));
        }
      }
      return out;
    })();
    return { ok: true, uploads };
  }

  // --- Content operations (FE-027) -----------------------------------------------------------

  /** The selection as a CDM fragment (FE-027 criterion 1). Changes nothing. */
  getSelectionContent(): CdmFragment {
    const { from, to } = this.#state.selection;
    return fragmentOf(this.#state.doc, from, to, CDM_VERSION, this.#requires);
  }

  /**
   * Inserts a fragment in place of the selection, through the same guards as typing (FE-027): the
   * region guard, the identifier plugin, and the read restrictions. A fragment the document cannot
   * take, and a selection the user may not change, change nothing and say why.
   */
  insertContent(fragment: CdmFragment): InsertResult {
    const problem = fragmentProblem(fragment, CDM_VERSION, this.#requires);
    if (problem) return { ok: false, ...problem };
    if (fragment.content.length === 0) return { ok: true };
    const state = this.#state;
    const { from, to } = state.selection;
    if (!this.#selectionEditable()) {
      const scopes = [...new Set([this.#scopeAt(from), this.#scopeAt(to)])];
      const reason = this.#locked() ? 'read-only' : 'scope';
      this.#refused({ reason, scopes });
      return {
        ok: false,
        reason: 'refused',
        message: this.#locked()
          ? 'the document is read-only in this mode or after a rejection'
          : `the selection is in ${scopes.join(', ')}, which the user may not change`,
        refusal: reason,
      };
    }
    const built = buildFragment(fragment, this.#schema, state.doc, {
      types: idTypesOf(CDM1),
      generate: nodeId,
    });
    if (isFragmentProblem(built)) return { ok: false, ...built };
    if (replaceStep(state.doc, from, to, built.slice) === null)
      return {
        ok: false,
        reason: 'invalid',
        message: 'the fragment does not fit at the selection',
      };
    const tr = state.tr;
    // Definitions first: they sit before the body, so the body positions move by their size.
    // Numbering definitions go in before style definitions are added: their place is at or after
    // the styles' place, so adding them first leaves the styles' place where it was, and at the same
    // place the styles end up before the numbering definitions (CDM-019 order).
    if (built.numberings.length > 0) {
      const at = numberingInsertPos(tr.doc);
      const numberings = new Slice(Fragment.fromArray(built.numberings), 0, 0);
      if (replaceStep(tr.doc, at, at, numberings) === null)
        return {
          ok: false,
          reason: 'invalid',
          message:
            'the numbering definitions of the fragment do not fit the document’s definitions',
        };
      tr.replace(at, at, numberings);
    }
    if (built.defs.length > 0) {
      const at = styleInsertPos(tr.doc);
      const defs = new Slice(Fragment.fromArray(built.defs), 0, 0);
      if (replaceStep(tr.doc, at, at, defs) === null)
        return {
          ok: false,
          reason: 'invalid',
          message: 'the style definitions of the fragment do not fit the document’s definitions',
        };
      tr.replace(at, at, defs);
    }
    tr.replace(tr.mapping.map(from), tr.mapping.map(to), built.slice);
    const before = state.doc;
    const refusals = this.#refusals;
    this.dispatchTransaction(tr);
    if (this.#state.doc !== before) return { ok: true };
    const refusal = this.refusal.get();
    return {
      ok: false,
      reason: 'refused',
      message:
        this.#refusals > refusals && refusal
          ? `the guard refused the change: ${refusal.reason}`
          : 'the change did not apply',
      ...(this.#refusals > refusals && refusal ? { refusal: refusal.reason } : {}),
    };
  }

  // --- Panels (sub-editors) ------------------------------------------------------------------

  openFootnote(id: string): void {
    this.#open({ kind: 'footnote', id }, 'Footnote');
  }

  openStory(id: string): boolean {
    // 07 §7 (FE-056 criterion 6): a person who may not change the story gets no panel, so the
    // command is disabled for them. A read-only panel would need the view, which is not built.
    if (!this.canEdit(`story:${id}`)) return false;
    this.#open({ kind: 'story', id }, 'Header');
    return true;
  }

  #open(target: { kind: 'footnote' | 'story'; id: string }, label: string): void {
    this.#target = target;
    this.panel.set({ ...target, label });
    this.revision.set(this.revision.get() + 1);
  }

  /** The panel's target, for the web view. */
  protected get panelTarget(): { kind: 'footnote' | 'story'; id: string } | null {
    return this.#target;
  }

  closePanel(): void {
    this.#target = null;
    this.panel.set(null);
    this.revision.set(this.revision.get() + 1);
    this.focus();
  }

  focus(): void {
    for (const b of this.#bridges) b.focus();
  }

  // --- Content -------------------------------------------------------------------------------

  get requires(): readonly string[] {
    return this.#requires;
  }

  getContent(): CdmEnvelope {
    return { cdm: CDM_VERSION, requires: [...this.#requires], doc: this.#state.doc.toJSON() };
  }

  confirmedContent(): CdmEnvelope & { seq: number } {
    return {
      cdm: CDM_VERSION,
      requires: [...this.#requires],
      doc: this.#sync.confirmed.toJSON(),
      seq: this.#sync.seq,
    };
  }

  syncSnapshot(): SyncSnapshot {
    const s = this.#sync;
    return {
      seq: s.seq,
      incarnation: s.incarnation,
      view: s.view ?? null,
      confirmed: { cdm: CDM_VERSION, requires: [...this.#requires], doc: s.confirmed.toJSON() },
      inflight: s.inflight
        ? { id: s.inflight.id, base: s.inflight.base, steps: [...s.inflight.json] }
        : null,
      queue: stepsToJson(s.queue) as StepJson[],
    };
  }

  // --- Sync (FE-033) -------------------------------------------------------------------------

  attach(channel: SyncChannel, opts: AttachOptions): () => void {
    if (this.#session) throw new Error('a channel is already attached');
    this.#docId = channel.docId;
    this.#sync = { ...this.#sync, seq: opts.seq, incarnation: opts.incarnation, view: opts.view };
    const sessionOpts = {
      ...(opts.sync ? { sync: opts.sync } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(opts.batchMs !== undefined ? { batchMs: opts.batchMs } : {}),
      ...(opts.newId ? { newId: opts.newId } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.retry ? { retry: opts.retry } : {}),
      ...(opts.journal ? { journal: opts.journal } : {}),
    };
    this.#journalFailed = false;
    this.#serviceUnavailable = false;
    this.connection.set('online');
    if (opts.features) this.setFeatures(opts.features);
    if (opts.assets) this.#attachedAssets = opts.assets;
    const detachProofing = opts.proofing ? this.attachProofing(opts.proofing) : null;
    if (opts.user !== undefined) this.#user = opts.user;
    const session = new SyncSession(this.#host(), channel, sessionOpts);
    this.#session = session;
    if (opts.presence) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const core = this;
      this.#presenceClient = new PresenceClient(
        opts.presence,
        channel.docId,
        {
          get sync() {
            return core.#sync;
          },
          selection: () => {
            const { anchor, head } = core.#state.selection;
            return { anchor, head, scope: core.#mainScope() };
          },
          setPeers: (peers) => core.presence.set(peers),
          setSelections: (peers) => core.peerSelections.set(peers),
          visibleDoc: () => core.#state.doc,
        },
        {
          // Bound wrappers: browsers refuse `setTimeout` called as a method of another object
          // ("Illegal invocation"), which would stop local edits from being sent.
          clock: opts.clock ?? {
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            clearTimeout: (h) => clearTimeout(h as never),
            now: () => Date.now(),
          },
          ...(opts.limits?.presenceHz !== undefined ? { hz: opts.limits.presenceHz } : {}),
          ...(opts.session !== undefined ? { session: opts.session } : {}),
        },
      );
    }
    this.#publish();
    return () => {
      session.end();
      detachProofing?.();
      this.#presenceClient?.end();
      this.#presenceClient = null;
      if (this.#session === session) {
        this.#session = null;
        this.#attachedAssets = null;
        this.connection.set('detached');
        this.presence.set([]);
        this.peerSelections.set([]);
        this.#publishSync();
      }
    };
  }

  /** Opens a new channel at once (after a revocation, with a new token). */
  reconnect(): void {
    this.#session?.reconnect();
  }

  /**
   * Closes the channel and opens none until `resumeSync` (FE-005; 02 §2.1): the element calls it when
   * it suspends. The document, the unconfirmed work and the journal stay.
   */
  suspendSync(): void {
    this.#session?.suspend();
  }

  /** Opens a channel again with a resume (04 §9) after `suspendSync`. */
  resumeSync(): void {
    this.#session?.resume();
  }

  /**
   * Resolves once every journal write requested so far is durable (FE-011). Without a channel, or
   * without a journal, there is nothing to wait for.
   */
  flushJournal(): Promise<void> {
    return this.#session?.journalIdle() ?? Promise.resolve();
  }

  flush(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (settled(this.#sync)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve: () => resolve() };
      this.#waiters.push(waiter);
      if (opts.timeoutMs !== undefined)
        setTimeout(() => {
          const i = this.#waiters.indexOf(waiter);
          if (i < 0) return;
          this.#waiters.splice(i, 1);
          const s = this.#sync;
          const count = (s.inflight ? 1 : 0) + (s.queue.length ? 1 : 0);
          reject(Object.assign(new Error(`${count} unconfirmed commits remain`), { count }));
        }, opts.timeoutMs);
    });
  }

  #host(): SyncHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const core = this;
    return {
      get schema() {
        return core.#schema;
      },
      get sync() {
        return core.#sync;
      },
      get requires() {
        return core.#requires;
      },
      adopt: (t, why) => this.#adopt(t, why),
      setAccess: (a) => this.setAccess(a),
      setReadOnly: (on) => this.#setReadOnly(on),
      event: (e) => this.#event(e),
    };
  }

  #event(e: SyncEvent): void {
    switch (e.type) {
      case 'connection':
        this.connection.set(e.status);
        this.#publishSync();
        return;
      case 'journal':
        this.#journalFailed = !e.ok;
        this.#publishSync();
        return;
      case 'service':
        this.#serviceUnavailable = !e.ok;
        this.#publishSync();
        return;
      case 'discarded': {
        const items = [
          ...this.recovered.get().items,
          ...e.items.map((i) => ({
            reason: i.reason,
            commit: i.commit,
            text: i.text,
            seq: i.seq,
            ...this.#rejectionWords(i),
          })),
        ];
        this.recovered.set({ count: items.length, items });
        return;
      }
      case 'report':
        this.#problems++;
        this.problem.set({
          n: this.#problems,
          code: e.code,
          message: e.message,
          fatal: e.code === 'unsupported_cdm' || e.code === 'unsupported_feature',
        });
        this.#publishSync();
        return;
      default:
        this.#publishSync();
        return;
    }
  }

  /** Tells presence how the confirmed document moved, so that peers' positions are mapped (SYN-036). */
  #presenceConfirmed(t: Transition, seqBefore: number): void {
    const presence = this.#presenceClient;
    if (!presence) return;
    if (t.confirmed) presence.confirmed(t.confirmed);
    else if (t.state.seq !== seqBefore)
      presence.confirmed([{ from: seqBefore, to: t.state.seq, steps: null }]);
  }

  /**
   * Adopts a sync transition (sync/session.ts): the new sync state, and its effect on the visible
   * state as one remote transaction. A change to the block being composed waits (spike S1).
   */
  #adopt(t: Transition, _why: string): boolean {
    if (this.#destroyed) return true;
    const effect = t.effect;
    const seqBefore = this.#sync.seq;
    if (!effect) {
      this.#sync = t.state;
      this.#publishSync();
      this.#presenceConfirmed(t, seqBefore);
      return true;
    }
    const aligned = this.#historyAligned || unconfirmed(this.#sync).length === 0;
    const tr = effect.kind === 'rebuild' ? rebuildTransaction(this.#state, effect, aligned) : null;
    if (this.#deferRemote && this.#touchesComposition(tr, effect)) {
      this.#deferrals++;
      return false;
    }
    this.#sync = t.state;
    if (effect.kind === 'replace') {
      this.#replace(effect);
      this.#historyAligned = unconfirmed(this.#sync).length === 0;
    } else if (tr && effect.kind === 'rebuild') {
      // The history stays one item per unconfirmed step only when it was rebased and every new
      // unconfirmed step came from an old one.
      this.#historyAligned =
        (effect.before.length === 0 || tr.getMeta('rebased') !== undefined) &&
        effect.afterOrigins.every((o) => o >= 0);
      this.dispatchTransaction(tr);
    }
    this.#publishSync();
    this.#presenceConfirmed(t, seqBefore);
    return true;
  }

  /** A reload or reset: a new state, undo history included (04 §8, §9). */
  #replace(effect: Extract<Effect, { kind: 'replace' }>): void {
    if (effect.requires) this.#requires = [...effect.requires];
    const old = this.#state;
    const doc = effect.doc;
    const caret = Math.min(old.selection.from, doc.content.size);
    let selection = initialSelection(doc);
    try {
      const near = TextSelection.near(doc.resolve(caret));
      selection = near;
    } catch {
      // keep the body start
    }
    this.#state = EditorState.create({ doc, selection, plugins: old.plugins });
    for (const b of this.#bridges) b.update(this.#state, []);
    this.#publish();
  }

  /** Whether a remote change touches the block being composed (spike S1; FE-034). */
  #touchesComposition(tr: Transaction | null, effect: Effect): boolean {
    let pos: number | null = null;
    for (const b of this.#bridges) {
      pos = b.composing();
      if (pos !== null) break;
    }
    if (pos === null) pos = this.#probe?.() ?? null;
    if (pos === null) return false;
    if (!tr || effect.kind === 'replace') return true;
    const before = this.#state.doc.nodeAt(pos);
    const mapped = tr.mapping.mapResult(pos, 1);
    if (!before || mapped.deleted) return true;
    const after = tr.doc.nodeAt(mapped.pos);
    return !after || !after.eq(before);
  }

  #probe: (() => number | null) | null = null;

  /** The composition ended: held remote changes are tried again in the next task (spike S1). */
  protected compositionEnded(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#session?.pump();
      this.#pumpStandIn();
    }, 0);
  }

  // --- The spike's stand-in for remote commits (testing.ts) -----------------------------------

  /**
   * Applies remote steps through the sync client as the next commit of a stand-in log: on the
   * confirmed document (`rebase`) or on the visible one (`map`, mapped back to the confirmed
   * document first). For the S1 harness and tests without a backend.
   */
  #standInRemote(steps: readonly Step[], mode: 'map' | 'rebase'): 'applied' | 'deferred' {
    const base =
      mode === 'map'
        ? onConfirmed(steps, unconfirmed(this.#sync), this.#sync.confirmed)
        : [...steps];
    const commit: RemoteCommit = {
      seq: 0,
      kind: 'steps',
      id: `stand-in-${this.#standIn.length}-${this.#sync.seq}`,
      steps: stepsToJson(base),
      control: null,
      author: { user: 'remote', session: null, agent: null },
      serverTime: new Date(0).toISOString(),
      origin: 'input',
    };
    this.#standIn.push(commit);
    this.#pumpStandIn();
    return this.#standIn.includes(commit) ? 'deferred' : 'applied';
  }

  #pumpStandIn(): void {
    if (this.#standInHeld) return;
    this.#standInHeld = true;
    try {
      while (this.#standIn.length) {
        const c = { ...this.#standIn[0]!, seq: this.#sync.seq + 1 };
        const t = receiveCommits(this.#sync, [c], this.#schema);
        if (!this.#adopt(t, 'stand-in')) return;
        this.#standIn.shift();
      }
    } finally {
      this.#standInHeld = false;
    }
  }

  #internals(): Internals {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const core = this;
    return {
      get state() {
        return core.#state;
      },
      get schema() {
        return core.#schema;
      },
      get sync() {
        return core.#sync;
      },
      get session() {
        return core.#session;
      },
      get deferrals() {
        return core.#deferrals;
      },
      get deferredRemote() {
        return core.#standIn.length + (core.#session?.held ? 1 : 0);
      },
      dispatch: (tr) => this.dispatchTransaction(tr),
      onTransaction: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
      applyRemote: (steps, mode) => this.#standInRemote(steps, mode),
      confirmAll: () => {
        const seqBefore = this.#sync.seq;
        this.#sync = {
          ...initialState(
            this.#state.doc,
            this.#sync.seq + 1,
            this.#sync.incarnation,
            this.#sync.view,
          ),
          discarded: this.#sync.discarded,
        };
        this.#publishSync();
        // The confirmed document is replaced as a whole here: peers' positions cannot be mapped (SYN-036).
        this.#presenceClient?.confirmed([{ from: seqBefore, to: this.#sync.seq, steps: null }]);
      },
      setCompositionProbe: (probe) => {
        this.#probe = probe;
      },
      compositionEnded: () => this.compositionEnded(),
      hub: this.#hub,
    };
  }

  destroy(): void {
    this.#destroyed = true;
    this.#proofing?.dispose();
    this.#proofing = null;
    this.#session?.end();
    this.#session = null;
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.#listeners.clear();
    this.#bridges.clear();
  }
}
