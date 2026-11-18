/**
 * FRW-070: `de-field-change` and `de-fill-progress` (12 §10). The reporter is checked on plain
 * views, then on the real editing core with a document of form fields and the access of a
 * participant who may only fill. The browser run, with the element, the shell's guided bar and the
 * mock backend, is e2e/frw-070-fill-events.spec.ts.
 */
import { DocumentCore } from '@docedit/engine/headless';
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, type FieldChangeDetail, type FillProgressDetail } from '../src/events.ts';
import { FillEvents, type FillWatch, fillView, progressDetail } from '../src/fill.ts';
import { Value, contractDocument } from './support.ts';

type J = Record<string, unknown>;

const IDS = {
  amount: 'fAmount000000001',
  name: 'fName00000000001',
  email: 'fEmail0000000001',
  landlord: 'fLandlord0000001',
};

function fieldsDocument(): ReturnType<typeof contractDocument> {
  const envelope = contractDocument() as unknown as {
    requires: string[];
    doc: { content: Array<{ type: string; content: J[] }> };
  };
  envelope.requires = [...new Set([...envelope.requires, 'fields'])];
  const defs = envelope.doc.content.find((n) => n.type === 'defs')!;
  const body = envelope.doc.content.find((n) => n.type === 'body')!;
  defs.content.push(
    { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
    { type: 'role_def', attrs: { id: 'role_landlord', name: 'Landlord', color: '#FF7F0E' } },
  );
  const field = (id: string, key: string, kind: string, assignee: string, extra: J): J => ({
    type: 'form_field',
    attrs: { id, key, kind, assignee, value: null, ...extra },
  });
  body.content.push({
    type: 'paragraph',
    attrs: { id: 'pFields000000001', style: 'Normal' },
    content: [
      field(IDS.amount, 'tenant.amount', 'number', 'role_tenant', {
        label: 'Amount',
        validation: { min: '0', max: '1000' },
      }),
      field(IDS.name, 'tenant.name', 'text', 'role_tenant', { label: 'Name', required: true }),
      field(IDS.email, 'tenant.email', 'text', 'role_tenant', {
        label: 'E-mail',
        required: true,
        validation: { preset: 'email' },
      }),
      field(IDS.landlord, 'landlord.name', 'text', 'role_landlord', {
        label: 'Landlord',
        required: true,
      }),
    ],
  });
  return envelope as unknown as ReturnType<typeof contractDocument>;
}

/** A participant who may only fill, holding `roles` (12 §4.1). */
function participant(roles: readonly string[], active = true): Access {
  return {
    rev: 2,
    asOfSeq: 0,
    docRole: 'filler',
    caps: ['view', 'fill'],
    scopes: { doc: ['view'], body: ['view', 'fill'], defs: ['view'] },
    leases: {},
    fill: { participant: 'participant-1', roles: [...roles], active },
    restrictions: [],
  } as unknown as Access;
}

function fillCore(roles: readonly string[] = ['role_tenant'], active = true): DocumentCore {
  const core = new DocumentCore({
    doc: fieldsDocument(),
    schedule: (run) => queueMicrotask(run),
    mode: 'fill',
  });
  core.setAccess(participant(roles, active));
  return core;
}

function record(watch: FillWatch) {
  const changes: FieldChangeDetail[] = [];
  const progress: FillProgressDetail[] = [];
  const events = new FillEvents(watch, {
    fieldChange: (d) => changes.push(d),
    fillProgress: (d) => progress.push(d),
  });
  return { changes, progress, stop: events.start() };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('the reporter of fill events (FRW-070)', () => {
  it('names the two events with the de- prefix', () => {
    expect(EVENT_NAMES).toContain('de-field-change');
    expect(EVENT_NAMES).toContain('de-fill-progress');
  });

  it('raises a field change with four members and leaves anything else behind', () => {
    let listener: ((change: FieldChangeDetail) => void) | null = null;
    const r = record({
      onFieldChange(l) {
        listener = l;
        return () => {
          listener = null;
        };
      },
      fill: new Value(null),
    });
    // A source that wrongly hands over a value: the detail is built from the four members only.
    const leaky = { fieldId: 'f1', key: 'k', valid: true, empty: false, value: 'SECRET-4711' };
    listener!(leaky as FieldChangeDetail);
    expect(r.changes).toEqual([{ fieldId: 'f1', key: 'k', valid: true, empty: false }]);
    expect(JSON.stringify(r.changes)).not.toContain('SECRET-4711');
    r.stop();
    expect(listener).toBeNull();
  });

  it('raises the progress the bar shows first, then only when the count changes', () => {
    const field = (id: string, filled: boolean) => ({
      id,
      label: id,
      required: true,
      filled,
      invalid: null,
    });
    const fill = new Value<Parameters<typeof progressDetail>[0]>(null);
    const r = record({ onFieldChange: () => () => {}, fill });
    expect(r.progress).toEqual([]);
    fill.set({ active: true, fields: [field('a', false), field('b', false)] });
    expect(r.progress).toEqual([{ filled: 0, total: 2 }]);
    // The same count again (a label changed, say) raises nothing.
    fill.set({ active: true, fields: [field('a', false), field('b', false)] });
    expect(r.progress).toHaveLength(1);
    fill.set({ active: true, fields: [field('a', true), field('b', false)] });
    expect(r.progress.at(-1)).toEqual({ filled: 1, total: 2 });
    // A participant who may not fill yet sees no count in the bar, so none is raised.
    fill.set({ active: false, fields: [field('a', true), field('b', true)] });
    expect(r.progress).toHaveLength(2);
    r.stop();
    fill.set({ active: true, fields: [field('a', true), field('b', true)] });
    expect(r.progress).toHaveLength(2);
  });
});

describe('fill events over the real core (FRW-070)', () => {
  it('gives the shell no summary outside the fill mode', () => {
    const core = new DocumentCore({ doc: fieldsDocument(), schedule: (r) => queueMicrotask(r) });
    expect(fillView(core).get()).toBeNull();
    core.destroy();
  });

  it('lists the fields without their values and counts only the participant’s own', async () => {
    const core = fillCore();
    const view = fillView(core);
    const summary = view.get()!;
    expect(summary.active).toBe(true);
    expect(summary.roles).toEqual(['role_tenant']);
    expect(summary.fields.map((f) => [f.id, f.assignee, f.required, f.filled])).toEqual([
      [IDS.amount, 'role_tenant', false, false],
      [IDS.name, 'role_tenant', true, false],
      [IDS.email, 'role_tenant', true, false],
      [IDS.landlord, 'role_landlord', true, false],
    ]);
    expect(summary.fields[0]!.role).toEqual({ name: 'Tenant', color: '#1F77B4', order: 0 });
    // The landlord's required field is not the tenant's to fill: two required fields, not three.
    expect(progressDetail(summary)).toEqual({ filled: 0, total: 2 });
    expect(core.enterFieldValue(IDS.name, 'Zebedee-Quux').ok).toBe(true);
    await tick();
    expect(JSON.stringify(view.get())).not.toContain('Zebedee-Quux');
    core.destroy();
  });

  it('raises de-field-change for each entry with the state and never the value', async () => {
    const core = fillCore();
    const r = record({ onFieldChange: (l) => core.onFieldChange(l), fill: fillView(core) });
    expect(r.progress).toEqual([{ filled: 0, total: 2 }]);

    core.enterFieldValue(IDS.name, 'Zebedee-Quux');
    expect(r.changes).toEqual([
      { fieldId: IDS.name, key: 'tenant.name', valid: true, empty: false },
    ]);
    // An entry with a problem: submitted, kept, and reported as not valid.
    core.enterFieldValue(IDS.email, 'not-an-address-7731');
    expect(r.changes.at(-1)).toEqual({
      fieldId: IDS.email,
      key: 'tenant.email',
      valid: false,
      empty: false,
    });
    core.enterFieldValue(IDS.email, 'quux-7731@example.org');
    expect(r.changes.at(-1)).toMatchObject({ fieldId: IDS.email, valid: true, empty: false });
    // A required field emptied again is empty and not valid; an optional one is empty and valid.
    core.enterFieldValue(IDS.name, null);
    expect(r.changes.at(-1)).toEqual({
      fieldId: IDS.name,
      key: 'tenant.name',
      valid: false,
      empty: true,
    });
    core.enterFieldValue(IDS.amount, '250');
    core.enterFieldValue(IDS.amount, null);
    expect(r.changes.at(-1)).toEqual({
      fieldId: IDS.amount,
      key: 'tenant.amount',
      valid: true,
      empty: true,
    });
    // The same entry again changes nothing and raises nothing.
    const before = r.changes.length;
    core.enterFieldValue(IDS.amount, null);
    expect(r.changes).toHaveLength(before);

    await tick();
    // Every detail, serialised: the keys are the four of 12 §10, and no entry is in it.
    const wire = JSON.stringify([r.changes, r.progress]);
    for (const entry of ['Zebedee-Quux', 'not-an-address-7731', 'quux-7731@example.org', '250'])
      expect(wire).not.toContain(entry);
    for (const change of r.changes)
      expect(Object.keys(change).sort()).toEqual(['empty', 'fieldId', 'key', 'valid']);
    r.stop();
    core.destroy();
  });

  it('raises de-fill-progress as the count of the bar moves', async () => {
    const core = fillCore();
    const r = record({ onFieldChange: (l) => core.onFieldChange(l), fill: fillView(core) });
    core.enterFieldValue(IDS.name, 'Ada');
    await tick();
    expect(r.progress.at(-1)).toEqual({ filled: 1, total: 2 });
    // An entry that is not valid does not count as filled.
    core.enterFieldValue(IDS.email, 'nope');
    await tick();
    expect(r.progress.at(-1)).toEqual({ filled: 1, total: 2 });
    core.enterFieldValue(IDS.email, 'ada@example.org');
    await tick();
    expect(r.progress.at(-1)).toEqual({ filled: 2, total: 2 });
    // An optional field does not move the count: nothing more is raised.
    const before = r.progress.length;
    core.enterFieldValue(IDS.amount, '12');
    await tick();
    expect(r.progress).toHaveLength(before);
    r.stop();
    core.destroy();
  });

  it('does not report an entry the guard refuses', () => {
    // A participant who holds the landlord's role may not fill the tenant's field (P7).
    const core = fillCore(['role_landlord']);
    const r = record({ onFieldChange: (l) => core.onFieldChange(l), fill: fillView(core) });
    expect(core.enterFieldValue(IDS.name, 'Mallory').ok).toBe(false);
    expect(r.changes).toEqual([]);
    r.stop();
    core.destroy();
  });
});
