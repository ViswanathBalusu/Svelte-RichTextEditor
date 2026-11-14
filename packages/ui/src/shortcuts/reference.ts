/**
 * The rows of the shortcut reference (UX-013 criterion 6; 13 §4). The reference shown to people is
 * built here from two sources and nothing else: the registry's offered commands that have `keys`
 * (so a command registered at run time appears with its keys, and a removed one disappears), and
 * the shell's own rows of the shortcut table (with the alternatives the table binds). Labels come
 * from string keys through the translator, never from a literal in the entry.
 *
 * `panes/ShortcutsPane.svelte` renders these rows; the logic is kept here so that it can be tested
 * in Node.js without the component.
 */
import type { CommandView } from '../commands/types.ts';
import type { StringKey } from '../i18n/en-GB.ts';
import { SHORTCUT_TABLE, boundKeys } from './table.ts';

/** The part of the interface's strings the reference needs. */
export interface ReferenceStrings {
  /** The text of a string key, as the interface shows it. */
  text(key: string): string;
  /** The translation of a string key. */
  t(key: StringKey): string;
}

export interface ReferenceRow {
  /** A command identifier, or the identifier of a shell row. */
  readonly id: string;
  readonly label: string;
  /** The keys the shell binds for the row: its keys and the alternatives the table adds. */
  readonly keys: readonly string[];
  readonly when: string;
}

/** The rows of the shortcut reference for the offered commands and the shell's own table rows. */
export function shortcutReferenceRows(
  commands: readonly CommandView[],
  strings: ReferenceStrings,
): ReferenceRow[] {
  const always = strings.t('shortcuts.always');
  return [
    ...commands
      .filter((c) => c.offered && (c.entry.keys?.length ?? 0) > 0)
      .map((c) => ({
        id: c.id,
        label: strings.text(c.entry.label),
        keys: boundKeys(c.id, c.entry.keys),
        when: always,
      })),
    ...SHORTCUT_TABLE.filter((r) => r.kind === 'shell').map((r) => ({
      id: r.id,
      label: r.label ? strings.t(r.label) : r.id,
      keys: [...r.keys, ...r.alternative],
      when: r.when ? strings.t(r.when) : always,
    })),
  ];
}
