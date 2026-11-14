/**
 * Command search (UX-011; 13 §2, §4): matching on translated labels, synonyms when the host gives
 * them, permissions shown on the hits and enforced by `exec`, extension commands listed with the
 * built-in ones, and "no results" with nothing run. Ranking and synonyms are the spec-open points
 * recorded in the story's Notes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  activateFirstHit,
  CommandRegistry,
  coreQuerySource,
  createCommandRegistry,
  immediateScheduler,
  normaliseQuery,
  runSearchHit,
  searchCommands,
  type CommandEntry,
} from '../src/commands/index.ts';
import { sourceTranslator } from '../src/i18n/strings.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const translate = sourceTranslator();

function setup(options: ConstructorParameters<typeof FakeCore>[0] = {}) {
  const core = new FakeCore({ extended: true, ...options });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  return { core, registry };
}

function extension(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: 'ext.stamp',
    label: 'command.format.bold',
    group: 'format',
    changesContent: false,
    capability: 'editing',
    run: () => true,
    ...overrides,
  };
}

describe('command search matches the labels of the registry (UX-011, criterion 1)', () => {
  it('lists the commands whose label holds the typed part, best match first', () => {
    const { registry } = setup({ access: EDIT });
    const results = searchCommands(registry, 'bol', { translate });
    const ids = results.hits.map((h) => h.id);
    expect(ids).toContain('format.bold');
    expect(results.emptyKey).toBeNull();
    const bold = results.hits.find((h) => h.id === 'format.bold')!;
    expect(bold.label).toBe('Bold');
    expect(bold.runnable).toBe(true);
    expect(bold.reasonKey).toBeNull();
  });

  it('ranks a label that starts with the query above one that only contains it', () => {
    const { registry } = setup({ access: EDIT });
    registry.register(extension({ id: 'ext.inside', label: 'command.edit.undo' }));
    const results = searchCommands(registry, 'b', { translate });
    const ranks = results.hits.map((h) => h.rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(results.hits[0]!.label.toLowerCase().startsWith('b')).toBe(true);
  });

  it('lists nothing for an empty query, and says "no results" with nothing run for no match', () => {
    const { core, registry } = setup({ access: EDIT });
    expect(searchCommands(registry, '   ', { translate })).toEqual({
      query: '',
      hits: [],
      emptyKey: null,
    });
    const none = searchCommands(registry, 'zzqx', { translate });
    expect(none.hits).toEqual([]);
    expect(none.emptyKey).toBe('search.none');
    // Enter with no results runs nothing (criterion 6, the logic; the message is the surface's).
    expect(activateFirstHit(registry, none)).toBeNull();
    expect(core.callsOf('run')).toHaveLength(0);
  });

  it('runs the first hit when Enter is pressed on results', () => {
    const { core, registry } = setup({ access: EDIT });
    const results = searchCommands(registry, 'bold', { translate });
    expect(activateFirstHit(registry, results)).toEqual({ ran: true, reason: null });
    expect(core.callsOf('run').map((c) => c.args[0])).toEqual(['bold']);
  });

  it('never lists a command whose backend feature is not announced', () => {
    const { registry } = setup({ access: EDIT });
    registry.register(
      extension({ id: 'view.gated', label: 'command.edit.undo', feature: 'comments' }),
    );
    const ids = searchCommands(registry, 'undo', { translate }).hits.map((h) => h.id);
    expect(ids).not.toContain('view.gated');
  });
});

describe('command search and the user permissions (UX-011, criterion 3; UX-004)', () => {
  it('lists a command the access does not allow with its reason, and does not run it', () => {
    const { core, registry } = setup({ access: VIEW });
    const results = searchCommands(registry, 'bold', { translate });
    const bold = results.hits.find((h) => h.id === 'format.bold');
    expect(bold).toBeDefined();
    expect(bold).toMatchObject({ runnable: false, reasonKey: 'reason.access.view' });
    expect(runSearchHit(registry, bold!)).toEqual({ ran: false, reason: 'no-access' });
    expect(activateFirstHit(registry, results)).toEqual({ ran: false, reason: 'no-access' });
    expect(core.callsOf('run')).toHaveLength(0);
  });
});

describe('command search lists extension commands with the built-in ones (UX-011, criterion 4)', () => {
  it('finds a registered extension command by its label, next to the built-in one', () => {
    const { registry } = setup({ access: EDIT });
    registry.register(extension());
    const ids = searchCommands(registry, 'bold', { translate }).hits.map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(['format.bold', 'ext.stamp']));
  });

  it('drops an extension command when it is removed', () => {
    const { registry } = setup({ access: EDIT });
    const remove = registry.register(extension());
    remove();
    const ids = searchCommands(registry, 'bold', { translate }).hits.map((h) => h.id);
    expect(ids).not.toContain('ext.stamp');
  });
});

describe('synonyms (UX-011, criterion 2: the mechanism; the locale data is not built)', () => {
  it('lists a command under a synonym the host supplies, at the lowest rank', () => {
    const { registry } = setup({ access: EDIT });
    const synonyms = (view: { id: string }) => (view.id === 'format.italic' ? ['slant'] : []);
    expect(searchCommands(registry, 'slant', { translate }).hits).toEqual([]);
    const hits = searchCommands(registry, 'slant', { translate, synonyms }).hits;
    expect(hits.map((h) => h.id)).toEqual(['format.italic']);
    expect(hits[0]!.rank).toBe(3);
  });
});

describe('command search properties (UX-011)', () => {
  it('every hit contains every word of the query in its label or a synonym', () => {
    const { registry } = setup({ access: EDIT });
    const words = fc.array(fc.constantFrom('b', 'o', 'l', 'd', 'i', 't', 'a', 'c'), {
      minLength: 1,
      maxLength: 3,
    });
    fc.assert(
      fc.property(words, (parts) => {
        const query = parts.join('');
        const results = searchCommands(registry, query, { translate });
        for (const hit of results.hits) {
          const label = normaliseQuery(hit.label);
          expect(label.includes(normaliseQuery(query))).toBe(true);
        }
        expect(results.emptyKey === 'search.none').toBe(results.hits.length === 0);
      }),
      { numRuns: 200 },
    );
  });

  it('a limit keeps the best hits only', () => {
    const { registry } = setup({ access: EDIT });
    const all = searchCommands(registry, 'e', { translate }).hits;
    const two = searchCommands(registry, 'e', { translate, limit: 2 }).hits;
    expect(two).toEqual(all.slice(0, 2));
  });
});

// The registry is used directly here to show that a bare registry (no shell commands) searches too.
describe('a registry of its own', () => {
  it('searches the commands registered on it', () => {
    const core = new FakeCore({ access: EDIT });
    const registry = new CommandRegistry({
      core,
      sources: [coreQuerySource(core)],
      scheduler: immediateScheduler(),
    });
    registry.register(extension({ id: 'ext.only', label: 'command.edit.undo' }));
    expect(searchCommands(registry, 'undo', { translate }).hits.map((h) => h.id)).toEqual([
      'ext.only',
    ]);
  });
});
