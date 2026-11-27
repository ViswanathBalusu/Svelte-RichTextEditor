/**
 * Which commands the toolbars and the context menu show, and in which groups (UX-006, UX-007,
 * UX-008; 13 §3, §4). Both toolbar layouts read the same registry entries: a command appears in
 * the compact row and in exactly one group of the full layout, the one its `group` names.
 *
 * - Commands of the header (`header`) and of the mode switcher (`mode`), and entries with
 *   `toolbar: false`, are not on the toolbars.
 * - A contextual group (`table`, `picture`, `story`, `field`) is shown only while the selection is
 *   in or on that object (`SelectionSummary.contexts`).
 */
import { CONTEXT_GROUPS, GROUP_ORDER, HEADER_GROUP } from '../commands/builtin.ts';
import type { CommandView, ContextTarget } from '../commands/types.ts';
import type { SelectionContext } from '../core-api.ts';

const OFF_TOOLBAR = new Set([HEADER_GROUP, 'mode']);

export interface ToolbarGroup {
  readonly name: string;
  readonly contextual: boolean;
  readonly commands: readonly CommandView[];
}

function rank(group: string): number {
  const task = (GROUP_ORDER as readonly string[]).indexOf(group);
  if (task >= 0) return task;
  const context = (CONTEXT_GROUPS as readonly string[]).indexOf(group);
  if (context >= 0) return GROUP_ORDER.length + context;
  return GROUP_ORDER.length + CONTEXT_GROUPS.length;
}

export function isContextual(group: string): boolean {
  return (CONTEXT_GROUPS as readonly string[]).includes(group);
}

/** The toolbar's commands for the current contexts, grouped in task order, stable within a group. */
export function toolbarCommands(
  commands: readonly CommandView[],
  contexts: readonly SelectionContext[] | undefined,
): CommandView[] {
  const here = new Set<string>(contexts ?? []);
  return commands
    .filter(
      (c) =>
        c.offered &&
        c.entry.toolbar !== false &&
        !OFF_TOOLBAR.has(c.entry.group) &&
        (!isContextual(c.entry.group) || here.has(c.entry.group)),
    )
    .map((c, order) => ({ c, order }))
    .sort((a, b) => rank(a.c.entry.group) - rank(b.c.entry.group) || a.order - b.order)
    .map(({ c }) => c);
}

/** The groups of the full layout: each command in the one group its entry names. */
export function toolbarGroups(commands: readonly CommandView[]): ToolbarGroup[] {
  const groups = new Map<string, CommandView[]>();
  for (const c of commands) {
    const list = groups.get(c.entry.group) ?? [];
    list.push(c);
    groups.set(c.entry.group, list);
  }
  // Task groups in their order, then the contextual ones (UX-007 criterion 1), whatever the input order.
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([name, list]) => ({
      name,
      contextual: isContextual(name),
      commands: list,
    }));
}

/** The targets the context menu opened on: text, and whatever the selection is in or on. */
export function contextTargets(contexts: readonly SelectionContext[] | undefined): ContextTarget[] {
  return ['text', ...(contexts ?? [])];
}

/** The context menu's commands for the targets, in task order, grouped. */
export function contextMenuGroups(
  commands: readonly CommandView[],
  targets: readonly ContextTarget[],
): ToolbarGroup[] {
  const wanted = new Set(targets);
  const items = commands
    .filter((c) => c.offered && c.entry.contextMenu?.some((t) => wanted.has(t)))
    .map((c, order) => ({ c, order }))
    .sort((a, b) => rank(a.c.entry.group) - rank(b.c.entry.group) || a.order - b.order)
    .map(({ c }) => c);
  return toolbarGroups(items);
}
