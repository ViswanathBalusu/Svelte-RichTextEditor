/**
 * The commands of the ribbon's Home tab beyond bold, italic and the styles (ADR 0490). They load with
 * the ribbon's strings and are registered once the shell has mounted, so the first load carries
 * neither (FND-008): the shell asks for them with `registerHomeCommands`, and they appear in every
 * layout of the toolbar, as bold does, a moment after the editor is up. Like the other built-in
 * commands they are registered only when the core backs them (ADR 0052): the named commands they run,
 * and the queries their toggles read.
 *
 * Their labels are in the late string group `ribbonToolbar`, their drawings in
 * `icons/ribbon-icons.ts`, and the ribbon places them by id (`shell/ribbon-groups.ts`).
 */
import type { CoreApi } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';
import '../i18n/late/ribbonToolbar.ts';
import type { CommandRegistry } from './registry.ts';
import type { CommandEntry, QuerySource } from './types.ts';

interface Entry extends CommandEntry {
  readonly label: StringKey;
}

function named(core: CoreApi, name: string, args?: unknown): boolean {
  return core.runNamed?.(name, args) ?? false;
}

/**
 * The commands of the ribbon's Home tab beyond bold and italic (ADR 0490): each runs a named command
 * of the core, which checks its arguments and the user's right to change the text. They have no keys
 * yet: a key for each belongs to the shortcut reading of UX-013 (the four browser lists must be read
 * for it, and Ctrl+U is a browser key in three of them). The ribbon places them by id
 * (`shell/ribbon-groups.ts`) and gives them their drawings (`icons/ribbon-icons.ts`), so the first
 * load carries neither.
 */
export function homeCommands(): Entry[] {
  const formatting = 'character-and-paragraph-formatting';
  const command = (
    id: string,
    label: StringKey,
    needs: string,
    more: Partial<Entry> = {},
    arguments_?: (args: unknown) => unknown,
    capability = formatting,
  ): Entry => ({
    id,
    label,
    group: 'format',
    // On the ribbon's toolbar only: the compact and the full toolbars are not changed by it.
    toolbar: false,
    ribbon: true,
    enabled: 'canEditSelection',
    changesContent: true,
    capability,
    needs,
    ...more,
    run: ({ core, args }) => named(core, needs, arguments_?.(args)),
  });
  const choice = (args: unknown): Record<string, unknown> =>
    typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const align = (to: string, label: StringKey): Entry =>
    command(`format.align.${to}`, label, 'setParagraphFormat', { active: `alignIs.${to}` }, () => ({
      align: to,
    }));
  return [
    command('format.underline', 'ribbon.command.format.underline', 'underline', {
      active: 'isUnderline',
    }),
    command('format.strike', 'ribbon.command.format.strike', 'strike', { active: 'isStrike' }),
    command('format.clear', 'ribbon.command.format.clear', 'clearFormatting'),
    // Chosen from a list: `exec(id, { value })`, a size in twentieths of a point, a `#RRGGBB` colour or
    // one of the CDM's highlight names, or null to take the property off.
    command(
      'format.fontSize',
      'ribbon.command.format.fontSize',
      'fontSize',
      { picker: 'fontSize' },
      (a) => ({
        fontSize: choice(a)['value'] ?? null,
      }),
    ),
    command('format.color', 'ribbon.command.format.color', 'color', { picker: 'colour' }, (a) => ({
      color: choice(a)['value'] ?? null,
    })),
    command(
      'format.highlight',
      'ribbon.command.format.highlight',
      'highlight',
      { picker: 'highlight' },
      (a) => ({
        highlight: choice(a)['value'] ?? null,
      }),
    ),
    align('start', 'ribbon.command.format.align.start'),
    align('center', 'ribbon.command.format.align.center'),
    align('end', 'ribbon.command.format.align.end'),
    align('justify', 'ribbon.command.format.align.justify'),
    command(
      'format.bulletList',
      'ribbon.command.format.bulletList',
      'applyList',
      {},
      () => ({ listKind: 'bullet' }),
      'lists',
    ),
    command(
      'format.numberList',
      'ribbon.command.format.numberList',
      'applyList',
      {},
      () => ({ listKind: 'number' }),
      'lists',
    ),
    // In a list the buttons change the item's level; elsewhere they move the paragraph's left indent
    // by the tab step (36 points unless the document says another), never below the margin.
    ...([1, -1] as const).map((way): Entry => ({
      ...command(
        way > 0 ? 'format.indentMore' : 'format.indentLess',
        way > 0 ? 'ribbon.command.format.indentMore' : 'ribbon.command.format.indentLess',
        'setParagraphFormat',
        {},
        undefined,
        'lists',
      ),
      run: ({ core }) => {
        if (named(core, way > 0 ? 'listLevelUp' : 'listLevelDown')) return true;
        const view = core.paragraphFormat?.get();
        const step = view?.defaultTabStop ?? 720;
        return named(core, 'setParagraphFormat', {
          indentLeft: Math.max(0, (view?.indentLeft ?? 0) + way * step),
        });
      },
    })),
  ];
}

/** The alignments of a paragraph that the Home tab's four buttons set (03 §4.8). */
const ALIGNMENTS = ['start', 'center', 'end', 'justify'] as const;

/** The marks of the selection that the Home tab's toggles show as pressed. */
const MARK_QUERIES: Readonly<Record<string, string>> = {
  isUnderline: 'underline',
  isStrike: 'strike',
};

/**
 * The queries of the Home tab's toggles, read from the core's views: whether the selection carries
 * the underline or the strike-through mark, and which alignment the selected paragraphs have
 * (`alignIs.start`, `alignIs.center`, `alignIs.end`, `alignIs.justify`). A core without the
 * paragraph options answers false for an alignment. The registry observes the views it reads.
 */
export function homeQuerySource(core: CoreApi): QuerySource {
  return {
    names: [...Object.keys(MARK_QUERIES), ...ALIGNMENTS.map((a) => `alignIs.${a}`)],
    evaluate(name) {
      const mark = MARK_QUERIES[name];
      if (mark !== undefined) return core.selection.get().marks.includes(mark);
      if (!name.startsWith('alignIs.')) return undefined;
      return core.paragraphFormat?.get()?.options?.align === name.slice('alignIs.'.length);
    },
    subscribe: () => () => {},
  };
}

const registered = new WeakSet<CommandRegistry>();

/**
 * Registers the Home commands the core backs, and the source of the queries their toggles read.
 * Returns the function that takes them away again. A registry that has them is left as it is: a
 * second call does nothing, and what it returns does nothing either.
 */
export function registerHomeCommands(registry: CommandRegistry, core: CoreApi): () => void {
  if (registered.has(registry)) return () => {};
  registered.add(registry);
  const held: Array<() => void> = [registry.addSource(homeQuerySource(core))];
  for (const entry of homeCommands())
    if (!registry.get(entry.id) && registry.backs(entry)) held.push(registry.register(entry));
  return () => {
    for (const release of held.splice(0)) release();
    registered.delete(registry);
  };
}
