/**
 * FRW-065 criterion 3: when the backend does not announce the `fields` or `workflow` port, the
 * component shows no field authoring or workflow control that needs it. The commands carry the
 * feature of the port they need (`feature`, and `also` for a second one: a signature field needs
 * `fields` and `sign`, the rules pane `fields` and `rules`), and the panes of the fields, the rules,
 * the roles and the fill summary carry theirs. A positive control gives the same controls back when
 * the feature is announced, so the negative answer is not the result of a broken table.
 */
import { describe, expect, it } from 'vitest';
import {
  builtinCommands,
  createCommandRegistry,
  immediateScheduler,
  SHELL_QUERY_NAMES,
  ShellQueries,
} from '../src/commands/index.ts';
import { BUILT_IN_PANES, PaneRegistry } from '../src/shell/panes.ts';
import type { CoreApi } from '../src/core-api.ts';
import { FakeCore } from './support/fake-core.ts';

const FIELD_COMMANDS = [
  'insert.field.text',
  'insert.field.number',
  'insert.field.date',
  'insert.field.checkbox',
  'insert.field.choice',
  'insert.field.signature',
  'insert.field.initials',
  'insert.field.dateSigned',
  'insert.field.formula',
  'view.fieldProperties',
  'view.rules',
  'view.roles',
  'view.fillSummary',
];
const WORKFLOW_COMMANDS = ['workflow.send'];

function setup(features: readonly string[]) {
  const core = new FakeCore({ features, extended: true });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  registry.addSource(new ShellQueries(SHELL_QUERY_NAMES));
  // The shell registers its own commands; here the built-in entries it would register are added
  // without their queries, as the feature gate is checked before any query.
  for (const entry of builtinCommands()) {
    if (registry.state(entry.id).reason !== 'unknown') continue;
    const { enabled: _enabled, active: _active, ...withoutQueries } = entry;
    registry.register(withoutQueries);
  }
  return registry;
}

describe('FRW-065 criterion 3: no field or workflow control without the port', () => {
  it('carries the feature of the port on every field and workflow command', () => {
    const byId = new Map(builtinCommands().map((c) => [c.id, c]));
    for (const id of [...FIELD_COMMANDS, ...WORKFLOW_COMMANDS]) {
      const entry = byId.get(id);
      expect(entry, id).toBeDefined();
    }
    for (const id of FIELD_COMMANDS) expect(byId.get(id)?.feature, id).toBe('fields');
    for (const id of WORKFLOW_COMMANDS) expect(byId.get(id)?.feature, id).toBe('workflow');
    expect(byId.get('insert.field.signature')?.also).toEqual(['sign']);
    expect(byId.get('insert.field.formula')?.also).toEqual(['rules']);
    expect(byId.get('view.rules')?.also).toEqual(['rules']);
  });

  it('offers none of them to a backend that announces neither port, whatever else it announces', () => {
    const registry = setup(['presence', 'comments', 'history', 'sign', 'rules', 'exports']);
    for (const id of [...FIELD_COMMANDS, ...WORKFLOW_COMMANDS]) {
      expect(registry.state(id), id).toMatchObject({
        offered: false,
        enabled: false,
        reason: 'unannounced',
      });
      expect(registry.exec(id).ran, id).toBe(false);
    }
  });

  it('offers the field controls with `fields` and the workflow control with `workflow`, each alone', () => {
    const fieldsOnly = setup(['fields']);
    for (const id of FIELD_COMMANDS) {
      const wants = ['insert.field.signature', 'insert.field.initials'].includes(id)
        ? ['sign']
        : id === 'insert.field.dateSigned'
          ? ['sign']
          : id === 'insert.field.formula' || id === 'view.rules'
            ? ['rules']
            : [];
      expect(fieldsOnly.state(id).offered, id).toBe(wants.length === 0);
    }
    expect(fieldsOnly.state('workflow.send').offered).toBe(false);
    const everything = setup(['fields', 'sign', 'rules', 'workflow']);
    for (const id of [...FIELD_COMMANDS, ...WORKFLOW_COMMANDS])
      expect(everything.state(id).offered, id).toBe(true);
    const workflowOnly = setup(['workflow']);
    expect(workflowOnly.state('workflow.send').offered).toBe(true);
    for (const id of FIELD_COMMANDS) expect(workflowOnly.state(id).offered, id).toBe(false);
  });

  it('offers the panes of the fields, the rules, the roles and the fill summary only with their feature', () => {
    const panes = new PaneRegistry(BUILT_IN_PANES);
    // A core that has the data of every pane: only the feature decides.
    const core = {
      fieldProperties: {},
      rules: {},
      roles: {},
      fill: {},
      access: { get: () => ({ caps: [] }) },
    } as unknown as CoreApi;
    for (const [pane, feature] of [
      ['fields', 'fields'],
      ['rules', 'rules'],
      ['roles', 'fields'],
      ['fill', 'fields'],
    ] as const) {
      expect(panes.offered(pane, core, []), pane).toBe(false);
      expect(panes.offered(pane, core, ['presence', 'workflow']), pane).toBe(false);
      expect(panes.offered(pane, core, [feature]), pane).toBe(true);
    }
  });
});
