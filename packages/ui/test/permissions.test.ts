/**
 * Commands follow the user's current access (UX-004; 13 §4; 07 §4, §7). The server stays the
 * authority; these tests cover "see before you try".
 */
import { describe, expect, it } from 'vitest';
import {
  accessChangeAnnouncement,
  createCommandRegistry,
  immediateScheduler,
  reasonKeyFor,
  type CommandEntry,
} from '../src/commands/index.ts';
import type { AccessSummary } from '../src/core-api.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const CONTENT = ['edit.undo', 'edit.redo', 'format.bold', 'format.italic', 'insert.footnote'];

function setup(access: AccessSummary) {
  const core = new FakeCore({ access });
  core.undoDepth = 1;
  core.redoDepth = 1;
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  return { core, registry };
}

describe('a user with only view (UX-004, criterion 1)', () => {
  it('has every content command disabled, with a reason, and queryCommand says so', () => {
    const { core, registry } = setup(VIEW);
    for (const id of CONTENT) {
      const state = registry.state(id);
      expect(state, id).toMatchObject({ enabled: false, reason: 'no-access' });
      expect(state.reasonKey, id).toBe('reason.access.view');
      expect(Object.hasOwn(EN_GB, state.reasonKey!)).toBe(true);
    }
    // Commands that change nothing stay available.
    expect(registry.state('edit.selectAll').enabled).toBe(true);
    expect(registry.state('page.header').enabled).toBe(true);
    // Nothing runs, and the caller is told why.
    expect(registry.exec('format.bold')).toEqual({ ran: false, reason: 'no-access' });
    expect(core.callsOf('run')).toHaveLength(0);
  });

  it('keeps the active state visible while disabled', () => {
    const { core, registry } = setup(VIEW);
    core.selection.set({ ...core.selection.get(), marks: ['bold'] });
    expect(registry.state('format.bold')).toMatchObject({ enabled: false, active: true });
  });
});

describe('reasons (07 §4, §7)', () => {
  it('names what limits the user', () => {
    const cases: Array<[AccessSummary, string]> = [
      [{ scope: 'body', caps: ['view'], limit: 'role' }, 'reason.access.view'],
      [{ scope: 'body', caps: ['view', 'comment'], limit: 'role' }, 'reason.access.comment'],
      [
        { scope: 'region:r1', caps: ['view', 'comment'], limit: 'approved' },
        'reason.access.approved',
      ],
      [{ scope: 'region:r1', caps: ['view', 'comment'], limit: 'lease' }, 'reason.access.lease'],
      [{ scope: 'body', caps: ['view', 'comment'], limit: 'locked' }, 'reason.access.locked'],
      [{ scope: 'body', caps: ['view'], limit: 'archived' }, 'reason.access.archived'],
      [{ scope: 'body', caps: ['view'], limit: 'workflow' }, 'reason.access.workflow'],
      [{ scope: 'region:r2', caps: ['view'], limit: 'unlisted' }, 'reason.access.unlisted'],
      [{ scope: 'region:r3', caps: ['view'], limit: 'region' }, 'reason.access.region'],
      [{ scope: 'region:r4', caps: [], limit: 'hidden' }, 'reason.access.hidden'],
    ];
    for (const [access, key] of cases) {
      expect(reasonKeyFor(access)).toBe(key);
      const { registry } = setup(access);
      expect(registry.state('format.bold')).toMatchObject({
        enabled: false,
        reasonKey: key,
        limit: access.limit,
      });
    }
  });
});

describe('moving the caret and permission changes (UX-004, criteria 2 and 3)', () => {
  it('updates states when the caret moves into a region the user may not edit', () => {
    const { core, registry } = setup(EDIT);
    expect(registry.view.get().commands.find((c) => c.id === 'format.bold')!.enabled).toBe(true);
    core.moveTo(
      { scope: 'region:r9', caps: ['view'], limit: 'region' },
      { scope: 'region', region: 'Terms' },
    );
    const bold = registry.view.get().commands.find((c) => c.id === 'format.bold')!;
    expect(bold).toMatchObject({ enabled: false, reasonKey: 'reason.access.region' });
  });

  it('updates states on a permission change and tells the shell to announce it', () => {
    const { core, registry } = setup(EDIT);
    const before = core.access!.get();
    core.access!.set({ scope: 'body', caps: ['view', 'comment'], limit: 'role' });
    expect(registry.state('format.bold').enabled).toBe(false);
    expect(accessChangeAnnouncement(before, core.access!.get())).toBe('announce.access.lost');
    expect(accessChangeAnnouncement(core.access!.get(), EDIT)).toBe('announce.access.gained');
  });

  it('does not announce a caret move into another scope', () => {
    expect(
      accessChangeAnnouncement(EDIT, { scope: 'region:r1', caps: ['view'], limit: 'region' }),
    ).toBe(null);
    expect(accessChangeAnnouncement(EDIT, EDIT)).toBe(null);
  });
});

describe('suggest without edit (UX-004, criterion 4)', () => {
  it('keeps formatting commands enabled; the core turns the edit into a suggestion', () => {
    const { core, registry } = setup({
      scope: 'body',
      caps: ['view', 'comment', 'suggest'],
      limit: 'role',
    });
    expect(registry.state('format.bold').enabled).toBe(true);
    expect(registry.exec('format.bold').ran).toBe(true);
    expect(core.callsOf('run').map((c) => c.args[0])).toEqual(['bold']);
  });
});

describe('commands registered at run time (UX-004, criteria 5 and 6)', () => {
  const extension: CommandEntry = {
    id: 'ext.stamp',
    label: 'command.format.bold',
    group: 'ext',
    enabled: 'canEditSelection',
    changesContent: true,
    capability: 'host-panels-and-commands',
    run: () => true,
  };

  it('follow the same rules as built-in commands', () => {
    const { core, registry } = setup(EDIT);
    registry.register(extension);
    expect(registry.state('ext.stamp').enabled).toBe(true);
    core.access!.set(VIEW);
    expect(registry.state('ext.stamp')).toMatchObject({
      enabled: false,
      reason: 'no-access',
      reasonKey: 'reason.access.view',
    });
  });

  it('cannot be run from another surface when the access does not allow it, and say why', () => {
    const { registry } = setup(VIEW);
    registry.register(extension);
    expect(registry.exec('ext.stamp')).toEqual({ ran: false, reason: 'no-access' });
  });
});
