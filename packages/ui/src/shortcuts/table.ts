/**
 * The shortcut table (13 §4; UX-013): for every built-in command with keys, and for the shell's own
 * keys, the conventional word-processor shortcut, this product's shortcut, and what each browser's
 * published shortcut list says about it. `pnpm --filter @docedit/ui generate` writes it to
 * `spec/shortcuts/`, and the shortcut reference in the shell is built from it and the registry.
 *
 * Nothing here is assumed: a conflict is recorded only with the browser's own list as its source,
 * and a browser whose list was not read is "not checked". Where a browser gives a key another
 * meaning, `alternative` names the keys the shell binds as well; the binder binds them on every
 * browser, so the documented alternative always works (UX-013 criterion 2; UX-023 criterion 3).
 */
import type { StringKey } from '../i18n/en-GB.ts';

export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'safari';

export const BROWSERS: readonly BrowserName[] = ['chrome', 'edge', 'firefox', 'safari'];

/** The published shortcut lists that were read, with the date they were read. */
export const SOURCES: Readonly<
  Record<BrowserName, { readonly url: string; readonly read: string } | null>
> = {
  chrome: { url: 'https://support.google.com/chrome/answer/157179', read: '2026-11-06' },
  edge: {
    url: 'https://support.microsoft.com/en-gb/microsoft-edge/keyboard-shortcuts-in-microsoft-edge-50d3edab-30d9-c7e4-21ce-37fe2713cfad',
    read: '2026-11-06',
  },
  // The support article did not load for the reader on 2026-11-06: not checked.
  firefox: null,
  safari: { url: 'https://support.apple.com/en-gb/guide/safari/cpsh003/mac', read: '2026-11-06' },
};

export interface Conflict {
  readonly browser: BrowserName;
  /** The platform the browser's list gives the meaning for. */
  readonly platform: 'windows-linux' | 'macos';
  /** The key, in the registry notation (`Mod` resolved by `platform`). */
  readonly key: string;
  /** The browser's meaning, quoted from its list. */
  readonly meaning: string;
  /** What the shell does about it: binds an alternative, or takes the key inside the editor. */
  readonly resolution: 'alternative' | 'inside-editor';
}

export interface ShortcutRow {
  /** A command identifier, or a key of the shell's own (`shell.*`). */
  readonly id: string;
  readonly kind: 'command' | 'shell';
  /** For a shell row, its description; a command row is described by its label. */
  readonly label?: StringKey;
  /** For a shell row, when the keys apply. */
  readonly when?: StringKey;
  /** The conventional word-processor shortcut (13 §4); empty when there is none. */
  readonly conventional: readonly string[];
  /** This product's keys. For a command they are the entry's `keys` (checked by the tests). */
  readonly keys: readonly string[];
  /** Keys bound as well, because a browser gives one of `keys` another meaning. */
  readonly alternative: readonly string[];
  readonly conflicts: readonly Conflict[];
}

export const SHORTCUT_TABLE: readonly ShortcutRow[] = [
  {
    id: 'edit.undo',
    kind: 'command',
    conventional: ['Mod-z'],
    keys: ['Mod-z'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'edit.redo',
    kind: 'command',
    conventional: ['Mod-y', 'Shift-Mod-z'],
    keys: ['Mod-y', 'Shift-Mod-z'],
    alternative: [],
    conflicts: [
      {
        browser: 'edge',
        platform: 'macos',
        key: 'Mod-y',
        meaning: 'Open History',
        resolution: 'alternative',
      },
      {
        browser: 'chrome',
        platform: 'macos',
        key: 'Mod-y',
        meaning: 'Open the History page in a new tab',
        resolution: 'alternative',
      },
    ],
  },
  {
    id: 'edit.selectAll',
    kind: 'command',
    conventional: ['Mod-a'],
    keys: ['Mod-a'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'format.bold',
    kind: 'command',
    conventional: ['Mod-b'],
    keys: ['Mod-b'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'format.italic',
    kind: 'command',
    conventional: ['Mod-i'],
    keys: ['Mod-i'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'format.painter',
    kind: 'command',
    conventional: ['Shift-Mod-c'],
    keys: ['Shift-Mod-c'],
    alternative: ['Alt-Shift-Mod-c'],
    conflicts: [
      {
        browser: 'edge',
        platform: 'macos',
        key: 'Shift-Mod-c',
        meaning: 'Open Developer tools',
        resolution: 'alternative',
      },
    ],
  },
  // The next and the previous spelling or grammar issue (UX-041). Word's own key for the next issue
  // is Alt+F7; no browser list that was read gives it a meaning.
  {
    id: 'proofing.next',
    kind: 'command',
    conventional: ['Alt-F7'],
    keys: ['Alt-F7'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'proofing.previous',
    kind: 'command',
    conventional: [],
    keys: ['Alt-Shift-F7'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'view.commandSearch',
    kind: 'command',
    conventional: ['Alt-Q'],
    keys: ['Alt-Q'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'view.find',
    kind: 'command',
    conventional: ['Mod-f'],
    keys: ['Mod-f'],
    alternative: [],
    conflicts: [
      {
        browser: 'chrome',
        platform: 'windows-linux',
        key: 'Mod-f',
        meaning: 'Open the Find Bar to search the current page',
        resolution: 'inside-editor',
      },
      {
        browser: 'edge',
        platform: 'windows-linux',
        key: 'Mod-f',
        meaning: 'Open find on page',
        resolution: 'inside-editor',
      },
      {
        browser: 'safari',
        platform: 'macos',
        key: 'Mod-f',
        meaning: 'Search the current web page',
        resolution: 'inside-editor',
      },
    ],
  },
  {
    id: 'shell.nextLandmark',
    kind: 'shell',
    label: 'shortcuts.shell.nextLandmark',
    conventional: ['Ctrl-F6'],
    keys: ['Ctrl-F6'],
    alternative: ['Alt-F6'],
    conflicts: [
      {
        browser: 'chrome',
        platform: 'windows-linux',
        key: 'Ctrl-F6',
        meaning: 'Skip to web contents',
        resolution: 'alternative',
      },
      {
        browser: 'edge',
        platform: 'windows-linux',
        key: 'Ctrl-F6',
        meaning: 'Move focus to the web content pane',
        resolution: 'alternative',
      },
    ],
  },
  {
    id: 'shell.previousLandmark',
    kind: 'shell',
    label: 'shortcuts.shell.previousLandmark',
    conventional: ['Shift-Ctrl-F6'],
    keys: ['Shift-Ctrl-F6'],
    alternative: ['Shift-Alt-F6'],
    conflicts: [],
  },
  {
    id: 'shell.contextMenu',
    kind: 'shell',
    label: 'shortcuts.shell.contextMenu',
    when: 'shortcuts.when.surface',
    conventional: ['Shift-F10', 'ContextMenu'],
    keys: ['Shift-F10', 'ContextMenu'],
    alternative: [],
    conflicts: [
      {
        browser: 'edge',
        platform: 'windows-linux',
        key: 'Shift-F10',
        meaning: 'Open context menu',
        resolution: 'inside-editor',
      },
    ],
  },
  {
    id: 'shell.applyFormat',
    kind: 'shell',
    label: 'shortcuts.shell.applyFormat',
    when: 'shortcuts.when.painter',
    conventional: [],
    keys: ['Enter'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'shell.cancel',
    kind: 'shell',
    label: 'shortcuts.shell.cancel',
    when: 'shortcuts.when.painter',
    conventional: [],
    keys: ['Escape'],
    alternative: [],
    conflicts: [],
  },
];

/** The row for an identifier. */
export function shortcutRow(id: string): ShortcutRow | undefined {
  return SHORTCUT_TABLE.find((r) => r.id === id);
}

/** The keys the shell binds for a row or command: its keys and the alternatives. */
export function boundKeys(id: string, keys: readonly string[] | undefined): string[] {
  const row = shortcutRow(id);
  return [...new Set([...(keys ?? []), ...(row?.alternative ?? [])])];
}

/**
 * Keys the shell binds for itself at all times, which no command may take (UX-013 criterion 5).
 * The format painter's Enter and Escape apply only while it is on, so they are not reserved.
 */
export function shellKeys(): string[] {
  return SHORTCUT_TABLE.filter(
    (r) => r.kind === 'shell' && r.when !== 'shortcuts.when.painter',
  ).flatMap((r) => [...r.keys, ...r.alternative]);
}
