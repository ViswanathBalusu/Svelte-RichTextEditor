/**
 * Access keys (UX-012; 13 §2, §4, §12): a key is one letter or digit, two commands on one level may
 * not share it (reported at registration), a level shows the keys of its visible commands, and a
 * pressed key runs nothing the permissions or the mode disallow. The activation gesture is not
 * chosen yet (story Notes), so no test here presses a real key chord.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  accessKeyClaim,
  accessKeysAt,
  CommandRegistrationError,
  createCommandRegistry,
  immediateScheduler,
  pressAccessKey,
  type CommandEntry,
} from '../src/commands/index.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

function entry(overrides: Partial<CommandEntry> = {}): CommandEntry {
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

function setup(access = EDIT) {
  const core = new FakeCore({ extended: true, access });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  return { core, registry };
}

describe('a shared access key on one level is reported at registration (UX-012, criterion 2)', () => {
  it('refuses the second command, names both, and leaves the first in place', () => {
    const { registry } = setup();
    registry.register(entry({ id: 'ext.first', accessKey: 'x' }));
    let thrown: unknown = null;
    try {
      registry.register(entry({ id: 'ext.second', accessKey: 'X' }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommandRegistrationError);
    expect((thrown as CommandRegistrationError).message).toContain('ext.second');
    expect((thrown as CommandRegistrationError).message).toContain('ext.first');
    expect(registry.get('ext.second')).toBeUndefined();
    expect(registry.get('ext.first')).toBeDefined();
  });

  it('allows the same key on two different levels', () => {
    const { registry } = setup();
    registry.register(entry({ id: 'ext.format', group: 'format', accessKey: 'x' }));
    expect(() =>
      registry.register(entry({ id: 'ext.insert', group: 'insert', accessKey: 'x' })),
    ).not.toThrow();
  });

  it('frees the key when its command is removed', () => {
    const { registry } = setup();
    const remove = registry.register(entry({ id: 'ext.first', accessKey: 'x' }));
    remove();
    expect(() => registry.register(entry({ id: 'ext.second', accessKey: 'x' }))).not.toThrow();
  });

  it('refuses a key that is not one letter or digit', () => {
    const { registry } = setup();
    expect(() => registry.register(entry({ id: 'ext.long', accessKey: 'xy' }))).toThrow(
      CommandRegistrationError,
    );
    expect(() => registry.register(entry({ id: 'ext.space', accessKey: ' ' }))).toThrow(
      CommandRegistrationError,
    );
  });

  it('keys with the same letter in either case are one claim', () => {
    const claim = accessKeyClaim('ext.a', entry({ accessKey: 'Q' }));
    expect(claim).toBe(accessKeyClaim('ext.b', entry({ accessKey: 'q' })));
    expect(accessKeyClaim('ext.c', entry())).toBeNull();
  });

  it('property: any two distinct commands on one level with one key conflict', () => {
    fc.assert(
      fc.property(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), (key) => {
        const { registry } = setup();
        registry.register(entry({ id: 'ext.one', accessKey: key }));
        expect(() =>
          registry.register(entry({ id: 'ext.two', accessKey: key.toUpperCase() })),
        ).toThrow(CommandRegistrationError);
      }),
      { numRuns: 62 },
    );
  });
});

describe('a level shows the keys of its visible commands (UX-012, criterion 1 in part)', () => {
  it('shows the keys of the commands on the level and leaves out commands off the toolbars', () => {
    const { registry } = setup();
    registry.register(entry({ id: 'ext.shown', accessKey: 'k' }));
    registry.register(entry({ id: 'ext.hidden', accessKey: 'h', toolbar: false }));
    registry.register(entry({ id: 'ext.other', group: 'insert', accessKey: 'n' }));
    const keys = accessKeysAt(registry, 'format');
    expect(keys.get('k')).toEqual({ id: 'ext.shown', enabled: true });
    expect(keys.has('h')).toBe(false);
    expect(keys.has('n')).toBe(false);
  });

  it('shows a disabled command with enabled false, so the user can see why it stops', () => {
    const { registry } = setup(VIEW);
    registry.register(entry({ id: 'ext.edit', accessKey: 'e', changesContent: true }));
    expect(accessKeysAt(registry, 'format').get('e')).toEqual({ id: 'ext.edit', enabled: false });
  });
});

describe('a pressed access key runs the command, or nothing (UX-012, criteria 1 and 5)', () => {
  it('runs the command the key names, in either case', () => {
    const { core, registry } = setup();
    const calls: string[] = [];
    registry.register(
      entry({
        id: 'ext.run',
        accessKey: 'r',
        run: () => {
          calls.push('ext.run');
          return true;
        },
      }),
    );
    expect(pressAccessKey(registry, 'format', 'R')).toEqual({
      ran: true,
      reason: null,
      id: 'ext.run',
      reasonKey: null,
    });
    expect(calls).toEqual(['ext.run']);
    expect(core.callsOf('run')).toHaveLength(0);
  });

  it('runs nothing for a disabled command, and returns the reason as a string key', () => {
    const { registry } = setup(VIEW);
    const calls: string[] = [];
    registry.register(
      entry({
        id: 'ext.edit',
        accessKey: 'e',
        changesContent: true,
        run: () => {
          calls.push('ext.edit');
          return true;
        },
      }),
    );
    const result = pressAccessKey(registry, 'format', 'e');
    expect(result).toEqual({
      ran: false,
      reason: 'no-access',
      id: 'ext.edit',
      reasonKey: 'reason.access.view',
    });
    expect(calls).toEqual([]);
  });

  it('runs nothing for a key no shown command has', () => {
    const { registry } = setup();
    expect(pressAccessKey(registry, 'format', 'q')).toEqual({
      ran: false,
      reason: 'unknown',
      id: null,
      reasonKey: 'reason.notApplicable',
    });
  });

  it('does not run a command that is hidden from the toolbars, even with a key', () => {
    const { registry } = setup();
    registry.register(entry({ id: 'ext.hidden', accessKey: 'h', toolbar: false }));
    expect(pressAccessKey(registry, 'format', 'h').ran).toBe(false);
  });
});
