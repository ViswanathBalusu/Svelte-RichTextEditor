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
 *
 * How a list is read (the rule of the reading of 2026-11-20, which went through every key of this
 * table in all four lists, on each platform a list covers):
 * - a conflict is a meaning the list gives the key while focus is in a web page. A meaning that
 *   holds only in the browser's own interface (the address bar, a sidebar, the find bar, a menu) is
 *   not one, and neither is a key the list names only as part of a longer gesture ("press and hold",
 *   "while dragging");
 * - a key the list gives the meaning the command has (Firefox lists Undo, Redo and Select All under
 *   "Editing") is not a conflict;
 * - where a list gives a key several such meanings, `meaning` quotes them in the list's order,
 *   joined by "; ";
 * - a key no list names (the Menu key) has no conflict to record.
 * A browser may act on a key its list does not name: such behaviour is not recorded here.
 */
import type { StringKey } from '../i18n/en-GB.ts';

export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'safari';

export const BROWSERS: readonly BrowserName[] = ['chrome', 'edge', 'firefox', 'safari'];

/**
 * The published shortcut lists that were read, with the date they were read. Chrome's list has a
 * part for Windows and Linux and one for Mac; Edge's has one for Windows and one for Mac; Firefox's
 * article shows one platform at a time and was read for Windows, Linux and Mac; Safari's is for Mac.
 */
export const SOURCES: Readonly<
  Record<BrowserName, { readonly url: string; readonly read: string } | null>
> = {
  chrome: { url: 'https://support.google.com/chrome/answer/157179', read: '2026-11-20' },
  edge: {
    url: 'https://support.microsoft.com/en-gb/edge/keyboard-shortcuts-in-microsoft-edge',
    read: '2026-11-20',
  },
  firefox: {
    url: 'https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly',
    read: '2026-11-20',
  },
  safari: { url: 'https://support.apple.com/en-gb/guide/safari/cpsh003/mac', read: '2026-11-20' },
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
    conflicts: [
      {
        browser: 'firefox',
        platform: 'windows-linux',
        key: 'Mod-b',
        meaning: 'Bookmarks sidebar',
        resolution: 'inside-editor',
      },
      {
        browser: 'firefox',
        platform: 'macos',
        key: 'Mod-b',
        meaning: 'Bookmarks sidebar',
        resolution: 'inside-editor',
      },
    ],
  },
  {
    id: 'format.italic',
    kind: 'command',
    conventional: ['Mod-i'],
    keys: ['Mod-i'],
    alternative: [],
    conflicts: [
      {
        browser: 'firefox',
        platform: 'windows-linux',
        key: 'Mod-i',
        meaning: 'Page Info',
        resolution: 'inside-editor',
      },
      {
        browser: 'firefox',
        platform: 'macos',
        key: 'Mod-i',
        meaning: 'Page Info',
        resolution: 'inside-editor',
      },
    ],
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
      // On a Mac Firefox's Inspector is Command+Alt+C, which is not a key of this row.
      {
        browser: 'firefox',
        platform: 'windows-linux',
        key: 'Shift-Mod-c',
        meaning: 'Inspector',
        resolution: 'alternative',
      },
    ],
  },
  // The next and the previous spelling or grammar issue (UX-041). Word's own key for the next issue
  // is Alt+F7; no browser list that was read gives it a meaning (F7 alone is caret browsing in
  // Chrome, Edge and Firefox, and Shift+F7 is Firefox's Style Editor).
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
        browser: 'chrome',
        platform: 'macos',
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
        browser: 'edge',
        platform: 'macos',
        key: 'Mod-f',
        meaning: 'Open find on page',
        resolution: 'inside-editor',
      },
      {
        browser: 'firefox',
        platform: 'windows-linux',
        key: 'Mod-f',
        meaning: 'Find in This Page',
        resolution: 'inside-editor',
      },
      {
        browser: 'firefox',
        platform: 'macos',
        key: 'Mod-f',
        meaning: 'Find in This Page',
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
      {
        browser: 'firefox',
        platform: 'windows-linux',
        key: 'Shift-F10',
        meaning: 'Toggle Context Menu',
        resolution: 'inside-editor',
      },
    ],
  },
  {
    // UX-010 (decision 168): Alt+F10 moves focus into the mini toolbar; Escape there returns it.
    id: 'shell.miniToolbar',
    kind: 'shell',
    label: 'shortcuts.shell.miniToolbar',
    when: 'shortcuts.when.surface',
    conventional: [],
    keys: ['Alt-F10'],
    alternative: [],
    conflicts: [],
  },
  {
    id: 'shell.applyFormat',
    kind: 'shell',
    label: 'shortcuts.shell.applyFormat',
    when: 'shortcuts.when.painter',
    conventional: [],
    keys: ['Enter'],
    alternative: [],
    // Chrome, Edge and Safari name Enter or Return only for the address bar and for bookmarks.
    conflicts: [
      {
        browser: 'firefox',
        platform: 'windows-linux',
        key: 'Enter',
        meaning: 'Open Focused Bookmark or Link in Current Tab',
        resolution: 'inside-editor',
      },
      {
        browser: 'firefox',
        platform: 'macos',
        key: 'Enter',
        meaning: 'Open Focused Bookmark or Link in Current Tab',
        resolution: 'inside-editor',
      },
    ],
  },
  {
    id: 'shell.cancel',
    kind: 'shell',
    label: 'shortcuts.shell.cancel',
    when: 'shortcuts.when.painter',
    conventional: [],
    keys: ['Escape'],
    alternative: [],
    conflicts: [
      {
        browser: 'chrome',
        platform: 'windows-linux',
        key: 'Escape',
        meaning: 'Stop the page loading',
        resolution: 'inside-editor',
      },
      {
        browser: 'chrome',
        platform: 'macos',
        key: 'Escape',
        meaning: 'Stop the page loading',
        resolution: 'inside-editor',
      },
      {
        browser: 'edge',
        platform: 'windows-linux',
        key: 'Escape',
        meaning: 'Stop loading page; close dialog or pop-up',
        resolution: 'inside-editor',
      },
      {
        browser: 'edge',
        platform: 'macos',
        key: 'Escape',
        meaning: 'Exit full-screen mode; Stop loading page; close dialog or pop-up',
        resolution: 'inside-editor',
      },
      {
        browser: 'firefox',
        platform: 'windows-linux',
        key: 'Escape',
        meaning: 'Stop; Stop Autoscroll Mode; Cancel Drag-and-Drop Operation',
        resolution: 'inside-editor',
      },
      {
        browser: 'firefox',
        platform: 'macos',
        key: 'Escape',
        meaning: 'Stop; Stop Autoscroll Mode; Cancel Drag-and-Drop Operation',
        resolution: 'inside-editor',
      },
      {
        browser: 'safari',
        platform: 'macos',
        key: 'Escape',
        meaning: 'Exit full-screen view; Close Reader',
        resolution: 'inside-editor',
      },
    ],
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
