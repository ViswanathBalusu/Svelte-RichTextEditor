/**
 * The ribbon layout of the toolbar (`toolbar="ribbon"`; ADR 0490; 13 §3): tabs, each with labelled
 * groups of commands, the way an office word processor lays them out. It reads the same registry
 * entries as the compact and the full layouts and adds nothing to the registry: a command is placed
 * by its id when `PLACES` names it, else by the `group` its entry names. Each command is in exactly
 * one group of one tab, and none is dropped (an unknown id or group still gets a place).
 *
 * - The tabs are Home, Insert, Layout, References, Review and View, in that order, and only those
 *   with commands are shown.
 * - A contextual group (`table`, `picture`, `story`, `field`) is a tab of its own, after the task
 *   tabs, and is shown only while the selection is in or on that object, as in the full layout.
 * - A group a host or an extension adds has a tab of its own too, labelled like the full layout's.
 * - Home is laid out as an office word processor's is: edit, styles, font, paragraph, copy format.
 *   Its commands beyond bold and italic, and those that are chosen from a list (`CommandEntry.picker`,
 *   which the ribbon shows as a menu button), are on no other toolbar (`CommandEntry.ribbon`;
 *   `ribbonCommands`).
 */
import type { CommandView } from '../commands/types.ts';
import { isContextual, toolbarCommands } from './toolbar-groups.ts';

export const RIBBON_TABS = ['home', 'insert', 'layout', 'references', 'review', 'view'] as const;
export type RibbonTabId = (typeof RIBBON_TABS)[number];

export interface RibbonGroup {
  /** Names the group's caption (`ribbon.group.<key>`), or the registry group of a tab of its own. */
  readonly key: string;
  readonly commands: readonly CommandView[];
}

export interface RibbonTab {
  /** One of `RIBBON_TABS`, or the registry group of a contextual or added group. */
  readonly id: string;
  /** True for a tab that has a name of its own in the registry (a contextual or added group). */
  readonly ownGroup: boolean;
  readonly contextual: boolean;
  readonly groups: readonly RibbonGroup[];
}

interface Place {
  readonly tab: RibbonTabId;
  readonly group: string;
}

/** Where commands go by id, first match wins; a RegExp matches the whole id. */
const PLACES: ReadonlyArray<readonly [RegExp, Place]> = [
  [/^edit\./, { tab: 'home', group: 'edit' }],
  [/^format\.(painter|applyFormat)$/, { tab: 'home', group: 'copyFormat' }],
  [/^format\.applyStyle$/, { tab: 'home', group: 'styles' }],
  [
    /^format\.(paragraph|align\..+|bulletList|numberList|indent(Less|More))$/,
    { tab: 'home', group: 'paragraph' },
  ],
  [/^format\.language$/, { tab: 'review', group: 'proofing' }],
  [/^format\./, { tab: 'home', group: 'font' }],
  [/^table\./, { tab: 'insert', group: 'tables' }],
  [/^insert\.field\./, { tab: 'insert', group: 'fields' }],
  [/^insert\.region$/, { tab: 'insert', group: 'regions' }],
  [/^insert\.footnote$/, { tab: 'references', group: 'notes' }],
  [/^insert\.(caption|crossReference)$/, { tab: 'references', group: 'captions' }],
  [/^insert\.citation$/, { tab: 'references', group: 'citations' }],
  [/^view\.sources$/, { tab: 'references', group: 'citations' }],
  [/^page\./, { tab: 'layout', group: 'headerFooter' }],
  [/^document\./, { tab: 'layout', group: 'document' }],
  [/^review\.comment$/, { tab: 'review', group: 'comments' }],
  [/^review\.markup\./, { tab: 'review', group: 'tracking' }],
  [/^proofing\./, { tab: 'review', group: 'proofing' }],
  [/^view\.checker$/, { tab: 'review', group: 'proofing' }],
  [/^(workflow|history)\./, { tab: 'review', group: 'workflow' }],
  [/^(navigate\.|view\.permissions$)/, { tab: 'review', group: 'protection' }],
  [/^view\.layout\./, { tab: 'view', group: 'views' }],
  [/^view\.zoom/, { tab: 'view', group: 'zoom' }],
];

/** The order of the groups of a tab, where it is not the order the commands come in. */
const GROUP_ORDER: Readonly<Partial<Record<RibbonTabId, readonly string[]>>> = {
  home: ['edit', 'styles', 'font', 'paragraph', 'copyFormat'],
};

/** The order of commands within a group, where it is not the order they are registered in. */
const COMMAND_ORDER: readonly string[] = [
  'format.fontSize',
  'format.bold',
  'format.italic',
  'format.underline',
  'format.strike',
  'format.color',
  'format.highlight',
  'format.clear',
  'format.align.start',
  'format.align.center',
  'format.align.end',
  'format.align.justify',
  'format.bulletList',
  'format.numberList',
  'format.indentLess',
  'format.indentMore',
  'format.paragraph',
];

const SMALL =
  /^format\.(bold|italic|underline|strike|clear|align\..+|bulletList|numberList|indent(Less|More))$/;

/**
 * The commands drawn small: the icon alone, with the label as text for assistive technology and the
 * tooltip. They are the toggles and the alignment, list and indent buttons of the Home tab.
 */
export function ribbonSmall(command: CommandView): boolean {
  return SMALL.test(command.id);
}

/** The commands the ribbon shows: the toolbar's, and those that name the ribbon alone (`CommandEntry.ribbon`). */
export function ribbonCommands(
  commands: readonly CommandView[],
  contexts: Parameters<typeof toolbarCommands>[1],
): CommandView[] {
  const shown = toolbarCommands(commands, contexts);
  const have = new Set(shown.map((c) => c.id));
  const own = commands.filter((c) => c.offered && c.entry.ribbon === true && !have.has(c.id));
  return [...shown, ...own];
}

function rankIn(order: readonly string[], key: string): number {
  const at = order.indexOf(key);
  return at < 0 ? order.length : at;
}

/** The place of a command in a task group's tab when no id rule names it. */
const BY_GROUP: Readonly<Record<string, Place>> = {
  edit: { tab: 'home', group: 'edit' },
  format: { tab: 'home', group: 'font' },
  insert: { tab: 'insert', group: 'insert' },
  page: { tab: 'layout', group: 'headerFooter' },
  review: { tab: 'review', group: 'tracking' },
  view: { tab: 'view', group: 'panes' },
};

/** The place of a command in the task tabs, or null for a group that has a tab of its own. */
export function ribbonPlace(command: CommandView): Place | null {
  // A contextual group is its own tab, whatever the command's id says.
  if (isContextual(command.entry.group)) return null;
  for (const [pattern, place] of PLACES) if (pattern.test(command.id)) return place;
  return Object.hasOwn(BY_GROUP, command.entry.group) ? BY_GROUP[command.entry.group]! : null;
}

/** The ribbon for the commands the toolbars show (`toolbarCommands`): tabs in order, groups in order. */
export function ribbonTabs(commands: readonly CommandView[]): RibbonTab[] {
  const task = new Map<RibbonTabId, Map<string, CommandView[]>>();
  const own = new Map<string, CommandView[]>();
  for (const command of commands) {
    const place = ribbonPlace(command);
    if (place === null) {
      const list = own.get(command.entry.group) ?? [];
      list.push(command);
      own.set(command.entry.group, list);
      continue;
    }
    const groups = task.get(place.tab) ?? new Map<string, CommandView[]>();
    const list = groups.get(place.group) ?? [];
    list.push(command);
    groups.set(place.group, list);
    task.set(place.tab, groups);
  }
  const tabs: RibbonTab[] = [];
  for (const id of RIBBON_TABS) {
    const groups = task.get(id);
    if (!groups) continue;
    tabs.push({
      id,
      ownGroup: false,
      contextual: false,
      groups: [...groups]
        .map(([key, list]) => ({
          key,
          commands: list
            .map((command, at) => ({ command, at }))
            .sort(
              (a, b) =>
                rankIn(COMMAND_ORDER, a.command.id) - rankIn(COMMAND_ORDER, b.command.id) ||
                a.at - b.at,
            )
            .map(({ command }) => command),
        }))
        .sort(
          (a, b) => rankIn(GROUP_ORDER[id] ?? [], a.key) - rankIn(GROUP_ORDER[id] ?? [], b.key),
        ),
    });
  }
  // Contextual groups after the task tabs, then any other group, each as its own tab.
  const rest = [...own].sort(([a], [b]) => Number(!isContextual(a)) - Number(!isContextual(b)));
  for (const [group, list] of rest) {
    tabs.push({
      id: group,
      ownGroup: true,
      contextual: isContextual(group),
      groups: [{ key: group, commands: list }],
    });
  }
  return tabs;
}
