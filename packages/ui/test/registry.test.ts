/**
 * The command registry (UX-003; 13 §4): registration, evaluation through the document API, one
 * publication per frame with the changed commands, live registration, labels as string keys, and
 * `exec` through the same path.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CommandRegistrationError,
  CommandRegistry,
  bindCommandStateEvent,
  builtinCommands,
  coreCommands,
  coreQuerySource,
  createCommandRegistry,
  frameScheduler,
  immediateScheduler,
  type CommandEntry,
} from '../src/commands/index.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { FakeCore, VIEW } from './support/fake-core.ts';

/** A frame clock driven by hand: microtasks run at once, frames when `nextFrame()` is called. */
function manualFrames() {
  const frames: Array<() => void> = [];
  const microtasks: Array<() => void> = [];
  return {
    scheduler: frameScheduler(
      (cb) => frames.push(cb),
      (cb) => microtasks.push(cb),
    ),
    runMicrotasks() {
      while (microtasks.length) microtasks.shift()!();
    },
    nextFrame() {
      const due = frames.splice(0);
      for (const cb of due) cb();
      while (microtasks.length) microtasks.shift()!();
    },
  };
}

function entry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: 'test.command',
    label: 'command.format.bold',
    group: 'format',
    changesContent: false,
    capability: 'editing',
    run: () => true,
    ...overrides,
  };
}

describe('registration (UX-003)', () => {
  it('accepts the shape of 13 §4 and gives every reader the same entry', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    const bold = registry.get('format.bold')!;
    expect(bold).toMatchObject({
      id: 'format.bold',
      label: 'command.format.bold',
      icon: 'bold',
      group: 'format',
      keys: ['Mod-b'],
      enabled: 'canEditSelection',
      active: 'isBold',
    });
    // The toolbar's snapshot, `state` (queryCommand) and `get` (exec) read one instance.
    const fromSnapshot = registry.view.get().commands.find((c) => c.id === 'format.bold')!;
    expect(fromSnapshot.entry).toBe(bold);
    expect(registry.get('bold')).toBe(bold);
  });

  it('refuses a duplicate identifier or alias, naming the entry, and overwrites nothing', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    const original = registry.get('format.bold');
    expect(() => registry.register(entry({ id: 'format.bold' }))).toThrow(CommandRegistrationError);
    expect(() => registry.register(entry({ id: 'format.bold' }))).toThrow(/"format\.bold"/);
    expect(() => registry.register(entry({ id: 'test.alias', aliases: ['bold'] }))).toThrow(
      /"test\.alias".*alias "bold"/,
    );
    expect(registry.get('format.bold')).toBe(original);
    expect(registry.get('test.alias')).toBeUndefined();
  });

  it('refuses an unknown query name, naming the entry and the query', () => {
    const registry = createCommandRegistry(new FakeCore(), { scheduler: immediateScheduler() });
    expect(() => registry.register(entry({ id: 'test.one', enabled: 'canFly' }))).toThrow(
      /command "test\.one": its enabled query "canFly" is not a known query/,
    );
    expect(() => registry.register(entry({ id: 'test.two', active: 'isFlying' }))).toThrow(
      /command "test\.two": its active query "isFlying"/,
    );
    expect(registry.get('test.one')).toBeUndefined();
  });

  it('refuses a label that is not a string key (labels are never literals)', () => {
    const registry = createCommandRegistry(new FakeCore(), { scheduler: immediateScheduler() });
    expect(() => registry.register(entry({ id: 'test.literal', label: 'Bold text' }))).toThrow(
      /label "Bold text" is not a string key/,
    );
  });

  it('refuses identifiers without an area and entries without a capability', () => {
    const registry = createCommandRegistry(new FakeCore(), { scheduler: immediateScheduler() });
    expect(() => registry.register(entry({ id: 'bold2' }))).toThrow(/form "area\.name"/);
    expect(() => registry.register(entry({ id: 'test.cap', capability: '' }))).toThrow(
      /no capability/,
    );
  });

  it('labels every built-in command with a key of the source table', () => {
    for (const e of builtinCommands()) expect(Object.hasOwn(EN_GB, e.label), e.id).toBe(true);
  });
});

describe('evaluation through the document API (UX-003, criterion 2)', () => {
  it('asks each named query once per change, however many commands name it', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    registry.register(entry({ id: 'test.alsoEdits', enabled: 'canEditSelection' }));
    void registry.view.get();
    core.queryCounts.clear();
    core.selection.set({ ...core.selection.get(), marks: ['bold'] });
    // format.bold, format.italic and test.alsoEdits all name canEditSelection: asked once.
    expect(core.queryCounts.get('canEditSelection')).toBe(1);
    expect(core.queryCounts.get('isBold')).toBe(1);
    expect(registry.view.get().commands.find((c) => c.id === 'format.bold')!.active).toBe(true);
  });

  it('never asks the core while a surface reads the published state', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    void registry.view.get();
    core.queryCounts.clear();
    for (let i = 0; i < 5; i++) void registry.view.get().commands.map((c) => c.enabled);
    expect([...core.queryCounts.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('answers from the views when the core has no query method (the spike core)', () => {
    const core = new FakeCore({ minimal: true });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    core.selection.set({ ...core.selection.get(), marks: ['italic'] });
    const italic = registry.state('format.italic');
    expect(italic).toMatchObject({ enabled: true, active: true });
    // Unanswered queries leave the command enabled; running it reports no-effect.
    expect(registry.state('edit.undo').enabled).toBe(true);
    expect(registry.exec('edit.undo')).toEqual({ ran: false, reason: 'no-effect' });
  });

  it('uses the names the core declares', () => {
    const core = new FakeCore();
    Object.assign(core, { queryNames: ['canEditSelection', 'isBold'] });
    const source = coreQuerySource(core);
    expect(source.names).toEqual(['canEditSelection', 'isBold']);
  });
});

describe('one publication per frame (UX-003, criterion 4)', () => {
  it('publishes several changes within a frame once, listing only the changed commands', () => {
    const clock = manualFrames();
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: clock.scheduler });
    clock.runMicrotasks();
    clock.nextFrame();
    const published = vi.fn();
    const changes: string[][] = [];
    registry.view.subscribe(published);
    registry.onStateChange((ids) => changes.push([...ids]));

    // Three changes in one task: the selection gains bold and italic, the access stays the same.
    core.selection.set({ ...core.selection.get(), marks: ['bold'] });
    core.selection.set({ ...core.selection.get(), marks: ['bold', 'italic'] });
    core.access!.set({ ...core.access!.get() });
    clock.runMicrotasks();

    expect(published).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([['format.bold', 'format.italic']]);
  });

  it('defers a second change in the same frame to the next frame', () => {
    const clock = manualFrames();
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: clock.scheduler });
    clock.runMicrotasks();
    clock.nextFrame();
    const changes: string[][] = [];
    registry.onStateChange((ids) => changes.push([...ids]));

    core.selection.set({ ...core.selection.get(), marks: ['bold'] });
    clock.runMicrotasks();
    core.access!.set(VIEW);
    clock.runMicrotasks();
    expect(changes).toHaveLength(1);
    clock.nextFrame();
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual(
      expect.arrayContaining(['format.bold', 'format.italic', 'edit.undo', 'insert.footnote']),
    );
    expect(changes[1]).not.toContain('edit.selectAll');
  });

  it('publishes nothing when nothing changed', () => {
    const clock = manualFrames();
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: clock.scheduler });
    clock.runMicrotasks();
    clock.nextFrame();
    const published = vi.fn();
    registry.view.subscribe(published);
    core.selection.set({ ...core.selection.get(), style: 'Heading 1' });
    clock.runMicrotasks();
    expect(published).not.toHaveBeenCalled();
  });

  it('raises de-command-state as a composed, bubbling event with the changed identifiers', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    void registry.view.get();
    const target = new EventTarget();
    const seen: CustomEvent[] = [];
    target.addEventListener('de-command-state', (e) => seen.push(e as CustomEvent));
    const stop = bindCommandStateEvent(registry, target);
    core.selection.set({ ...core.selection.get(), marks: ['bold'] });
    stop();
    core.selection.set({ ...core.selection.get(), marks: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bubbles).toBe(true);
    expect(seen[0]!.composed).toBe(true);
    expect(seen[0]!.detail).toEqual({ commands: ['format.bold'] });
  });
});

describe('live registration (UX-003, criterion 5)', () => {
  it('shows a command registered after start-up and drops one that is removed', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    const ids = () => registry.view.get().commands.map((c) => c.id);
    expect(ids()).not.toContain('ext.sample');
    const remove = registry.register(entry({ id: 'ext.sample' }));
    expect(ids()).toContain('ext.sample');
    remove();
    expect(ids()).not.toContain('ext.sample');
    expect(registry.exec('ext.sample')).toEqual({ ran: false, reason: 'unknown' });
  });
});

describe('exec (05 §8.1)', () => {
  it('runs an enabled command through the core and reports it', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.exec('format.bold')).toEqual({ ran: true, reason: null });
    expect(core.callsOf('run').map((c) => c.args[0])).toEqual(['bold']);
    // The spike's names still work.
    expect(registry.exec('italic')).toEqual({ ran: true, reason: null });
  });

  it('runs nothing for an unknown command and says so', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.exec('format.sparkle')).toEqual({ ran: false, reason: 'unknown' });
    expect(registry.state('format.sparkle')).toMatchObject({ offered: false, reason: 'unknown' });
    expect(core.calls).toHaveLength(0);
  });

  it('reports a command whose query says no as not applicable', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.exec('edit.undo')).toEqual({ ran: false, reason: 'not-applicable' });
    expect(core.callsOf('run')).toHaveLength(0);
  });

  it('keeps going when a command throws, and reports it', () => {
    const core = new FakeCore();
    const errors: unknown[] = [];
    const registry = new CommandRegistry({
      core,
      sources: [coreQuerySource(core)],
      scheduler: immediateScheduler(),
      onError: (_id, e) => errors.push(e),
    });
    registry.register(
      entry({
        id: 'ext.broken',
        run: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(registry.exec('ext.broken')).toEqual({ ran: false, reason: 'no-effect' });
    expect(errors).toHaveLength(1);
  });

  it('hides a command whose backend feature is not announced', () => {
    const core = new FakeCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    registry.register(entry({ id: 'view.thing', feature: 'comments' }));
    expect(registry.state('view.thing')).toMatchObject({ offered: false, reason: 'unannounced' });
    expect(registry.exec('view.thing').ran).toBe(false);
    core.features!.set(['comments']);
    expect(registry.state('view.thing')).toMatchObject({ offered: true, enabled: true });
  });
});

describe('the built-in commands of phase 1a', () => {
  it('are the spike commands under registry identifiers', () => {
    const phase1a = coreCommands().filter((c) => c.aliases !== undefined);
    expect(phase1a.map((c) => [c.id, c.aliases?.[0]])).toEqual([
      ['edit.undo', 'undo'],
      ['edit.redo', 'redo'],
      ['edit.selectAll', 'selectAll'],
      ['format.bold', 'bold'],
      ['format.italic', 'italic'],
      ['insert.footnote', 'insertFootnote'],
      ['page.header', 'editHeader'],
    ]);
  });
});
