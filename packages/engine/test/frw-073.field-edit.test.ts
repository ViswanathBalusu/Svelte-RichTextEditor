/**
 * FRW-073 in the editing core, in Node.js: the properties of a form field are read and changed
 * through the core (`fieldProperties`, `editField`, src/field-edit.ts). A change is one
 * transaction of attribute steps, undone in one step; an entry the document cannot hold is
 * refused and nothing changes; a user who may not edit the field's scope changes nothing. The
 * browser run with the properties pane is packages/element/e2e/frw-073-field-properties.spec.ts.
 */
import type { Access } from '@docedit/protocol';
import { validate } from '@docedit/model/validate';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIELD_PROPERTY_NAMES } from '../src/field-edit.ts';
import { DocumentCore } from '../src/headless.ts';
import { FIELD_IDS, fieldsDocument, participantAccess } from './frw-fields-fixture.ts';
import { loadParts } from '../src/parts.ts';

// The rules language and the authoring checks load on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['authoring', 'rules']));

const schedule = (run: () => void): void => queueMicrotask(run);
const core = (): DocumentCore => new DocumentCore({ doc: fieldsDocument(), schedule });
const props = (c: DocumentCore, id: string) => c.fieldProperties(id)!;

const commenter = {
  rev: 2,
  asOfSeq: 0,
  docRole: 'commenter',
  caps: ['view', 'comment'],
  scopes: { doc: ['view', 'comment'], body: ['view', 'comment'], defs: ['view'] },
  leases: {},
  fill: null,
  restrictions: [],
} as unknown as Access;

describe('the properties of a form field (FRW-073)', () => {
  it('reads the twelve authored properties, and neither the value nor sensitive', () => {
    const c = core();
    const p = props(c, FIELD_IDS.email);
    expect(Object.keys(p).sort()).toEqual([...FIELD_PROPERTY_NAMES].sort());
    expect(p).toMatchObject({
      key: 'tenant.email',
      kind: 'text',
      label: 'E-mail',
      assignee: 'role_tenant',
      required: true,
      readOnly: false,
      validation: { preset: 'email' },
    });
    expect(c.formFields().map((f) => [f.id, f.key, f.label])).toEqual([
      [FIELD_IDS.amount, 'tenant.amount', 'Amount'],
      [FIELD_IDS.name, 'tenant.name', 'Name'],
      [FIELD_IDS.email, 'tenant.email', 'E-mail'],
      [FIELD_IDS.landlord, 'landlord.name', 'Landlord'],
    ]);
    expect(c.fieldProperties('fNone00000000000')).toBeNull();
    c.destroy();
  });

  it('changes several properties in one transaction, and one undo takes them all back', () => {
    const c = core();
    const before = props(c, FIELD_IDS.name);
    const patch = {
      key: 'tenant.fullName',
      label: 'Full name',
      assignee: 'role_landlord',
      required: true,
      readOnly: true,
      default: 'N. N.',
      placeholder: 'As in your passport',
      format: { prefix: 'Mx ' },
      validation: { minLength: 2, maxLength: 40 },
      width: 2400,
    };
    expect(c.editField(FIELD_IDS.name, patch)).toEqual({ ok: true });
    expect(props(c, FIELD_IDS.name)).toMatchObject(patch);
    expect(validate(c.getContent()).violations).toEqual([]);
    expect(c.editField(FIELD_IDS.name, patch)).toEqual({ ok: false, reason: 'no-change' });
    expect(c.run('undo')).toBe(true);
    expect(props(c, FIELD_IDS.name)).toEqual(before);
    c.destroy();
  });

  it('changes the kind to a choice with options', () => {
    const c = core();
    const options = [
      { id: 'flat', label: 'Flat' },
      { id: 'house', label: 'House' },
    ];
    expect(c.editField(FIELD_IDS.landlord, { kind: 'choice', options })).toEqual({ ok: true });
    expect(props(c, FIELD_IDS.landlord)).toMatchObject({ kind: 'choice', options });
    expect(validate(c.getContent()).violations).toEqual([]);
    c.destroy();
  });

  it('refuses a duplicate key, an assignee that is no role and a value its grammar refuses', () => {
    const c = core();
    const before = JSON.stringify(c.getContent().doc);
    const codes = (patch: Parameters<DocumentCore['editField']>[1]): string[] => {
      const outcome = c.editField(FIELD_IDS.name, patch);
      if (outcome.ok || outcome.reason !== 'invalid') throw new Error('expected an invalid answer');
      return outcome.problems.map((p) => `${p.field}:${p.code}`);
    };
    expect(codes({ key: 'tenant.email' })).toEqual(['key:duplicate-key']);
    expect(codes({ assignee: 'role_nobody' })).toEqual(['assignee:not-a-role']);
    expect(codes({ key: 'two words' })).toContain('key:grammar');
    expect(codes({ label: '' })).toContain('label:grammar');
    expect(codes({ validation: { min: 'ten' } })).toContain('validation:grammar');
    expect(codes({ width: -5 })).toContain('width:grammar');
    // The value is filled, not authored, and `sensitive` is reserved: neither is a property.
    expect(codes({ value: 'x' } as never)).toEqual(['value:not-a-property']);
    expect(codes({ sensitive: true } as never)).toEqual(['sensitive:not-a-property']);
    expect(JSON.stringify(c.getContent().doc)).toBe(before);
    c.destroy();
  });

  it('clears a value of the old kind, and a value whose option is removed (proposed)', () => {
    const c = core();
    c.enterFieldValue(FIELD_IDS.name, 'Ada');
    expect(c.fieldEntry(FIELD_IDS.name)!.stored).toBe('Ada');
    expect(c.editField(FIELD_IDS.name, { kind: 'number' })).toEqual({ ok: true });
    expect(c.fieldEntry(FIELD_IDS.name)!.stored).toBeNull();

    const options = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    c.editField(FIELD_IDS.landlord, { kind: 'choice', options });
    c.enterFieldValue(FIELD_IDS.landlord, 'b');
    expect(c.fieldEntry(FIELD_IDS.landlord)!.stored).toBe('b');
    expect(c.editField(FIELD_IDS.landlord, { options: [options[0]!] })).toEqual({ ok: true });
    expect(c.fieldEntry(FIELD_IDS.landlord)!.stored).toBeNull();
    expect(validate(c.getContent()).violations).toEqual([]);
    c.destroy();
  });

  it('changes nothing for a user without edit where the field is', () => {
    for (const access of [participantAccess(['role_tenant']), commenter]) {
      const c = core();
      c.setAccess(access);
      const before = JSON.stringify(c.getContent().doc);
      expect(c.canEditField(FIELD_IDS.name)).toBe(false);
      expect(c.editField(FIELD_IDS.name, { label: 'Other' })).toEqual({
        ok: false,
        reason: 'read-only',
      });
      expect(c.editField(FIELD_IDS.name, { label: 'Other' }, true)).toEqual({
        ok: false,
        reason: 'read-only',
      });
      expect(JSON.stringify(c.getContent().doc)).toBe(before);
      // The properties are still readable.
      expect(props(c, FIELD_IDS.name).label).toBe('Name');
      c.destroy();
    }
  });

  it('follows the field whose control took focus, until the field is gone', () => {
    const c = core();
    expect(c.selectedField()).toBeNull();
    c.selectField(FIELD_IDS.email);
    expect(c.selectedField()).toBe(FIELD_IDS.email);
    c.selectField('fNone00000000000');
    expect(c.selectedField()).toBeNull();
    c.destroy();
  });
});
