/**
 * The field palette through command search (FRW-072 criterion 5, the search part): the
 * `insert.field.<kind>` commands are found by their translated labels, a field the user may not
 * insert is listed with `runnable: false`, and a kind the release does not offer is not listed.
 * Keyboard operability of the palette is a browser run and is not claimed here.
 */
import { describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  immediateScheduler,
  searchCommands,
} from '../src/commands/index.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { sourceTranslator } from '../src/i18n/strings.ts';
import { EDIT, FakeCore, VIEW } from './support/fake-core.ts';

const translate = sourceTranslator();

function setup(options: ConstructorParameters<typeof FakeCore>[0] = {}) {
  // The backend announces `fields` (FRW-065 criterion 3), as every field command needs it.
  const core = new FakeCore({
    extended: true,
    ...options,
    features: ['fields', ...(options.features ?? [])],
  });
  const registry = createCommandRegistry(core, { scheduler: immediateScheduler() });
  return { core, registry };
}

function hitsFor(registry: ReturnType<typeof setup>['registry'], query: string) {
  return searchCommands(registry, query, { translate }).hits.filter((h) =>
    h.id.startsWith('insert.field.'),
  );
}

describe('command search finds the field palette by label (FRW-072, criterion 5)', () => {
  it('finds the date kinds by their translated labels, runnable where edit is allowed', () => {
    const { registry } = setup({ access: EDIT, features: ['sign'] });
    const hits = hitsFor(registry, 'date');
    expect(hits.map((h) => h.id).sort()).toEqual(['insert.field.date', 'insert.field.dateSigned']);
    for (const hit of hits) {
      expect(hit.runnable).toBe(true);
      expect(hit.label).toBe(EN_GB[`command.${hit.id}` as keyof typeof EN_GB]);
    }
  });

  it('lists a field the user may not insert with runnable false, so it cannot run from results', () => {
    const { registry } = setup({ access: VIEW });
    const hits = hitsFor(registry, 'field');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.runnable === false)).toBe(true);
  });

  it('does not list a kind the release does not offer (signature without the sign feature)', () => {
    const { registry } = setup({ access: EDIT });
    expect(hitsFor(registry, 'signature')).toEqual([]);
    // A date signed field is a signing kind too: without 'sign' it is not offered.
    expect(hitsFor(registry, 'date signed')).toEqual([]);
    const withSign = setup({ access: EDIT, features: ['sign'] }).registry;
    expect(hitsFor(withSign, 'signature').map((h) => h.id)).toEqual(['insert.field.signature']);
  });

  it('finds the checkbox kind, whose label has no word "field"', () => {
    const { registry } = setup({ access: EDIT });
    expect(hitsFor(registry, 'checkbox').map((h) => h.id)).toEqual(['insert.field.checkbox']);
  });
});
