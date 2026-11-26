/**
 * The built-in commands (13 §4). Each names the parity-profile row it delivers (UX-001);
 * `test/parity.test.ts` and the profile generator fail when a capability has no row.
 *
 * Core commands run the editing core's named commands. Those of phase 1b need a named command or
 * a query the core declares (`needs`, `enabled`), and `createCommandRegistry` registers them only
 * when the core backs them, so the shell offers nothing the core cannot do (ADR 0052). Shell
 * commands (panes, dialogs, modes, zoom, sharing) are created by the shell, which owns their state,
 * from `shellCommands`.
 */
import type { CoreApi, EditorMode, HeaderPaneName, ViewName } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';
import { MARKUP_VIEWS, type MarkupView } from '../shell/markup-views.ts';
import type { CommandEntry } from './types.ts';

interface Entry extends CommandEntry {
  readonly label: StringKey;
}

/** Task groups, in toolbar order. The grouping is this product's own (13 §3). */
export const GROUP_ORDER = ['edit', 'format', 'insert', 'page', 'review', 'view'] as const;

/**
 * Contextual groups (13 §3: tables, pictures, headers and footers, fields): shown only while the
 * selection is in or on that object (`SelectionSummary.contexts`; UX-007 criterion 2).
 */
export const CONTEXT_GROUPS = ['table', 'picture', 'story', 'field'] as const;

/** Commands the header shows as buttons rather than the toolbar (13 §3). */
export const HEADER_GROUP = 'header';

/**
 * Field kinds of the palette (12 §3.2; FRW-072), in the spec's order, with the feature each needs in
 * addition to `fields`: the five kinds of phase 1b none, the signing kinds `sign`, the formula `rules`.
 * This list is the palette: each kind is an `insert.field.<kind>` command, and the registry offers
 * it only when the feature is announced. Whether a field may go at the selection is the query
 * `canInsertField` (`fieldInsertSource` in queries.ts, then the core).
 */
export const FIELD_KINDS: ReadonlyArray<{ kind: string; label: StringKey; feature?: string }> = [
  { kind: 'text', label: 'command.insert.field.text' },
  { kind: 'number', label: 'command.insert.field.number' },
  { kind: 'date', label: 'command.insert.field.date' },
  { kind: 'checkbox', label: 'command.insert.field.checkbox' },
  { kind: 'choice', label: 'command.insert.field.choice' },
  { kind: 'signature', label: 'command.insert.field.signature', feature: 'sign' },
  { kind: 'initials', label: 'command.insert.field.initials', feature: 'sign' },
  { kind: 'dateSigned', label: 'command.insert.field.dateSigned', feature: 'sign' },
  { kind: 'formula', label: 'command.insert.field.formula', feature: 'rules' },
];

function named(core: CoreApi, name: string, args?: unknown): boolean {
  return core.runNamed?.(name, args) ?? false;
}

export function coreCommands(): Entry[] {
  return [
    {
      id: 'edit.undo',
      label: 'command.edit.undo',
      icon: 'undo',
      group: 'edit',
      keys: ['Mod-z'],
      enabled: 'canUndo',
      changesContent: true,
      capability: 'editing',
      aliases: ['undo'],
      run: ({ core }) => core.run('undo'),
    },
    {
      id: 'edit.redo',
      label: 'command.edit.redo',
      icon: 'redo',
      group: 'edit',
      keys: ['Mod-y', 'Shift-Mod-z'],
      enabled: 'canRedo',
      changesContent: true,
      capability: 'editing',
      aliases: ['redo'],
      run: ({ core }) => core.run('redo'),
    },
    {
      id: 'edit.selectAll',
      label: 'command.edit.selectAll',
      icon: 'select-all',
      group: 'edit',
      keys: ['Mod-a'],
      changesContent: false,
      capability: 'editing',
      aliases: ['selectAll'],
      run: ({ core }) => core.run('selectAll'),
    },
    {
      id: 'format.bold',
      label: 'command.format.bold',
      icon: 'bold',
      group: 'format',
      keys: ['Mod-b'],
      enabled: 'canEditSelection',
      active: 'isBold',
      changesContent: true,
      capability: 'character-and-paragraph-formatting',
      aliases: ['bold'],
      contextMenu: ['text', 'table', 'story'],
      run: ({ core }) => core.run('bold'),
    },
    {
      id: 'format.italic',
      label: 'command.format.italic',
      icon: 'italic',
      group: 'format',
      keys: ['Mod-i'],
      enabled: 'canEditSelection',
      active: 'isItalic',
      changesContent: true,
      capability: 'character-and-paragraph-formatting',
      aliases: ['italic'],
      contextMenu: ['text', 'table', 'story'],
      run: ({ core }) => core.run('italic'),
    },
    {
      id: 'insert.footnote',
      label: 'command.insert.footnote',
      icon: 'footnote',
      group: 'insert',
      enabled: 'canInsertFootnote',
      changesContent: true,
      capability: 'footnotes',
      aliases: ['insertFootnote'],
      contextMenu: ['text', 'table'],
      run: ({ core }) => core.run('insertFootnote'),
    },
    {
      id: 'page.header',
      label: 'command.page.header',
      icon: 'header',
      group: 'page',
      enabled: 'hasHeader',
      // Opening the header panel changes nothing; editing in it passes the core's region guard.
      changesContent: false,
      capability: 'headers-and-footers',
      aliases: ['editHeader'],
      run: ({ core }) => core.run('editHeader'),
    },
    // Phase 1b: registered only when the core declares what they need.
    {
      id: 'format.applyStyle',
      label: 'command.format.applyStyle',
      icon: 'style',
      group: 'format',
      changesContent: true,
      capability: 'styles',
      needs: 'paragraphStyle',
      // The styles gallery and pane are its surfaces; `exec(id, { style, kind })` runs it.
      toolbar: false,
      run: ({ core, args }) => {
        const a = (args ?? {}) as { style?: unknown; kind?: unknown };
        if (typeof a.style !== 'string') return false;
        const name =
          a.kind === 'character'
            ? 'characterStyle'
            : a.kind === 'table'
              ? 'tableStyle'
              : 'paragraphStyle';
        return named(core, name, { style: a.style });
      },
    },
    {
      id: 'navigate.nextEditableRegion',
      label: 'command.navigate.nextEditableRegion',
      icon: 'next-region',
      group: 'review',
      enabled: 'hasNextEditableRegion',
      changesContent: false,
      capability: 'regions-and-permissions',
      needs: 'nextEditableRegion',
      run: ({ core }) => named(core, 'nextEditableRegion'),
    },
    {
      id: 'edit.insertRecovered',
      label: 'command.edit.insertRecovered',
      icon: 'insert',
      group: 'edit',
      changesContent: true,
      capability: 'recovery-journal',
      needs: 'insertRecovered',
      toolbar: false,
      run: ({ core, args }) => named(core, 'insertRecovered', args),
    },
    {
      id: 'edit.discardRecovered',
      label: 'command.edit.discardRecovered',
      icon: 'discard',
      group: 'edit',
      // Discarding an item of the pane changes nothing in the document.
      changesContent: false,
      capability: 'recovery-journal',
      needs: 'discardRecovered',
      toolbar: false,
      run: ({ core, args }) => named(core, 'discardRecovered', args),
    },
    // A numbered caption for the figure, the table or the equation the selection is on (FE-134).
    {
      id: 'insert.caption',
      label: 'command.insert.caption',
      group: 'insert',
      changesContent: true,
      capability: 'editing',
      needs: 'insertCaption',
      contextMenu: ['text', 'table'],
      run: ({ core }) => named(core, 'insertCaption'),
    },
    ...FIELD_KINDS.map(({ kind, label, feature }): Entry => ({
      id: `insert.field.${kind}`,
      label,
      icon: `field-${kind}`,
      group: 'insert',
      enabled: 'canInsertField',
      changesContent: true,
      capability: 'fields-and-forms',
      needs: 'insertField',
      // Every field command needs the fields port; a signing kind needs sign as well and the
      // formula `rules` (FRW-065 criterion 3).
      feature: 'fields',
      ...(feature ? { also: [feature] } : {}),
      run: ({ core }) => named(core, 'insertField', { kind }),
    })),
  ];
}

/** What the shell's commands act on. */
export interface ShellCommandHost {
  toggleOutline(): boolean;
  openPane(name: HeaderPaneName): boolean;
  requestShare(): boolean;
}

/** What the shell's commands of phase 1b act on (ADR 0052). */
export interface ShellCommandHost1b {
  /** Opens a pane, or closes it when it is open; true when it will be shown. */
  togglePane(id: string): boolean;
  /** Opens the navigation pane with its search field focused. */
  find(): boolean;
  /** Arms the format painter, or applies or cancels it (UX-009). */
  painter(): boolean;
  applyFormat(): boolean;
  /** Opens a dialog of the shell. */
  openDialog(
    name:
      | 'language'
      | 'region'
      | 'export'
      | 'comment'
      | 'version'
      | 'send'
      | 'crossReference'
      | 'paragraph',
  ): boolean;
  zoom(step: 'in' | 'out' | 'reset'): boolean;
  setMode(mode: EditorMode): boolean;
  setView(view: ViewName): boolean;
  /** Chooses how suggestions are shown (UX-035); optional, so a core without markup views omits the commands. */
  setMarkupView?(view: MarkupView): boolean;
  closeStory(): boolean;
  /** Opens command search over the registry (UX-011). */
  commandSearch(): boolean;
  /** Prints the typeset PDF through the host (UX-040 criterion 3); optional, so a host without it omits the command. */
  print?(): boolean;
  /**
   * Moves the caret to the next or previous proofing finding (UX-041 criterion 6). Optional: the shell
   * registers the two commands only while a proofing port is attached, so no proofing control shows
   * without one (criterion 5).
   */
  proofingStep?(direction: 1 | -1): boolean;
  /**
   * Moves to the next or previous suggestion (UX-036). Optional: the review commands are registered
   * only while the core can list suggestions.
   */
  reviewStep?(direction: 1 | -1): boolean;
  /**
   * Accepts or rejects the suggestion the caret is in or those in the selection (`caret`), or all of
   * them in the selection, else in the document (`all`) (UX-036). Optional, like `reviewStep`.
   */
  reviewResolve?(action: 'accept' | 'reject', scope: 'caret' | 'all'): boolean;
}

/** Query names the shell answers (ShellQueries). */
export const SHELL_QUERY_NAMES = [
  'shell.outlineOpen',
  'shell.painterArmed',
  'shell.painterEnabled',
  'shell.zoomInPossible',
  'shell.zoomOutPossible',
  'shell.zoomChanged',
  'shell.mode.edit',
  'shell.mode.review',
  'shell.mode.view',
  'shell.mode.fill',
  'shell.markup.all',
  'shell.markup.simple',
  'shell.markup.none',
  'shell.markup.original',
  'shell.modeAvailable.edit',
  'shell.modeAvailable.review',
  'shell.modeAvailable.view',
  'shell.modeAvailable.fill',
  'shell.view.web',
  'shell.view.read',
  'shell.view.print',
  'shell.pane.navigation',
  'shell.pane.styles',
  'shell.pane.recovered',
  'shell.pane.shortcuts',
  'shell.pane.permissions',
  'shell.pane.fill',
  'shell.pane.checker',
  'shell.pane.sources',
  'shell.pane.assistant',
  'shell.pane.review',
  'shell.pane.roles',
  'shell.pane.fields',
  'shell.pane.rules',
  'shell.storyOpen',
  'shell.commentAllowed',
  'shell.reviewAny',
  'shell.exportAllowed',
  'shell.printAllowed',
] as const;

export function shellCommands(host: ShellCommandHost): {
  outline: Entry;
  comments: Entry;
  catchUp: Entry;
  history: Entry;
  share: Entry;
} {
  return {
    outline: {
      id: 'view.outline',
      label: 'command.view.outline',
      icon: 'outline',
      group: 'view',
      active: 'shell.outlineOpen',
      changesContent: false,
      capability: 'navigation-pane',
      aliases: ['outline'],
      run: () => host.toggleOutline(),
    },
    comments: {
      id: 'view.comments',
      label: 'command.view.comments',
      icon: 'comments',
      group: HEADER_GROUP,
      changesContent: false,
      feature: 'comments',
      capability: 'comments',
      contextMenu: ['comment'],
      run: () => host.openPane('comments'),
    },
    catchUp: {
      id: 'view.catchUp',
      label: 'command.view.catchUp',
      icon: 'catch-up',
      group: HEADER_GROUP,
      changesContent: false,
      feature: 'history',
      capability: 'catch-up',
      run: () => host.openPane('catch-up'),
    },
    history: {
      id: 'view.history',
      label: 'command.view.history',
      group: HEADER_GROUP,
      changesContent: false,
      feature: 'history',
      capability: 'version-history',
      run: () => host.openPane('history'),
    },
    share: {
      id: 'document.share',
      label: 'command.document.share',
      icon: 'share',
      group: HEADER_GROUP,
      changesContent: false,
      capability: 'sharing',
      run: () => host.requestShare(),
    },
  };
}

const MODES: readonly EditorMode[] = ['edit', 'review', 'view', 'fill'];
const VIEWS: readonly ViewName[] = ['web', 'read', 'print'];

/**
 * The layout views the view group offers (UX-007 criterion 4): the ones the core lists, in the
 * shell's order, so `print` appears only when the core supports it. A core that lists none (or
 * does not list its views) gets `web`, the view every build has. Unknown names are dropped.
 */
export function layoutViews(offered: readonly string[] | null | undefined): readonly ViewName[] {
  if (offered === undefined || offered === null) return ['web'];
  return VIEWS.filter((view) => offered.includes(view));
}

/** The shell's commands of phase 1b, by identifier; the shell registers those it can back. */
export function shellCommands1b(host: ShellCommandHost1b): Record<string, Entry> {
  const out: Record<string, Entry> = {
    'view.find': {
      id: 'view.find',
      label: 'command.view.find',
      icon: 'find',
      group: 'view',
      keys: ['Mod-f'],
      changesContent: false,
      capability: 'navigation-pane',
      run: () => host.find(),
    },
    'view.styles': {
      id: 'view.styles',
      label: 'command.view.styles',
      icon: 'styles',
      group: 'view',
      active: 'shell.pane.styles',
      changesContent: false,
      capability: 'styles',
      run: () => host.togglePane('styles'),
    },
    'view.recovered': {
      id: 'view.recovered',
      label: 'command.view.recovered',
      icon: 'recovered',
      group: 'view',
      active: 'shell.pane.recovered',
      changesContent: false,
      capability: 'recovery-journal',
      run: () => host.togglePane('recovered'),
    },
    'view.shortcuts': {
      id: 'view.shortcuts',
      label: 'command.view.shortcuts',
      icon: 'keyboard',
      group: 'view',
      active: 'shell.pane.shortcuts',
      changesContent: false,
      capability: 'keyboard-shortcuts',
      run: () => host.togglePane('shortcuts'),
    },
    'view.commandSearch': {
      id: 'view.commandSearch',
      label: 'command.view.commandSearch',
      icon: 'find',
      group: 'view',
      keys: ['Alt-Q'],
      changesContent: false,
      capability: 'command-search',
      // Phase 2 (13 §12): opened by Alt+Q and `exec`, listed in the shortcuts pane, not a toolbar
      // button. Both layouts show the same commands (UX-007 criterion 3), so it is off both.
      toolbar: false,
      run: () => host.commandSearch(),
    },
    'view.permissions': {
      id: 'view.permissions',
      label: 'command.view.permissions',
      icon: 'permissions',
      group: 'review',
      active: 'shell.pane.permissions',
      changesContent: false,
      capability: 'regions-and-permissions',
      run: () => host.togglePane('permissions'),
    },
    'view.checker': {
      id: 'view.checker',
      label: 'command.view.checker',
      icon: 'checklist',
      group: 'review',
      active: 'shell.pane.checker',
      changesContent: false,
      capability: 'accessibility-checker',
      run: () => host.togglePane('checker'),
    },
    // The review pane (UX-037): the suggestions by kind, author and words, with accept and reject.
    'view.review': {
      id: 'view.review',
      label: 'command.view.review',
      icon: 'review',
      group: 'view',
      active: 'shell.pane.review',
      changesContent: false,
      capability: 'suggestions',
      run: () => host.togglePane('review'),
    },
    // The assistant pane (UX-045); registered only while an assistant port is attached.
    'view.assistant': {
      id: 'view.assistant',
      label: 'command.view.assistant',
      group: 'view',
      active: 'shell.pane.assistant',
      changesContent: false,
      capability: 'assistant',
      run: () => host.togglePane('assistant'),
    },
    'view.sources': {
      id: 'view.sources',
      label: 'command.view.sources',
      group: 'view',
      active: 'shell.pane.sources',
      changesContent: false,
      capability: 'citations',
      run: () => host.togglePane('sources'),
    },
    'view.fieldProperties': {
      id: 'view.fieldProperties',
      label: 'command.view.fieldProperties',
      group: 'view',
      active: 'shell.pane.fields',
      changesContent: false,
      feature: 'fields',
      capability: 'fields-and-forms',
      toolbar: false,
      run: () => host.togglePane('fields'),
    },
    'view.rules': {
      id: 'view.rules',
      label: 'command.view.rules',
      group: 'view',
      active: 'shell.pane.rules',
      changesContent: false,
      feature: 'fields',
      also: ['rules'],
      capability: 'fields-and-forms',
      toolbar: false,
      run: () => host.togglePane('rules'),
    },
    'view.roles': {
      id: 'view.roles',
      label: 'command.view.roles',
      group: 'view',
      active: 'shell.pane.roles',
      changesContent: false,
      feature: 'fields',
      capability: 'fields-and-forms',
      toolbar: false,
      run: () => host.togglePane('roles'),
    },
    'view.fillSummary': {
      id: 'view.fillSummary',
      label: 'command.view.fillSummary',
      icon: 'checklist',
      group: 'view',
      active: 'shell.pane.fill',
      changesContent: false,
      feature: 'fields',
      capability: 'fields-and-forms',
      toolbar: false,
      run: () => host.togglePane('fill'),
    },
    'format.painter': {
      id: 'format.painter',
      label: 'command.format.painter',
      icon: 'painter',
      group: 'format',
      keys: ['Shift-Mod-c'],
      // Enabled while armed, so that it can be turned off; else when there is formatting to take.
      enabled: 'shell.painterEnabled',
      active: 'shell.painterArmed',
      changesContent: false,
      capability: 'format-painter',
      needs: 'copyFormat',
      contextMenu: ['text', 'table'],
      run: () => host.painter(),
    },
    'format.applyFormat': {
      id: 'format.applyFormat',
      label: 'command.format.applyFormat',
      icon: 'painter',
      group: 'format',
      enabled: 'canPasteFormat',
      changesContent: true,
      capability: 'format-painter',
      needs: 'pasteFormat',
      toolbar: false,
      run: () => host.applyFormat(),
    },
    'format.language': {
      id: 'format.language',
      label: 'command.format.language',
      icon: 'language',
      group: 'review',
      enabled: 'canEditSelection',
      changesContent: true,
      capability: 'character-and-paragraph-formatting',
      needs: 'setLanguage',
      contextMenu: ['text', 'table'],
      run: () => host.openDialog('language'),
    },
    // The paragraph dialog (UX-102 criterion 3; FE-129): the keyboard form of every ruler drag.
    'format.paragraph': {
      id: 'format.paragraph',
      label: 'command.format.paragraph',
      group: 'format',
      enabled: 'canEditSelection',
      changesContent: true,
      capability: 'character-and-paragraph-formatting',
      needs: 'setParagraphFormat',
      contextMenu: ['text'],
      run: () => host.openDialog('paragraph'),
    },
    // A reference to a heading, a numbered paragraph, a caption, an equation or a bookmark (FE-134
    // criterion 2): opens the dialog that lists the targets the core gives.
    'insert.crossReference': {
      id: 'insert.crossReference',
      label: 'command.insert.crossReference',
      group: 'insert',
      changesContent: true,
      capability: 'editing',
      needs: 'insertCrossReference',
      contextMenu: ['text'],
      run: () => host.openDialog('crossReference'),
    },
    'insert.region': {
      id: 'insert.region',
      label: 'command.insert.region',
      icon: 'region',
      group: 'insert',
      enabled: 'canMarkRegion',
      changesContent: true,
      capability: 'regions-and-permissions',
      needs: 'markRegion',
      contextMenu: ['text'],
      run: () => host.openDialog('region'),
    },
    // Name the current state of the document (HIS-006; 08 §4): opens the dialog for a name and a
    // note. It writes no content, so a locked document keeps it; the host's history port offers it
    // only to a user who may name versions, and the service refuses anyone else.
    'history.nameVersion': {
      id: 'history.nameVersion',
      label: 'command.history.nameVersion',
      group: 'review',
      changesContent: false,
      feature: 'history',
      capability: 'version-history',
      run: () => host.openDialog('version'),
    },
    // Send the document for completion (FRW-028; 12 §6.2): opens the pre-send checklist. It writes
    // no content itself, so a locked document keeps it; the dialog explains why sending is off
    // for a reader without `manage` or for a workflow that is no longer a draft.
    'workflow.send': {
      id: 'workflow.send',
      label: 'command.workflow.send',
      group: 'review',
      changesContent: false,
      feature: 'workflow',
      capability: 'fields-and-forms',
      run: () => host.openDialog('send'),
    },
    // Comment on the selection (UX-028): opens the comment box for the anchor the core gives. It
    // changes nothing in the document, so a locked or approved document keeps it (criterion 4);
    // `shell.commentAllowed` is false without `comment` in a covered scope, with the reason.
    'review.comment': {
      id: 'review.comment',
      label: 'command.review.comment',
      icon: 'comment',
      group: 'review',
      enabled: 'shell.commentAllowed',
      changesContent: false,
      feature: 'comments',
      capability: 'comments',
      contextMenu: ['text', 'table', 'picture'],
      run: () => host.openDialog('comment'),
    },
    'document.export': {
      id: 'document.export',
      label: 'command.document.export',
      icon: 'export',
      group: 'page',
      // Disabled with the reason under `no-export` (UX-040 criterion 1); the shell sets the answer.
      enabled: 'shell.exportAllowed',
      changesContent: false,
      feature: 'exports',
      capability: 'export-pdf',
      run: () => host.openDialog('export'),
    },
    // Disabled with the reason under `no-print` (UX-040 criterion 3); the shell sets the answer.
    'document.print': {
      id: 'document.print',
      label: 'command.document.print',
      icon: 'print',
      group: 'page',
      enabled: 'shell.printAllowed',
      changesContent: false,
      feature: 'exports',
      capability: 'export-pdf',
      run: () => (host.print ? host.print() : false),
    },
    'proofing.next': {
      id: 'proofing.next',
      label: 'command.proofing.next',
      group: 'review',
      keys: ['Alt-F7'],
      changesContent: false,
      capability: 'spelling-and-grammar',
      toolbar: false,
      run: () => (host.proofingStep ? host.proofingStep(1) : false),
    },
    'proofing.previous': {
      id: 'proofing.previous',
      label: 'command.proofing.previous',
      group: 'review',
      keys: ['Alt-Shift-F7'],
      changesContent: false,
      capability: 'spelling-and-grammar',
      toolbar: false,
      run: () => (host.proofingStep ? host.proofingStep(-1) : false),
    },
    'view.zoomIn': {
      id: 'view.zoomIn',
      label: 'command.view.zoomIn',
      icon: 'zoom-in',
      group: 'view',
      enabled: 'shell.zoomInPossible',
      changesContent: false,
      capability: 'zoom',
      toolbar: false,
      run: () => host.zoom('in'),
    },
    'view.zoomOut': {
      id: 'view.zoomOut',
      label: 'command.view.zoomOut',
      icon: 'zoom-out',
      group: 'view',
      enabled: 'shell.zoomOutPossible',
      changesContent: false,
      capability: 'zoom',
      toolbar: false,
      run: () => host.zoom('out'),
    },
    'view.zoomReset': {
      id: 'view.zoomReset',
      label: 'command.view.zoomReset',
      icon: 'zoom-reset',
      group: 'view',
      enabled: 'shell.zoomChanged',
      changesContent: false,
      capability: 'zoom',
      toolbar: false,
      run: () => host.zoom('reset'),
    },
    'page.closeStory': {
      id: 'page.closeStory',
      label: 'command.page.closeStory',
      icon: 'close',
      group: 'story',
      enabled: 'shell.storyOpen',
      changesContent: false,
      capability: 'headers-and-footers',
      run: () => host.closeStory(),
    },
  };
  for (const mode of MODES)
    out[`mode.${mode}`] = {
      id: `mode.${mode}`,
      label: `command.mode.${mode}` as StringKey,
      icon: `mode-${mode}`,
      group: 'mode',
      enabled: `shell.modeAvailable.${mode}`,
      active: `shell.mode.${mode}`,
      changesContent: false,
      capability: 'modes',
      toolbar: false,
      run: () => host.setMode(mode),
    };
  // How suggestions are shown (UX-035), one command per view. Off the toolbar, like the modes: they are
  // chosen from command search and the menus, and the shell shows the choice in the document.
  if (host.setMarkupView)
    for (const view of MARKUP_VIEWS)
      out[`review.markup.${view}`] = {
        id: `review.markup.${view}`,
        label: `command.review.markup.${view}` as StringKey,
        icon: 'review',
        group: 'review',
        active: `shell.markup.${view}`,
        changesContent: false,
        capability: 'suggestions',
        toolbar: false,
        run: () => host.setMarkupView!(view),
      };
  // The review tools (UX-036): step through the suggestions, and accept or reject them. They are
  // reached from command search and the menus (and the review pane, UX-037). Accept and reject are
  // registered only while the user may resolve a suggestion (criterion 3), by the shell.
  if (host.reviewStep)
    for (const [id, direction] of [
      ['review.next', 1],
      ['review.previous', -1],
    ] as const)
      out[id] = {
        id,
        label: `command.${id}` as StringKey,
        icon: 'review',
        group: 'review',
        enabled: 'shell.reviewAny',
        changesContent: false,
        capability: 'suggestions',
        toolbar: false,
        run: () => host.reviewStep!(direction),
      };
  if (host.reviewResolve)
    for (const [id, action, scope] of [
      ['review.accept', 'accept', 'caret'],
      ['review.reject', 'reject', 'caret'],
      ['review.acceptAll', 'accept', 'all'],
      ['review.rejectAll', 'reject', 'all'],
    ] as const)
      out[id] = {
        id,
        label: `command.${id}` as StringKey,
        icon: 'review',
        group: 'review',
        enabled: 'shell.reviewAny',
        changesContent: true,
        capability: 'suggestions',
        toolbar: false,
        run: () => host.reviewResolve!(action, scope),
      };
  for (const view of VIEWS)
    out[`view.layout.${view}`] = {
      id: `view.layout.${view}`,
      label: `command.view.layout.${view}` as StringKey,
      icon: `view-${view}`,
      group: 'view',
      active: `shell.view.${view}`,
      changesContent: false,
      capability: 'views',
      run: () => host.setView(view),
    };
  return out;
}

/** Every built-in entry, for the parity profile and its checks. */
export function builtinCommands(): Entry[] {
  const none = () => false;
  const shell = shellCommands({ toggleOutline: none, openPane: none, requestShare: none });
  const shell1b = shellCommands1b({
    togglePane: none,
    find: none,
    painter: none,
    applyFormat: none,
    openDialog: none,
    zoom: none,
    setMode: none,
    setView: none,
    setMarkupView: none,
    reviewStep: none,
    reviewResolve: none,
    closeStory: none,
    commandSearch: none,
  });
  return [
    ...coreCommands(),
    shell.outline,
    shell.comments,
    shell.catchUp,
    shell.history,
    shell.share,
    ...Object.values(shell1b),
  ];
}
