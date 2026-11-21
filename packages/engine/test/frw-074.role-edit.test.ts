/**
 * FRW-074 criteria 1 and 5: the roles of a document are added, renamed, recoloured and deleted
 * through the core (`editRole`, src/role-edit.ts). A role fields are assigned to is not deleted,
 * and the answer lists those fields (I13). Without the right to change the definitions nothing
 * changes. The browser run with the roles manager is packages/element/e2e/frw-074-roles-manager.spec.ts.
 */
import type { Access } from '@docedit/protocol';
import { validate } from '@docedit/model/validate';
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { FIELD_IDS, fieldsDocument, participantAccess } from './frw-fields-fixture.ts';
import { loadParts } from '../src/parts.ts';

// The rules language and the authoring checks load on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['authoring', 'rules']));

const schedule = (run: () => void): void => queueMicrotask(run);
const core = (): DocumentCore => new DocumentCore({ doc: fieldsDocument(), schedule });

interface J {
  type: string;
  attrs?: Record<string, unknown>;
  content?: J[];
}
const roleDefs = (c: DocumentCore): Array<Record<string, unknown>> => {
  const doc = c.getContent().doc as unknown as J;
  const defs = doc.content!.find((n) => n.type === 'defs')!;
  return defs.content!.filter((n) => n.type === 'role_def').map((n) => n.attrs!);
};

/** Someone who may change the text of the body and nothing of the definitions. */
const bodyEditor = {
  rev: 2,
  asOfSeq: 0,
  docRole: 'commenter',
  caps: ['view', 'comment'],
  scopes: { doc: ['view'], body: ['view', 'edit'], defs: ['view'] },
  leases: {},
  fill: null,
  restrictions: [],
} as unknown as Access;

describe('the roles of a document (FRW-074)', () => {
  it('lists the roles in definition order with the fields assigned to each', () => {
    const c = core();
    expect(c.roles().map((r) => [r.id, r.name, r.color, r.order])).toEqual([
      ['role_tenant', 'Tenant', '#1F77B4', 0],
      ['role_landlord', 'Landlord', '#FF7F0E', 1],
    ]);
    expect(c.roles()[0]!.fields.map((f) => [f.id, f.label])).toEqual([
      [FIELD_IDS.amount, 'Amount'],
      [FIELD_IDS.name, 'Name'],
      [FIELD_IDS.email, 'E-mail'],
    ]);
    expect(c.roles()[1]!.fields.map((f) => f.id)).toEqual([FIELD_IDS.landlord]);
    c.destroy();
  });

  it('adds a role as a role_def after the other roles, and the document stays valid', () => {
    const c = core();
    const id = c.nextRoleId();
    expect(id).toBe('role_1');
    expect(c.editRole({ op: 'add', id, values: { name: 'Witness', color: '#2CA02C' } })).toEqual({
      ok: true,
    });
    expect(roleDefs(c).map((a) => [a['id'], a['name'], a['color']])).toEqual([
      ['role_tenant', 'Tenant', '#1F77B4'],
      ['role_landlord', 'Landlord', '#FF7F0E'],
      ['role_1', 'Witness', '#2CA02C'],
    ]);
    expect(c.nextRoleId()).toBe('role_2');
    expect(validate(c.getContent()).violations).toEqual([]);
    c.destroy();
  });

  it('renames and recolours a role, one attribute at a time', () => {
    const c = core();
    expect(c.editRole({ op: 'update', id: 'role_tenant', values: { name: 'Lessee' } }).ok).toBe(
      true,
    );
    expect(roleDefs(c)[0]).toMatchObject({ id: 'role_tenant', name: 'Lessee', color: '#1F77B4' });
    expect(c.editRole({ op: 'update', id: 'role_tenant', values: { color: '#AA00AA' } }).ok).toBe(
      true,
    );
    expect(roleDefs(c)[0]).toMatchObject({ id: 'role_tenant', name: 'Lessee', color: '#AA00AA' });
    // The fields still name the role by its identifier, which did not change.
    expect(c.roles()[0]!.fields).toHaveLength(3);
    expect(c.editRole({ op: 'update', id: 'role_tenant', values: { name: 'Lessee' } })).toEqual({
      ok: false,
      reason: 'no-change',
    });
    c.destroy();
  });

  it('refuses a value its grammar refuses, by attribute, and changes nothing', () => {
    const c = core();
    const before = JSON.stringify(c.getContent().doc);
    const bad = c.editRole({ op: 'add', id: 'role_1', values: { name: '', color: 'blue' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok && bad.reason === 'invalid')
      expect([...new Set(bad.problems.map((p) => p.field))].sort()).toEqual(['color', 'name']);
    else throw new Error('expected an invalid answer');
    expect(
      c.editRole({ op: 'add', id: 'role_tenant', values: { name: 'Again', color: '#000000' } }),
    ).toEqual({ ok: false, reason: 'duplicate' });
    expect(c.editRole({ op: 'update', id: 'role_none', values: { name: 'X' } })).toEqual({
      ok: false,
      reason: 'not-defined',
    });
    expect(JSON.stringify(c.getContent().doc)).toBe(before);
    c.destroy();
  });

  it('refuses to delete a role fields are assigned to, and lists those fields (I13)', () => {
    const c = core();
    const refused = c.editRole({ op: 'delete', id: 'role_landlord' });
    expect(refused).toEqual({
      ok: false,
      reason: 'in-use',
      fields: [{ id: FIELD_IDS.landlord, key: 'landlord.name', label: 'Landlord' }],
    });
    expect(roleDefs(c)).toHaveLength(2);
    // A role no field names is deleted.
    c.editRole({ op: 'add', id: 'role_1', values: { name: 'Witness', color: '#2CA02C' } });
    expect(c.editRole({ op: 'delete', id: 'role_1' })).toEqual({ ok: true });
    expect(roleDefs(c).map((a) => a['id'])).toEqual(['role_tenant', 'role_landlord']);
    c.destroy();
  });

  it('changes nothing for a user who may not change the definitions (criterion 5)', () => {
    for (const access of [participantAccess(['role_tenant']), bodyEditor]) {
      const c = core();
      c.setAccess(access);
      const before = JSON.stringify(c.getContent().doc);
      const add = {
        op: 'add',
        id: 'role_1',
        values: { name: 'Witness', color: '#2CA02C' },
      } as const;
      expect(c.editRole(add, true)).toEqual({ ok: false, reason: 'read-only' });
      expect(c.editRole(add)).toEqual({ ok: false, reason: 'read-only' });
      expect(c.editRole({ op: 'update', id: 'role_tenant', values: { name: 'X' } })).toEqual({
        ok: false,
        reason: 'read-only',
      });
      expect(c.editRole({ op: 'delete', id: 'role_tenant' })).toEqual({
        ok: false,
        reason: 'read-only',
      });
      expect(JSON.stringify(c.getContent().doc)).toBe(before);
      // The list is still readable.
      expect(c.roles()).toHaveLength(2);
      c.destroy();
    }
  });

  it('adds no role to a document that does not require the feature fields', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule });
    expect(
      c.editRole({ op: 'add', id: 'role_1', values: { name: 'Witness', color: '#2CA02C' } }),
    ).toEqual({ ok: false, reason: 'no-feature' });
    c.destroy();
  });
});
