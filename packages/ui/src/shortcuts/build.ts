/**
 * Builds the published shortcut table (13 §4; UX-013 criteria 1, 2 and 5) from the table's source
 * (`table.ts`) and the built-in commands. Pure: the generator and the tests pass the inputs in.
 * Every check is a problem here, and the generator refuses to write while there is one:
 *
 * - every built-in command with keys has a row, and the row's keys are the entry's;
 * - every row names a built-in command or a key of the shell;
 * - no key is bound twice, on either platform, counting the alternatives;
 * - a conflict is resolved: by an alternative the row binds, or by taking the key only inside the
 *   editor; a browser with a published list has its source;
 * - a conflict is about a key its row binds, carries the list's wording, and is recorded once for a
 *   browser and a platform.
 */
import { ariaShortcut, canonicalKey } from '../commands/keys.ts';
import { BROWSERS, type Conflict, SHORTCUT_TABLE, SOURCES, type ShortcutRow } from './table.ts';

export interface CommandKeys {
  readonly id: string;
  readonly keys: readonly string[];
}

export interface ShortcutArtifacts {
  readonly problems: readonly string[];
  readonly artifacts: ReadonlyArray<{ readonly path: string; readonly text: string }>;
}

export const SHORTCUTS_JSON = 'spec/shortcuts/shortcut-table.json';
export const SHORTCUTS_MD = 'spec/shortcuts/shortcut-table.md';

const BROWSER_NAMES: Readonly<Record<string, string>> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  safari: 'Safari',
};

function shown(key: string, apple: boolean): string {
  return ariaShortcut(key, apple)
    .replace(/\bControl\b/g, 'Ctrl')
    .replace(/\bMeta\b/g, 'Cmd');
}

/**
 * The keys that stand in for a key a browser gives another meaning: the row's alternative, or
 * another of the row's own keys (Shift+Cmd+Z for redo on macOS). In the registry's notation.
 */
export function alternativesFor(row: ShortcutRow, key: string): string[] {
  return [...row.alternative, ...row.keys.filter((k) => k !== key)];
}

/** A key for Windows and Linux, with the Apple form after a slash where it differs. */
function bothForms(key: string): string {
  const pc = shown(key, false);
  const mac = shown(key, true);
  return pc === mac ? pc : `${pc} / ${mac}`;
}

const PLATFORMS = ['windows-linux', 'macos'] as const;
const PLATFORM_NAMES: Readonly<Record<Conflict['platform'], string>> = {
  'windows-linux': 'Windows, Linux',
  macos: 'macOS',
};

/**
 * One browser's cell of a row: each conflict with its key, the list's wording, the platforms and
 * what a person does about it. For an alternative the keys to use are named, so the table says what
 * the alternative is (UX-013 criterion 1). A conflict the list words the same way on both platforms
 * is written once, with both forms of the key.
 */
function conflictCell(row: ShortcutRow, conflicts: readonly Conflict[]): string {
  const groups = new Map<string, Conflict[]>();
  for (const c of conflicts) {
    const same = `${c.key}\u0000${c.meaning}\u0000${c.resolution}`;
    groups.set(same, [...(groups.get(same) ?? []), c]);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0]!;
      const on = PLATFORMS.filter((p) => group.some((c) => c.platform === p));
      const form = (key: string) =>
        on.length === 2 ? bothForms(key) : shown(key, on[0] === 'macos');
      const what =
        first.resolution === 'inside-editor'
          ? 'the editor takes it only inside the editor'
          : `use ${alternativesFor(row, first.key).map(form).join(' or ')}`;
      const where = on.map((p) => PLATFORM_NAMES[p]).join(', ');
      return `${form(first.key)}: “${first.meaning}” (${where}); ${what}`;
    })
    .join('; ');
}

export function buildShortcutTable(
  commands: readonly CommandKeys[],
  table: readonly ShortcutRow[] = SHORTCUT_TABLE,
): ShortcutArtifacts {
  const problems: string[] = [];
  const rows = new Map(table.map((r) => [r.id, r]));
  const withKeys = commands.filter((c) => c.keys.length > 0);

  for (const c of withKeys) {
    const row = rows.get(c.id);
    if (!row) problems.push(`command "${c.id}" has keys but no row in the shortcut table`);
    else if (row.keys.join(' ') !== c.keys.join(' '))
      problems.push(
        `row "${c.id}" lists ${row.keys.join(', ')}, but the command binds ${c.keys.join(', ')}`,
      );
  }
  for (const row of table) {
    if (row.kind === 'command' && !withKeys.some((c) => c.id === row.id))
      problems.push(`row "${row.id}" names no built-in command with keys`);
    if (row.kind === 'shell' && !row.id.startsWith('shell.'))
      problems.push(`row "${row.id}" is a key of the shell but is not named "shell.*"`);
    const recorded = new Set<string>();
    for (const conflict of row.conflicts) {
      // The alternative may be another of the row's own keys (Shift+Cmd+Z for redo on macOS).
      const others = alternativesFor(row, conflict.key);
      if (conflict.resolution === 'alternative' && others.length === 0)
        problems.push(`row "${row.id}" resolves a conflict with an alternative but binds none`);
      if (!SOURCES[conflict.browser])
        problems.push(`row "${row.id}" records a conflict in ${conflict.browser} without a source`);
      // A conflict is about a key the row binds, is quoted from the list, and is recorded once.
      if (![...row.keys, ...row.alternative].includes(conflict.key))
        problems.push(
          `row "${row.id}" records a conflict for "${conflict.key}", which is not one of its keys`,
        );
      if (conflict.meaning.trim() === '')
        problems.push(
          `row "${row.id}" records a conflict in ${conflict.browser} without a meaning`,
        );
      const once = `${conflict.browser} ${conflict.platform} ${conflict.key}`;
      if (recorded.has(once))
        problems.push(
          `row "${row.id}" records "${conflict.key}" in ${conflict.browser} twice for one platform`,
        );
      recorded.add(once);
    }
  }
  // Keys that apply only while the format painter is on may repeat keys of the surface.
  for (const apple of [false, true]) {
    const seen = new Map<string, string>();
    for (const row of table) {
      if (row.when === 'shortcuts.when.painter') continue;
      for (const key of [...row.keys, ...row.alternative]) {
        const canonical = canonicalKey(key, apple);
        if (canonical === null) {
          problems.push(`row "${row.id}": "${key}" is not a shortcut`);
          continue;
        }
        const other = seen.get(canonical);
        if (other && other !== row.id)
          problems.push(
            `"${key}" is bound by "${other}" and "${row.id}"${apple ? ' on Apple platforms' : ''}`,
          );
        seen.set(canonical, row.id);
      }
    }
  }

  const json = {
    table: 'shortcuts',
    source: 'packages/ui/src/shortcuts/table.ts; docs/spec/13-experience-extensibility.md §4',
    generator: 'pnpm --filter @docedit/ui generate (packages/ui/scripts/generate.ts)',
    browsers: Object.fromEntries(BROWSERS.map((b) => [b, SOURCES[b]])),
    rows: table.map((r) => ({
      id: r.id,
      kind: r.kind,
      conventional: r.conventional,
      keys: r.keys,
      alternative: r.alternative,
      browsers: Object.fromEntries(
        BROWSERS.map((b) => {
          // With an alternative, `use` names the keys to press instead, in the registry's notation.
          const conflicts = r.conflicts
            .filter((c) => c.browser === b)
            .map((c) =>
              c.resolution === 'alternative' ? { ...c, use: alternativesFor(r, c.key) } : c,
            );
          const status = conflicts.length ? 'conflict' : SOURCES[b] ? 'none-listed' : 'not-checked';
          return [b, { status, conflicts }];
        }),
      ),
    })),
  };

  const md: string[] = [
    '# Shortcut table',
    '',
    'Generated from `packages/ui/src/shortcuts/table.ts` and the built-in commands by `pnpm --filter @docedit/ui generate`; do not edit by hand. The machine-readable form is `shortcut-table.json` next to this file (13 §4; UX-013).',
    '',
    'Keys are given for Windows and Linux, with the Apple form after the slash where it differs (`Mod` is Ctrl or Cmd). A browser column says what that browser’s published shortcut list says about the keys: a conflict and its meaning, “none listed” when the list was read and gives the keys no other meaning, or “not checked” when no list was read. An alternative is bound on every browser, so the documented alternative always works.',
    '',
    'A conflict is a meaning the list gives a key while focus is in a web page, in the list’s own words. A meaning that holds only in the browser’s own interface (the address bar, a sidebar, the find bar, a menu) is not counted, and neither is a key the list gives the meaning the command has (Firefox lists Undo, Redo and Select All). After a conflict the cell says what to do: “use” names the keys bound as well, and “the editor takes it only inside the editor” means the key runs the command while focus is in the editor and keeps the browser’s meaning elsewhere. A browser may act on a key its list does not name; that is not recorded here.',
    '',
    '| Command or key | Conventional | This product | Alternative | Chrome | Edge | Firefox | Safari |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const both = (keys: readonly string[]) => (keys.length ? keys.map(bothForms).join(', ') : 'none');
  for (const r of table) {
    const cells = BROWSERS.map((b) => {
      const conflicts = r.conflicts.filter((c) => c.browser === b);
      if (conflicts.length) return conflictCell(r, conflicts);
      return SOURCES[b] ? 'none listed' : 'not checked';
    });
    md.push(
      `| \`${r.id}\` | ${both(r.conventional)} | ${both(r.keys)} | ${both(r.alternative)} | ${cells.join(' | ')} |`,
    );
  }
  md.push('', '## Sources', '');
  for (const b of BROWSERS) {
    const s = SOURCES[b];
    md.push(
      s
        ? `- ${BROWSER_NAMES[b]}: ${s.url} (read ${s.read})`
        : `- ${BROWSER_NAMES[b]}: not checked; the published list could not be read.`,
    );
  }
  md.push('');

  return {
    problems,
    artifacts: [
      { path: SHORTCUTS_JSON, text: `${JSON.stringify(json, null, 2)}\n` },
      { path: SHORTCUTS_MD, text: md.join('\n') },
    ],
  };
}
