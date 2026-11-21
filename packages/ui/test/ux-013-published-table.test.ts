/**
 * UX-013 criterion 1: the published shortcut table (spec/shortcuts/) lists, for every built-in
 * command with keys and for the shell's own keys, the conventional shortcut, this product's
 * shortcut, and for Chrome, Edge, Firefox and Safari whether the keys conflict and what the
 * alternative is.
 *
 * What a browser's list says cannot be tested here: it was read by a person (table.ts gives the
 * sources and the date). What is tested is that the table is complete and holds together: every
 * browser has a source, so no column says "not checked"; every conflict is about a key of its row,
 * quotes a meaning and says what to do; an alternative is named; and the published files are a
 * fresh generation.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { builtinCommands } from '../src/commands/index.ts';
import {
  SHORTCUTS_JSON,
  SHORTCUTS_MD,
  alternativesFor,
  buildShortcutTable,
} from '../src/shortcuts/build.ts';
import {
  BROWSERS,
  type BrowserName,
  type Conflict,
  SHORTCUT_TABLE,
  SOURCES,
  type ShortcutRow,
} from '../src/shortcuts/table.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const commands = builtinCommands().map((c) => ({ id: c.id, keys: c.keys ?? [] }));
const built = buildShortcutTable(commands);
const text = (path: string) => built.artifacts.find((a) => a.path === path)!.text;

interface PublishedConflict extends Conflict {
  use?: string[];
}
interface Published {
  browsers: Record<BrowserName, { url: string; read: string } | null>;
  rows: Array<{
    id: string;
    kind: string;
    conventional: string[];
    keys: string[];
    alternative: string[];
    browsers: Record<BrowserName, { status: string; conflicts: PublishedConflict[] }>;
  }>;
}
const published = JSON.parse(text(SHORTCUTS_JSON)) as Published;
/** The cells of a row of the Markdown table, by column. */
function cells(id: string): string[] {
  const line = text(SHORTCUTS_MD)
    .split('\n')
    .find((l) => l.startsWith(`| \`${id}\` |`));
  if (!line) throw new Error(`no row for ${id}`);
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}
const COLUMN: Record<BrowserName, number> = { chrome: 4, edge: 5, firefox: 6, safari: 7 };

describe('UX-013 criterion 1: the published shortcut table', () => {
  it('is a fresh generation, and builds without a problem', () => {
    expect(built.problems).toEqual([]);
    for (const a of built.artifacts) {
      const onDisk = readFileSync(resolve(root, a.path), 'utf8').replace(/\r\n/g, '\n');
      expect(onDisk, `${a.path} is stale; run pnpm --filter @docedit/ui generate`).toBe(a.text);
    }
  });

  it('has a row for every built-in command with keys, with the keys the command binds', () => {
    const withKeys = commands.filter((c) => c.keys.length > 0);
    expect(withKeys.length).toBeGreaterThan(0);
    for (const c of withKeys) {
      const row = published.rows.find((r) => r.id === c.id);
      expect(row, c.id).toBeDefined();
      expect(row!.keys, c.id).toEqual(c.keys);
      // The three columns before the browsers: conventional, this product, alternative.
      const [, conventional, product, alternative] = cells(c.id);
      expect(conventional, c.id).not.toBe('');
      expect(product, c.id).not.toBe('none');
      expect(alternative, c.id).not.toBe('');
    }
  });

  it('was read for all four browsers: every list has a source and a date, and no cell is "not checked"', () => {
    expect(BROWSERS).toEqual(['chrome', 'edge', 'firefox', 'safari']);
    for (const b of BROWSERS) {
      const source = SOURCES[b];
      expect(source, b).not.toBeNull();
      expect(source!.url, b).toMatch(/^https:\/\//);
      expect(source!.read, b).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(published.browsers[b], b).toEqual(source);
    }
    for (const row of published.rows)
      for (const b of BROWSERS) {
        const state = row.browsers[b];
        expect(['conflict', 'none-listed'], `${row.id} ${b}`).toContain(state.status);
        expect(state.status === 'conflict', `${row.id} ${b}`).toBe(state.conflicts.length > 0);
        const cell = cells(row.id)[COLUMN[b]]!;
        expect(cell, `${row.id} ${b}`).not.toContain('not checked');
        if (state.status === 'none-listed') expect(cell, `${row.id} ${b}`).toBe('none listed');
      }
    expect(text(SHORTCUTS_MD)).not.toContain('could not be read');
  });

  it('says for every conflict which key, on which platform, in the list’s words, and what to do', () => {
    let seen = 0;
    for (const row of SHORTCUT_TABLE)
      for (const conflict of row.conflicts) {
        seen++;
        const where = `${row.id} ${conflict.browser} ${conflict.key}`;
        expect([...row.keys, ...row.alternative], where).toContain(conflict.key);
        expect(conflict.meaning.trim(), where).not.toBe('');
        expect(['windows-linux', 'macos'], where).toContain(conflict.platform);
        // Safari is a Mac browser: its list gives no key a meaning on another platform.
        if (conflict.browser === 'safari') expect(conflict.platform, where).toBe('macos');
        const cell = cells(row.id)[COLUMN[conflict.browser]]!;
        expect(cell, where).toContain(`“${conflict.meaning}”`);
        expect(cell, where).toContain(conflict.platform === 'macos' ? 'macOS' : 'Windows, Linux');
        if (conflict.resolution === 'inside-editor')
          expect(cell, where).toContain('the editor takes it only inside the editor');
      }
    expect(seen).toBeGreaterThan(0);
  });

  it('names the alternative of a conflict that has one, in the table and in the JSON', () => {
    let named = 0;
    for (const row of published.rows)
      for (const b of BROWSERS)
        for (const conflict of row.browsers[b].conflicts) {
          const where = `${row.id} ${b} ${conflict.key}`;
          if (conflict.resolution !== 'alternative') {
            expect(conflict.use, where).toBeUndefined();
            continue;
          }
          named++;
          expect(conflict.use, where).toEqual(
            alternativesFor(
              SHORTCUT_TABLE.find((r) => r.id === row.id)!,
              conflict.key,
            ),
          );
          expect(conflict.use!.length, where).toBeGreaterThan(0);
          // Never the key that conflicts, and always a key the row binds.
          expect(conflict.use, where).not.toContain(conflict.key);
          for (const key of conflict.use!)
            expect([...row.keys, ...row.alternative], where).toContain(key);
          expect(cells(row.id)[COLUMN[b]], where).toMatch(/; use \S/);
        }
    expect(named).toBeGreaterThan(0);
    // The documented alternatives, as a person reads them.
    expect(cells('shell.nextLandmark')[COLUMN.chrome]).toBe(
      'Ctrl+F6: “Skip to web contents” (Windows, Linux); use Alt+F6',
    );
    expect(cells('edit.redo')[COLUMN.edge]).toBe('Cmd+Y: “Open History” (macOS); use Shift+Cmd+Z');
    expect(cells('format.painter')[COLUMN.firefox]).toBe(
      'Ctrl+Shift+C: “Inspector” (Windows, Linux); use Ctrl+Alt+Shift+C',
    );
  });

  it('writes a conflict worded the same on both platforms once, with both forms of the key', () => {
    expect(cells('format.bold')[COLUMN.firefox]).toBe(
      'Ctrl+B / Cmd+B: “Bookmarks sidebar” (Windows, Linux, macOS); the editor takes it only inside the editor',
    );
    // A key that is the same on both platforms is written once too.
    expect(cells('shell.cancel')[COLUMN.chrome]).toBe(
      'Escape: “Stop the page loading” (Windows, Linux, macOS); the editor takes it only inside the editor',
    );
    // Worded differently on the two platforms: one entry each.
    const edge = cells('shell.cancel')[COLUMN.edge]!;
    expect(edge).toContain('(Windows, Linux); the editor');
    expect(edge).toContain('(macOS); the editor');
  });
});

describe('UX-013 criterion 1: what the build refuses', () => {
  const row = (over: Partial<ShortcutRow>): ShortcutRow => ({
    id: 'shell.test',
    kind: 'shell',
    conventional: [],
    keys: ['Alt-F9'],
    alternative: [],
    conflicts: [],
    ...over,
  });
  const conflict = (over: Partial<Conflict> = {}): Conflict => ({
    browser: 'firefox',
    platform: 'windows-linux',
    key: 'Alt-F9',
    meaning: 'Something of the browser',
    resolution: 'inside-editor',
    ...over,
  });
  const problemsOf = (r: ShortcutRow) => buildShortcutTable([], [r]).problems;

  it('accepts a conflict about a key of the row', () => {
    expect(problemsOf(row({ conflicts: [conflict()] }))).toEqual([]);
  });

  it('refuses a conflict about a key the row does not bind', () => {
    expect(problemsOf(row({ conflicts: [conflict({ key: 'Alt-F8' })] }))).toEqual([
      'row "shell.test" records a conflict for "Alt-F8", which is not one of its keys',
    ]);
  });

  it('refuses a conflict without the list’s wording', () => {
    expect(problemsOf(row({ conflicts: [conflict({ meaning: '  ' })] }))).toEqual([
      'row "shell.test" records a conflict in firefox without a meaning',
    ]);
  });

  it('refuses the same key recorded twice for one browser and platform', () => {
    expect(
      problemsOf(row({ conflicts: [conflict(), conflict({ meaning: 'Another meaning' })] })),
    ).toEqual(['row "shell.test" records "Alt-F9" in firefox twice for one platform']);
    // The other platform is another entry, not a repeat.
    expect(problemsOf(row({ conflicts: [conflict(), conflict({ platform: 'macos' })] }))).toEqual(
      [],
    );
  });

  it('refuses an alternative that the row does not bind', () => {
    expect(problemsOf(row({ conflicts: [conflict({ resolution: 'alternative' })] }))).toEqual([
      'row "shell.test" resolves a conflict with an alternative but binds none',
    ]);
    expect(
      problemsOf(
        row({ alternative: ['Alt-F8'], conflicts: [conflict({ resolution: 'alternative' })] }),
      ),
    ).toEqual([]);
  });

  it('gives each browser the status of its conflicts, whatever the conflicts are (property)', () => {
    const anyConflict = fc.record({
      browser: fc.constantFrom<BrowserName>(...BROWSERS),
      platform: fc.constantFrom<Conflict['platform']>('windows-linux', 'macos'),
      key: fc.constantFrom('Alt-F9', 'Mod-j'),
      meaning: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}[A-Za-z]$/),
      resolution: fc.constantFrom<Conflict['resolution']>('alternative', 'inside-editor'),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(anyConflict, {
          maxLength: 8,
          selector: (c) => `${c.browser} ${c.platform} ${c.key}`,
        }),
        (conflicts) => {
          const r = row({ keys: ['Alt-F9', 'Mod-j'], conflicts });
          const out = buildShortcutTable([], [r]);
          expect(out.problems).toEqual([]);
          const json = JSON.parse(
            out.artifacts.find((a) => a.path === SHORTCUTS_JSON)!.text,
          ) as Published;
          const line = out.artifacts
            .find((a) => a.path === SHORTCUTS_MD)!
            .text.split('\n')
            .find((l) => l.startsWith('| `shell.test` |'))!
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim());
          for (const b of BROWSERS) {
            const mine = conflicts.filter((c) => c.browser === b);
            const state = json.rows[0]!.browsers[b];
            expect(state.status).toBe(mine.length ? 'conflict' : 'none-listed');
            expect(state.conflicts).toHaveLength(mine.length);
            const cell = line[COLUMN[b]]!;
            if (mine.length === 0) expect(cell).toBe('none listed');
            // Every conflict's wording and platform is in the cell, and an alternative is named.
            for (const c of mine) {
              expect(cell).toContain(`“${c.meaning}”`);
              expect(cell).toContain(c.platform === 'macos' ? 'macOS' : 'Windows, Linux');
              if (c.resolution === 'alternative') expect(cell).toContain('; use ');
              else expect(cell).toContain('the editor takes it only inside the editor');
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
