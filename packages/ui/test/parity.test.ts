/**
 * The parity profile (UX-001; 13 §2): published artifacts equal to a fresh generation, every
 * capability of 13 §2 in exactly one tier with its phase and stories, non-goals refused, every
 * built-in command's capability in the profile, and rows that say what a user can do.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builtinCommands } from '../src/commands/builtin.ts';
import { buildProfile, parityTable, splitItems, type BuildInput } from '../src/parity/build.ts';
import { PROFILE, type ProfileRow } from '../src/parity/profile.ts';
import { readParityInput } from '../scripts/parity-input.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const input = readParityInput(root);

function with_(change: Partial<BuildInput>): string[] {
  return [...buildProfile({ ...input, ...change }).problems];
}

describe('the published profile', () => {
  it('passes every check', () => {
    expect(buildProfile(input).problems).toEqual([]);
  });

  it('matches a fresh generation byte for byte', () => {
    for (const a of buildProfile(input).artifacts) {
      const text = readFileSync(resolve(root, a.path), 'utf8').replace(/\r\n/g, '\n');
      expect(text, `${a.path} is stale; run pnpm --filter @docedit/ui generate`).toBe(a.text);
    }
  });

  it('is identical when generated twice', () => {
    expect(buildProfile(input).artifacts).toEqual(buildProfile(readParityInput(root)).artifacts);
  });
});

describe('every capability of 13 §2 in exactly one tier (UX-001, criterion 1)', () => {
  const table = parityTable(input.spec13);

  it('reads the three tiers of 13 §2', () => {
    expect(table['built-in']).toHaveLength(41);
    expect(table['ports-and-extensions']).toHaveLength(8);
    expect(table['non-goal']).toHaveLength(10);
    expect(table['built-in'][0]).toBe('A tabbed toolbar with compact and full layouts');
    expect(splitItems('a, b (c, d), e')).toEqual(['a', 'b (c, d)', 'e']);
  });

  it('covers each item with rows of its own tier only', () => {
    for (const [tier, items] of Object.entries(table))
      for (const item of items) {
        const rows = PROFILE.filter((r) => r.items.includes(item));
        expect(rows.length, item).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.tier)), item).toEqual(new Set([tier]));
      }
  });

  it('gives each delivered row its phase and its stories', () => {
    const json = JSON.parse(buildProfile(input).artifacts[0]!.text) as {
      rows: Array<{
        id: string;
        tier: string;
        phase: string | null;
        stories: Array<{ id: string; phase: string }>;
        gap?: string;
      }>;
    };
    for (const row of json.rows.filter((r) => r.tier !== 'non-goal')) {
      if (row.stories.length === 0) expect(row.gap, row.id).toBeTruthy();
      else expect(row.phase, row.id).toBe(row.stories.at(-1)!.phase);
    }
    expect(json.rows.find((r) => r.id === 'presence')).toMatchObject({
      phase: '1b',
      stories: [
        { id: 'UX-026', phase: '1a' },
        { id: 'UX-027', phase: '1b' },
      ],
    });
  });

  it('fails when an item of 13 §2 is not covered, or a row quotes one it does not have', () => {
    const without = PROFILE.filter((r) => r.id !== 'zoom');
    expect(with_({ profile: without })).toContain(
      '13 §2 lists "zoom" (built-in), but no row covers it',
    );
    const moved = PROFILE.map((r): ProfileRow =>
      r.id === 'macros' ? { ...r, tier: 'built-in', stories: ['UX-003'] } : r,
    );
    expect(with_({ profile: moved }).join('\n')).toMatch(
      /row "macros" puts "macros" in built-in, but 13 §2 lists it as non-goal/,
    );
    const invented = [...PROFILE, { ...PROFILE[0]!, id: 'teleport', items: ['teleporting'] }];
    expect(with_({ profile: invented })).toContain(
      'row "teleport" quotes "teleporting", which 13 §2 does not list',
    );
  });
});

describe('non-goals are refused (UX-001, criterion 2)', () => {
  it('lists the non-goals of the story, all with no delivering story', () => {
    const nonGoals = PROFILE.filter((r) => r.tier === 'non-goal');
    expect(nonGoals.map((r) => r.id)).toEqual([
      'smartart',
      'charts',
      'shapes',
      'text-boxes-and-ink',
      'mail-merge',
      'macros',
      'table-formulas',
      'researcher-lookup',
      'transcription',
      'offline-first',
    ]);
    for (const row of nonGoals) expect(row.stories, row.id).toEqual([]);
  });

  it('refuses a story that would deliver a non-goal', () => {
    const proposed = PROFILE.map((r): ProfileRow =>
      r.id === 'mail-merge' ? { ...r, stories: ['FRW-063'] } : r,
    );
    expect(with_({ profile: proposed })).toContain(
      'non-goal "mail-merge" names delivering stories (FRW-063): refused',
    );
  });

  it('refuses a change of the non-goals without an owner decision', () => {
    const dropped = PROFILE.filter((r) => r.id !== 'transcription');
    expect(with_({ profile: dropped }).join('\n')).toMatch(
      /non-goals changed .* without an owner decision/,
    );
  });

  it('refuses a command that would deliver a non-goal', () => {
    const commands = [...input.commands, { id: 'tools.macro', capability: 'macros' }];
    expect(with_({ commands })).toContain(
      'command "tools.macro" delivers "macros", which is a non-goal: refused',
    );
  });
});

describe('built-in commands need a profile row (UX-001, criterion 3)', () => {
  it('names a row for every built-in command', () => {
    const ids = new Set(PROFILE.map((r) => r.id));
    for (const command of builtinCommands())
      expect(ids.has(command.capability), command.id).toBe(true);
  });

  it('fails the build for a command whose capability no row lists', () => {
    const commands = [...input.commands, { id: 'format.sparkle', capability: 'sparkles' }];
    expect(with_({ commands })).toContain(
      'command "format.sparkle" names capability "sparkles", which no row lists',
    );
  });
});

describe('rows say what a user can do (UX-001, criterion 4)', () => {
  it('fails on another product’s names and on prescribed looks', () => {
    const named = PROFILE.map((r): ProfileRow =>
      r.id === 'toolbar' ? { ...r, can: 'Use a Ribbon like Microsoft Word.' } : r,
    );
    const problems = with_({ profile: named }).join('\n');
    expect(problems).toMatch(/row "toolbar" names another product's feature or design/);
    expect(problems).toMatch(/row "toolbar" prescribes a look or arrangement/);
  });

  it('allows a Word file as a format', () => {
    expect(PROFILE.find((r) => r.id === 'docx')!.can).toContain('Word file');
    expect(buildProfile(input).problems).toEqual([]);
  });
});
