/**
 * The field palette as users and hosts have it (FRW-072 criteria 2, 3, 4 and 6): the
 * `insert.field.<kind>` commands of `commands/builtin.ts`, registered by `createCommandRegistry`
 * and evaluated by the registry with the field source of `commands/queries.ts`. Every test reads
 * the registry's states and runs `exec`, the same path as the toolbar, the menus, command search
 * and the element's `exec()` and `queryCommand()`.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FIELD_KINDS,
  createCommandRegistry,
  immediateScheduler,
  type CommandRegistry,
} from '../src/commands/index.ts';
import type { AccessSummary, Capability } from '../src/core-api.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { EDIT, FakeCore } from './support/fake-core.ts';

const PHASE_1B = ['text', 'number', 'date', 'checkbox', 'choice'];
const SIGNING = ['signature', 'initials', 'dateSigned'];
const ALL = FIELD_KINDS.map((k) => `insert.field.${k.kind}`);

/** The backend announces `fields` unless `announceFields` is false (FRW-065 criterion 3). */
function setup(
  features: readonly string[] = [],
  announceFields = true,
): { core: FakeCore; registry: CommandRegistry } {
  const core = new FakeCore({
    extended: true,
    features: announceFields ? ['fields', ...features] : features,
  });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  return { core, registry };
}

/** The palette: the insert-field commands the registry offers, in the registry's order. */
function palette(registry: CommandRegistry): string[] {
  return registry.view
    .get()
    .commands.filter((c) => c.id.startsWith('insert.field.') && c.offered)
    .map((c) => c.id.slice('insert.field.'.length));
}

/** A core that would put a field anywhere: the shell's own rules are all that stop it. */
function permissiveCore(features: readonly string[] = []): FakeCore {
  const core = new FakeCore({ extended: true, features: ['fields', ...features] });
  const query = core.query.bind(core);
  Object.assign(core, {
    query: (name: string) => (name === 'canInsertField' ? true : query(name)),
    queryReason: () => null,
  });
  return core;
}

function insertedKinds(core: FakeCore): unknown[] {
  return core
    .callsOf('runNamed')
    .filter((c) => c.args[0] === 'insertField')
    .map((c) => (c.args[1] as { kind: string }).kind);
}

describe('the palette lists exactly the kinds of the release (FRW-072, criterion 2)', () => {
  it('offers the five kinds of phase 1b, in the order of the spec, with no feature announced', () => {
    const { registry } = setup();
    expect(palette(registry)).toEqual(PHASE_1B);
    // The other kinds are registered but not offered, with the reason that says so.
    for (const kind of [...SIGNING, 'formula'])
      expect(registry.state(`insert.field.${kind}`)).toMatchObject({
        offered: false,
        enabled: false,
        reasonKey: 'reason.unannounced',
      });
  });

  it('adds the signing kinds with `sign` and the formula with `rules`, and nothing else (property)', () => {
    fc.assert(
      fc.property(fc.subarray(['sign', 'rules', 'comments', 'history'] as const), (features) => {
        const { registry } = setup(features);
        const expected = [
          ...PHASE_1B,
          ...(features.includes('sign') ? SIGNING : []),
          ...(features.includes('rules') ? ['formula'] : []),
        ];
        const offered = palette(registry);
        expect(offered).toHaveLength(expected.length);
        expect(new Set(offered)).toEqual(new Set(expected));
        registry.destroy();
      }),
    );
  });

  it('follows the announced features when they change, without a new registry', () => {
    const { core, registry } = setup();
    core.features?.set(['fields', 'sign', 'rules']);
    expect(palette(registry)).toHaveLength(9);
    core.features?.set(['fields']);
    expect(palette(registry)).toEqual(PHASE_1B);
    core.features?.set(['sign', 'rules']);
    expect(palette(registry)).toEqual([]);
  });

  it('offers no field command when `fields` is not announced, whatever else is (FRW-065 criterion 3)', () => {
    const { registry } = setup(['sign', 'rules', 'workflow', 'comments'], false);
    expect(palette(registry)).toEqual([]);
    for (const id of ALL)
      expect(registry.state(id), id).toMatchObject({
        offered: false,
        enabled: false,
        reasonKey: 'reason.unannounced',
      });
    // A signing kind needs `sign` as well, and the formula `rules`.
    expect(palette(setup(['rules']).registry)).toEqual([...PHASE_1B, 'formula']);
  });

  it('inserts the kind chosen, through the core’s named command', () => {
    const { core, registry } = setup(['sign']);
    expect(registry.exec('insert.field.date')).toEqual({ ran: true, reason: null });
    expect(registry.exec('insert.field.signature')).toEqual({ ran: true, reason: null });
    // Not offered without `rules`: nothing runs.
    expect(registry.exec('insert.field.formula')).toEqual({ ran: false, reason: 'unannounced' });
    expect(insertedKinds(core)).toEqual(['date', 'signature']);
  });

  it('names each kind with an external string', () => {
    const { registry } = setup(['sign', 'rules']);
    for (const id of ALL) {
      const label = registry.get(id)?.label;
      expect(label).toBe(`command.${id}`);
      expect(EN_GB[label as keyof typeof EN_GB]).toBeDefined();
    }
  });

  it('is absent when the core cannot insert fields', () => {
    const core = new FakeCore({ extended: true, features: ['fields', 'sign', 'rules'] });
    Object.assign(core, {
      queryNames: core.queryNames?.filter((n) => n !== 'canInsertField'),
      commandNames: core.commandNames?.filter((n) => n !== 'insertField'),
    });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.list().filter((e) => e.id.startsWith('insert.field.'))).toEqual([]);
  });
});

describe('no field in a header, footer or footnote (FRW-072, criterion 3)', () => {
  const places: Array<[string, (core: FakeCore) => void]> = [
    [
      'the footnote sub-editor',
      (core) => core.panel.set({ kind: 'footnote', id: 'fn1', label: '' }),
    ],
    [
      'the header or footer sub-editor',
      (core) => core.panel.set({ kind: 'story', id: 'h1', label: '' }),
    ],
    ['a header or footer scope', (core) => core.access?.set({ ...EDIT, scope: 'story:hdr1' })],
    [
      'a selection in a header or footer',
      (core) => core.selection.set({ ...core.selection.get(), contexts: ['story'] }),
    ],
  ];

  for (const [where, enter] of places)
    it(`makes every insert command unavailable in ${where}, whatever the core answers`, () => {
      const core = permissiveCore(['sign', 'rules']);
      const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
      for (const id of ALL) expect(registry.state(id).enabled).toBe(true);
      enter(core);
      for (const id of ALL) {
        expect(registry.state(id)).toMatchObject({
          offered: true,
          enabled: false,
          reasonKey: 'reason.query.subeditor',
        });
        expect(registry.exec(id)).toEqual({ ran: false, reason: 'not-applicable' });
      }
      // The published view, which the toolbar and the palette read, says the same.
      const shown = registry.view.get().commands.filter((c) => c.id.startsWith('insert.field.'));
      expect(shown.every((c) => !c.enabled && c.reasonKey === 'reason.query.subeditor')).toBe(true);
      expect(insertedKinds(core)).toEqual([]);
    });

  it('offers the commands again when the caret is back in the body', () => {
    const core = permissiveCore();
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    core.panel.set({ kind: 'footnote', id: 'fn1', label: '' });
    expect(registry.state('insert.field.text').enabled).toBe(false);
    core.panel.set(null);
    expect(registry.state('insert.field.text')).toMatchObject({ enabled: true, reasonKey: null });
    expect(registry.exec('insert.field.text').ran).toBe(true);
  });

  it('states the reason in words', () => {
    expect(EN_GB['reason.query.subeditor']).toBe(
      'Fields cannot be inserted in headers, footers or footnotes.',
    );
  });
});

describe('at the field limit (FRW-072, criterion 4)', () => {
  it('disables every insert command with the stated reason once the document holds 2,000 fields', () => {
    const { core, registry } = setup(['sign', 'rules']);
    core.fields = 1999;
    core.revision.set(core.revision.get() + 1);
    for (const id of ALL) expect(registry.state(id).enabled).toBe(true);
    // The 2,000th field may still be inserted; after it, none.
    expect(registry.exec('insert.field.text').ran).toBe(true);
    expect(core.fields).toBe(2000);
    for (const id of ALL) {
      expect(registry.state(id)).toMatchObject({
        offered: true,
        enabled: false,
        reasonKey: 'reason.query.fieldLimit',
      });
      expect(registry.exec(id).ran).toBe(false);
    }
    expect(core.fields).toBe(2000);
    expect(EN_GB['reason.query.fieldLimit']).toBeDefined();
  });

  it('says why when the document does not use forms and the service offers none, not "Not available here" (UX-107 criterion 4)', () => {
    const { core, registry } = setup([]);
    core.noForms = true;
    core.revision.set(core.revision.get() + 1);
    expect(registry.state('insert.field.text')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.noForms',
    });
    expect(EN_GB['reason.query.noForms']).toMatch(/does not offer forms/);
    expect(EN_GB['reason.query.noForms']).not.toBe(EN_GB['reason.notApplicable']);
    // A service that does not announce `fields` does not offer the commands at all, and says so.
    const plain = setup([], false);
    expect(plain.registry.state('insert.field.text')).toMatchObject({
      offered: false,
      reasonKey: 'reason.unannounced',
    });
    const viewer = setup([]);
    viewer.core.access?.set({ ...EDIT, caps: ['view'] });
    expect(viewer.registry.state('insert.field.text')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.access.view',
    });
  });

  it('states the limit in the same words when the core calls its reason `limit`', () => {
    const core = new FakeCore({ extended: true, features: ['fields'] });
    Object.assign(core, {
      query: (name: string) => (name === 'canInsertField' ? false : undefined),
      queryReason: (name: string) => (name === 'canInsertField' ? 'limit' : null),
    });
    const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
    expect(registry.state('insert.field.number')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.fieldLimit',
    });
  });
});

describe('without `edit` (FRW-072, criterion 6)', () => {
  const access = (
    caps: readonly Capability[],
    limit: AccessSummary['limit'] = null,
  ): AccessSummary => ({
    scope: 'body',
    caps,
    limit,
  });

  it('disables the palette with the reason the access gives', () => {
    const { core, registry } = setup();
    const cases: Array<[AccessSummary, string]> = [
      [access(['view'], 'role'), 'reason.access.view'],
      [access(['view', 'comment'], 'role'), 'reason.access.comment'],
      [access(['view'], 'locked'), 'reason.access.locked'],
      [access(['view', 'suggest']), 'reason.query.noEdit'],
    ];
    for (const [here, reasonKey] of cases) {
      core.access?.set(here);
      for (const kind of PHASE_1B)
        expect(registry.state(`insert.field.${kind}`)).toMatchObject({
          offered: true,
          enabled: false,
          reasonKey,
        });
      expect(registry.exec('insert.field.text').ran).toBe(false);
    }
    expect(insertedKinds(core)).toEqual([]);
  });

  it('enables the palette exactly when the access holds `edit` (property)', () => {
    const { core, registry } = setup();
    fc.assert(
      fc.property(fc.subarray(['view', 'comment', 'suggest', 'edit', 'fill'] as const), (caps) => {
        core.access?.set(access(caps, caps.includes('edit') ? null : 'role'));
        const state = registry.state('insert.field.choice');
        expect(state.enabled).toBe(caps.includes('edit'));
        if (!state.enabled) expect(EN_GB[state.reasonKey as keyof typeof EN_GB]).toBeDefined();
      }),
    );
  });

  it('is disabled in the viewing and filling modes', () => {
    const { core, registry } = setup();
    core.mode?.set('fill');
    expect(registry.state('insert.field.text')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.mode.fill',
    });
    core.mode?.set('view');
    expect(registry.state('insert.field.text')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.mode.view',
    });
  });
});
