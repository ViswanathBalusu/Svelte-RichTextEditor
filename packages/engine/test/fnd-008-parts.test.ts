/**
 * FND-008: the parts of the editing core that load on first use (`src/parts.ts`), in Node.js.
 * Each test file has its own module state, so the tests below run in this order: first with nothing
 * loaded, then after the load. What the shell reads at once (the lists of roles, sources, fields
 * and rules) works without a part; what changes the definitions or compiles rules says which part
 * it needs; and a document whose rules arrive after it opened has its states once the part is there.
 */
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { FieldRules } from '../src/field-rules.ts';
import { DocumentCore, PartNotLoadedError, loadParts, partsFor } from '../src/headless.ts';
import { Part } from '../src/parts.ts';
import { editingSchema } from '../src/schema.ts';
import { RULE_FIELD_IDS, ruleDocument } from './frw-023-fixture.ts';
import { FIELD_IDS, fieldsDocument } from './frw-fields-fixture.ts';

const schedule = (run: () => void): void => queueMicrotask(run);
const core = (doc = fieldsDocument()): DocumentCore => new DocumentCore({ doc, schedule });

describe('which parts a document needs (FND-008)', () => {
  it('needs none for a document without rules and without a workflow', () => {
    expect(partsFor({ doc: fieldsDocument().doc })).toEqual([]);
    expect(partsFor({ doc: undefined })).toEqual([]);
    expect(partsFor({ doc: { type: 'doc' } })).toEqual([]);
  });

  it('needs the rules part for a document that holds a rule', () => {
    expect(partsFor({ doc: ruleDocument().doc })).toEqual(['rules']);
  });

  it('needs the rules part for a host that has a workflow', () => {
    expect(partsFor({ doc: fieldsDocument().doc, workflow: true })).toEqual(['rules']);
    expect(partsFor({ doc: fieldsDocument().doc, workflow: false })).toEqual([]);
  });
});

describe('before a part is loaded', () => {
  it('reads what the shell reads at once without any part', () => {
    const c = core(ruleDocument());
    expect(c.roles().length).toBeGreaterThan(0);
    expect(c.formFields().length).toBeGreaterThan(0);
    expect(c.fieldProperties(FIELD_IDS.name)).not.toBeNull();
    expect(c.sources()).toEqual([]);
    expect(c.ruleDefs().length).toBeGreaterThan(0);
    expect(c.nextRoleId()).toMatch(/^role_\d+$/);
    expect(c.nextRuleId()).toMatch(/^rule_\d+$/);
    c.destroy();
  });

  it('says which part a change of the definitions needs, and changes nothing', () => {
    const c = core();
    const before = JSON.stringify(c.getContent().doc);
    const needs = (call: () => unknown, part: string): void => {
      try {
        call();
        throw new Error('the call did not throw');
      } catch (error) {
        expect(error).toBeInstanceOf(PartNotLoadedError);
        expect((error as PartNotLoadedError).part).toBe(part);
      }
    };
    needs(
      () => c.editRole({ op: 'add', id: 'role_9', values: { name: 'R', color: '#000000' } }),
      'authoring',
    );
    needs(() => c.editSource({ op: 'add', id: 'k1', values: {} }), 'authoring');
    needs(() => c.editField(FIELD_IDS.name, { label: 'Name' }), 'authoring');
    needs(() => c.editRule({ op: 'delete', id: 'r1' }), 'rules');
    needs(() => c.ruleItems(), 'rules');
    needs(() => c.sendChecklist([]), 'rules');
    needs(() => c.extensionApi({ maxRanges: 2 }), 'extension');
    expect(JSON.stringify(c.getContent().doc)).toBe(before);
    c.destroy();
  });

  it('has no rule state while the part is missing, then loads it and says so', async () => {
    const state = EditorState.create({ doc: editingSchema().nodeFromJSON(ruleDocument().doc) });
    let loaded = 0;
    let loadedOnce!: () => void;
    const arrived = new Promise<void>((resolve) => {
      loadedOnce = resolve;
    });
    const rules = new FieldRules({
      state: () => state,
      roles: () => ['role_tenant'],
      loaded: () => {
        loaded++;
        loadedOnce();
      },
    });
    // The part is not there: no state, and asking again does not ask for a second load.
    expect(rules.states().size).toBe(0);
    expect(rules.of(RULE_FIELD_IDS.name)).toBeNull();
    expect(rules.states().size).toBe(0);
    await arrived;
    expect(loaded).toBe(1);
    // Read again, as the views do after `loaded`: the rules now give their states.
    expect(rules.states().size).toBeGreaterThan(0);
    expect(rules.stats.evaluations).toBe(1);
  });
});

describe('a part that fails to load', () => {
  it('rejects, and is asked again by the next call', async () => {
    let calls = 0;
    const part = new Part<{ ok: true }>('rules', () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true });
    });
    await expect(part.load()).rejects.toThrow('offline');
    expect(part.peek()).toBeNull();
    expect(() => part.get()).toThrow(PartNotLoadedError);
    await expect(part.load()).resolves.toEqual({ ok: true });
    expect(part.get()).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe('after the parts are loaded', () => {
  it('lets the core change roles, sources, fields and rules', async () => {
    const c = core();
    await loadParts(['authoring', 'extension', 'rules']);
    expect(
      c.editRole({ op: 'add', id: c.nextRoleId(), values: { name: 'Witness', color: '#336699' } }),
    ).toEqual({ ok: true });
    expect(c.roles().map((r) => r.name)).toContain('Witness');
    expect(c.editField(FIELD_IDS.name, { label: 'Full name' })).toEqual({ ok: true });
    expect(c.fieldProperties(FIELD_IDS.name)?.label).toBe('Full name');
    expect(
      c.editSource({ op: 'add', id: 'smith2026', values: { kind: 'book', title: 'T' } }),
    ).toEqual({
      ok: true,
    });
    expect(c.sources().map((s) => s.id)).toEqual(['smith2026']);
    expect(c.ruleItems()).toEqual([]);
    expect(c.sendChecklist([])).toEqual(expect.any(Array));
    const api = c.extensionApi({ maxRanges: 2 });
    expect(typeof api.dispose).toBe('function');
    api.dispose();
    c.destroy();
  });

  it('is idempotent: loading again resolves at once', async () => {
    await loadParts(['authoring', 'rules']);
    await loadParts(['rules']);
  });
});
