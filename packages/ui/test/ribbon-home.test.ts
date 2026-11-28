/**
 * The ribbon's Home tab (ADR 0490): the commands it adds to the registry beyond bold and italic, the
 * lists that are chosen from (style, size, colour, highlight), and how the tab groups them. They are
 * registered the way bold and italic are: only when the core declares the named commands they need,
 * with an `enabled` and an `active` query, and run through the registry so that access and mode apply.
 * The menu button and the roving focus are the component's and are in `e2e/ribbon.spec.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { homeCommands, registerHomeCommands } from '../src/commands/home.ts';
import { SOURCE_TABLE } from '../src/i18n/source.ts';
import { PROFILE } from '../src/parity/profile.ts';
import {
  createCommandRegistry,
  immediateScheduler,
  type CommandRegistry,
} from '../src/commands/index.ts';
import type { ParagraphFormatView, SelectionSummary, StyleSummary } from '../src/core-api.ts';
import {
  FONT_SIZES_PT,
  HIGHLIGHTS,
  TEXT_COLOURS,
  pickerChoices,
  pickerSummary,
  type PickerContext,
} from '../src/shell/ribbon-pickers.ts';
import { ribbonCommands, ribbonSmall, ribbonTabs } from '../src/shell/ribbon-groups.ts';
import { ribbonIconName, RIBBON_ICONS } from '../src/icons/ribbon-icons.ts';
import { BUILT_IN_ICONS } from '../src/icons/icons.ts';
import { toolbarCommands } from '../src/shell/toolbar-groups.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const HOME_IDS = [
  'format.underline',
  'format.strike',
  'format.clear',
  'format.fontSize',
  'format.color',
  'format.highlight',
  'format.align.start',
  'format.align.center',
  'format.align.end',
  'format.align.justify',
  'format.bulletList',
  'format.numberList',
  'format.indentLess',
  'format.indentMore',
];

const PARAGRAPH: ParagraphFormatView = {
  count: 1,
  indentLeft: 0,
  indentRight: 0,
  indentFirstLine: 0,
  tabs: [],
  defaultTabStop: 720,
  page: null,
  editable: true,
  options: {
    align: 'start',
    spaceBefore: 0,
    spaceAfter: 0,
    lineSpacing: 1000,
    lineRule: 'multiple',
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: true,
    contextualSpacing: false,
    borders: {},
    shading: null,
    mixed: [],
  },
};

const STYLES: readonly StyleSummary[] = [
  { id: 'Normal', name: 'Body text', kind: 'paragraph' },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' },
  { id: 'Strong', name: 'Strong', kind: 'character' },
];

/** A registry as the shell has it after it has mounted and asked for the Home commands. */
function registryFor(core: FakeCore): CommandRegistry {
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  registerHomeCommands(registry, core);
  return registry;
}

function extended(options: Partial<ConstructorParameters<typeof FakeCore>[0]> = {}): FakeCore {
  return new FakeCore({
    access: EDIT,
    extended: true,
    paragraphFormat: PARAGRAPH,
    styles: STYLES,
    ...options,
  });
}

function ran(core: FakeCore, name: string): Array<unknown> {
  return core.calls
    .filter((c) => c.method === 'runNamed' && c.args[0] === name)
    .map((c) => c.args[1]);
}

describe('the Home commands are registered as bold and italic are', () => {
  it('are offered when the core declares the named commands they run, and not otherwise', () => {
    const present = registryFor(extended());
    for (const id of HOME_IDS) expect(present.get(id), id).toBeDefined();
    // A core of phase 1a declares no named command, and then none of them is registered.
    const bare = registryFor(new FakeCore({ access: EDIT }));
    for (const id of HOME_IDS) expect(bare.get(id), id).toBeUndefined();
    expect(bare.get('format.bold')).toBeDefined();
  });

  it('are not in the first registry: the shell asks for them after it has mounted', () => {
    const first = createCommandRegistry(extended(), { scheduler: immediateScheduler() });
    for (const id of HOME_IDS) expect(first.get(id), id).toBeUndefined();
    expect(first.get('format.applyStyle')?.picker).toBe('style');
  });

  it('are registered once, and taken away again when the shell goes', () => {
    const core = extended();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    const release = registerHomeCommands(registry, core);
    const again = registerHomeCommands(registry, core);
    for (const id of HOME_IDS) expect(registry.get(id), id).toBeDefined();
    again();
    release();
    for (const id of HOME_IDS) expect(registry.get(id), id).toBeUndefined();
    expect(registry.get('format.bold')).toBeDefined();
  });

  it('name a capability of the parity profile, a string key for the label and the queries they read', () => {
    const registry = registryFor(extended());
    const rows = new Set(PROFILE.map((r) => r.id));
    expect(homeCommands().map((c) => c.id)).toEqual(expect.arrayContaining(HOME_IDS));
    for (const id of HOME_IDS) {
      const entry = registry.get(id)!;
      expect(Object.hasOwn(SOURCE_TABLE, entry.label), `${id}: ${entry.label}`).toBe(true);
      expect(entry.label, id).toMatch(/^ribbon\.command\.format\./);
      expect(rows.has(entry.capability), id).toBe(true);
      expect(['character-and-paragraph-formatting', 'lists'], id).toContain(entry.capability);
      expect(entry.changesContent, id).toBe(true);
      expect(entry.enabled, id).toBe('canEditSelection');
    }
  });

  it('bind no key: a key is for the shortcut reading of UX-013 to give', () => {
    const registry = registryFor(extended());
    for (const id of HOME_IDS) expect(registry.get(id)!.keys ?? [], id).toEqual([]);
  });

  it('are on the ribbon alone: the compact and the full toolbars show none of them', () => {
    const view = registryFor(extended()).view.get().commands;
    const shown = toolbarCommands(view, []).map((c) => c.id);
    for (const id of [...HOME_IDS, 'format.applyStyle']) expect(shown, id).not.toContain(id);
    const ribbon = ribbonCommands(view, []).map((c) => c.id);
    for (const id of [...HOME_IDS, 'format.applyStyle']) expect(ribbon, id).toContain(id);
    // The toolbars' own commands are still on the ribbon.
    for (const id of shown) expect(ribbon, id).toContain(id);
    expect(
      view
        .filter((c) => c.entry.picker)
        .map((c) => c.entry.picker)
        .sort(),
    ).toEqual(['colour', 'fontSize', 'highlight', 'style']);
  });
});

describe('running the Home commands', () => {
  it('toggles underline and strike-through, and shows them pressed while the selection has them', () => {
    const core = extended();
    const registry = registryFor(core);
    expect(registry.state('format.underline').active).toBe(false);
    expect(registry.exec('format.underline').ran).toBe(true);
    expect(registry.state('format.underline').active).toBe(true);
    expect(registry.state('format.strike').active).toBe(false);
    registry.exec('format.strike');
    expect(registry.state('format.strike').active).toBe(true);
    registry.exec('format.underline');
    expect(registry.state('format.underline').active).toBe(false);
    expect(ran(core, 'underline')).toHaveLength(2);
  });

  it('clears formatting only where there is some', () => {
    const core = extended();
    const registry = registryFor(core);
    expect(registry.exec('format.clear')).toEqual({ ran: false, reason: 'no-effect' });
    registry.exec('format.underline');
    expect(registry.exec('format.clear').ran).toBe(true);
    expect(registry.state('format.underline').active).toBe(false);
  });

  it('hands the choice of a list to the core in the shape it checks', () => {
    const core = extended();
    const registry = registryFor(core);
    registry.exec('format.fontSize', { value: 240 });
    registry.exec('format.fontSize', { value: null });
    registry.exec('format.color', { value: '#A4262C' });
    registry.exec('format.highlight', { value: 'yellow' });
    registry.exec('format.applyStyle', { style: 'Heading1', kind: 'paragraph' });
    expect(ran(core, 'fontSize')).toEqual([{ fontSize: 240 }, { fontSize: null }]);
    expect(ran(core, 'color')).toEqual([{ color: '#A4262C' }]);
    expect(ran(core, 'highlight')).toEqual([{ highlight: 'yellow' }]);
    expect(ran(core, 'paragraphStyle')).toEqual([{ style: 'Heading1' }]);
    expect(core.selection.get().fontSize).toBeNull();
  });

  it('sets the alignment of the paragraphs, and shows the one they have as pressed', () => {
    const core = extended();
    const registry = registryFor(core);
    expect(registry.state('format.align.start').active).toBe(true);
    expect(registry.state('format.align.center').active).toBe(false);
    expect(registry.exec('format.align.center').ran).toBe(true);
    expect(ran(core, 'setParagraphFormat')).toEqual([{ align: 'center' }]);
    expect(registry.state('format.align.center').active).toBe(true);
    expect(registry.state('format.align.start').active).toBe(false);
    for (const to of ['end', 'justify'] as const) {
      registry.exec(`format.align.${to}`);
      expect(registry.state(`format.align.${to}`).active).toBe(true);
    }
  });

  it('asks the core for a bulleted or a numbered list by kind', () => {
    const core = extended();
    const registry = registryFor(core);
    registry.exec('format.bulletList');
    registry.exec('format.numberList');
    expect(ran(core, 'applyList')).toEqual([{ listKind: 'bullet' }, { listKind: 'number' }]);
  });

  it('moves a list item by level, and any other paragraph by the tab step', () => {
    const core = extended();
    const registry = registryFor(core);
    registry.exec('format.indentMore');
    expect(ran(core, 'listLevelUp')).toHaveLength(1);
    expect(ran(core, 'setParagraphFormat')).toEqual([]);

    // Not in a list: the level command does nothing, and the paragraph's left indent moves.
    const spy = vi.spyOn(core, 'runNamed');
    spy.mockImplementation(function (this: FakeCore, name: string, args?: unknown) {
      if (name === 'listLevelUp' || name === 'listLevelDown') return false;
      return FakeCore.prototype.runNamed.call(this, name, args);
    });
    registry.exec('format.indentMore');
    expect(core.paragraphFormat!.get()!.indentLeft).toBe(720);
    registry.exec('format.indentMore');
    expect(core.paragraphFormat!.get()!.indentLeft).toBe(1440);
    registry.exec('format.indentLess');
    registry.exec('format.indentLess');
    expect(core.paragraphFormat!.get()!.indentLeft).toBe(0);
    // Never past the margin.
    expect(registry.exec('format.indentLess').ran).toBe(true);
    expect(core.paragraphFormat!.get()!.indentLeft).toBe(0);
  });

  it('is disabled with its reason for a reader, and runs nothing', () => {
    const core = extended({ access: VIEW });
    const registry = registryFor(core);
    for (const id of HOME_IDS) {
      const state = registry.state(id);
      expect(state.enabled, id).toBe(false);
      expect(state.reason, id).toBe('no-access');
      expect(registry.exec(id, { value: 240 }).ran, id).toBe(false);
    }
    expect(core.calls.filter((c) => c.method === 'runNamed')).toEqual([]);
  });
});

describe('the Home tab of the ribbon', () => {
  /** The shell registers the format painter and the paragraph dialog; stand-ins place them the same way. */
  function withShell(core: FakeCore): CommandRegistry {
    const registry = registryFor(core);
    for (const id of ['format.painter', 'format.paragraph'])
      registry.register({
        id,
        label: 'command.format.paragraph',
        group: 'format',
        changesContent: false,
        capability: 'editing',
        run: () => true,
      });
    return registry;
  }

  function home(core: FakeCore = extended()) {
    const view = withShell(core).view.get().commands;
    const tab = ribbonTabs(ribbonCommands(view, [])).find((t) => t.id === 'home')!;
    return Object.fromEntries(tab.groups.map((g) => [g.key, g.commands.map((c) => c.id)]));
  }

  it('lays out edit, styles, font, paragraph and copy format, in that order', () => {
    expect(Object.keys(home())).toEqual(['edit', 'styles', 'font', 'paragraph', 'copyFormat']);
  });

  it('puts the style list alone in Styles and the size first in Font', () => {
    const groups = home();
    expect(groups['styles']).toEqual(['format.applyStyle']);
    expect(groups['font']).toEqual([
      'format.fontSize',
      'format.bold',
      'format.italic',
      'format.underline',
      'format.strike',
      'format.color',
      'format.highlight',
      'format.clear',
    ]);
    expect(groups['copyFormat']).toEqual(['format.painter']);
  });

  it('puts alignment, lists and indents in Paragraph, the paragraph dialog last', () => {
    expect(home()['paragraph']).toEqual([
      'format.align.start',
      'format.align.center',
      'format.align.end',
      'format.align.justify',
      'format.bulletList',
      'format.numberList',
      'format.indentLess',
      'format.indentMore',
      'format.paragraph',
    ]);
  });

  it('places every shown command, and every list, once (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(EDIT, VIEW), fc.boolean(), (access, withStyles) => {
        const view = registryFor(extended({ access, styles: withStyles ? STYLES : [] })).view.get()
          .commands;
        const shown = ribbonCommands(view, []);
        const placed = ribbonTabs(shown).flatMap((t) =>
          t.groups.flatMap((g) => g.commands.map((c) => c.id)),
        );
        expect([...placed].sort()).toEqual(shown.map((c) => c.id).sort());
        expect(new Set(placed).size).toBe(placed.length);
      }),
    );
  });

  it('draws the toggles, alignment, list and indent buttons small, and the lists with their text', () => {
    const view = registryFor(extended()).view.get().commands;
    const small = view.filter((c) => ribbonSmall(c)).map((c) => c.id);
    expect(small).toEqual(
      expect.arrayContaining([
        'format.bold',
        'format.underline',
        'format.align.center',
        'format.bulletList',
        'format.indentMore',
      ]),
    );
    expect(small).not.toContain('format.fontSize');
    expect(small).not.toContain('edit.undo');
  });

  it('gives each of them a ribbon drawing of its own', () => {
    const view = registryFor(extended()).view.get().commands;
    const names = new Set<string>();
    for (const c of ribbonCommands(view, []).filter((x) => HOME_IDS.includes(x.id))) {
      if (c.entry.picker === 'fontSize') continue;
      const name = ribbonIconName(c);
      expect(name, c.id).toBeDefined();
      expect(name! in BUILT_IN_ICONS || name! in RIBBON_ICONS, `${c.id}: ${name}`).toBe(true);
      names.add(name!);
    }
    expect(names.size).toBeGreaterThanOrEqual(11);
  });
});

describe('the lists that are chosen from', () => {
  const selection = (extra: Partial<SelectionSummary> = {}): SelectionSummary => ({
    empty: true,
    scope: 'body',
    region: null,
    style: 'Body text',
    styleId: 'Normal',
    marks: [],
    ...extra,
  });
  const context = (extra: Partial<SelectionSummary> = {}): PickerContext => ({
    styles: STYLES,
    selection: selection(extra),
    text: (key) => key,
  });

  it('lists the paragraph styles of the document, and marks the one at the selection', () => {
    const choices = pickerChoices('style', context({ styleId: 'Heading1', style: 'Heading 1' }));
    expect(choices.map((c) => c.label)).toEqual(['Body text', 'Heading 1']);
    expect(choices.map((c) => c.checked)).toEqual([false, true]);
    expect(choices[1]!.args).toEqual({ style: 'Heading1', kind: 'paragraph' });
    expect(pickerSummary('style', context({ styleId: 'Heading1', style: 'Heading 1' }))).toBe(
      'Heading 1',
    );
  });

  it('offers sizes the model allows, in twentieths of a point, and marks the current one', () => {
    const choices = pickerChoices('fontSize', context({ fontSize: 240 }));
    const sizes = choices.filter((c) => c.id !== 'default');
    expect(sizes.map((c) => c.label)).toEqual(FONT_SIZES_PT.map(String));
    for (const c of sizes) {
      const value = (c.args as { value: number }).value;
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(20);
      expect(value).toBeLessThanOrEqual(32760);
    }
    expect(sizes.find((c) => c.checked === true)?.label).toBe('12');
    expect(choices.at(-1)!.args).toEqual({ value: null });
    expect(pickerSummary('fontSize', context({ fontSize: 240 }))).toBe('12');
    expect(pickerSummary('fontSize', context({ fontSize: 230 }))).toBe('11.5');
    expect(pickerSummary('fontSize', context({ fontSize: null }))).toBeNull();
  });

  it('offers text colours in the model’s grammar, each readable on white, and a way to take it off', () => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    for (const { value } of TEXT_COLOURS) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/);
      expect(1.05 / (luminance(value) + 0.05), value).toBeGreaterThanOrEqual(4.5);
    }
    const choices = pickerChoices('colour', context());
    expect(choices[0]!.args).toEqual({ value: null });
    expect(choices.slice(1).map((c) => (c.args as { value: string }).value)).toEqual(
      TEXT_COLOURS.map((c) => c.value),
    );
  });

  it('offers only highlight names of the model, and a way to take it off', () => {
    const model = [
      'yellow',
      'green',
      'cyan',
      'magenta',
      'blue',
      'red',
      'darkBlue',
      'darkCyan',
      'darkGreen',
      'darkMagenta',
      'darkRed',
      'darkYellow',
      'darkGray',
      'lightGray',
      'black',
      'white',
    ];
    for (const { name } of HIGHLIGHTS) expect(model).toContain(name);
    const choices = pickerChoices('highlight', context());
    expect(choices[0]!.args).toEqual({ value: null });
    expect(choices.slice(1).every((c) => typeof c.swatch === 'string')).toBe(true);
  });
});
