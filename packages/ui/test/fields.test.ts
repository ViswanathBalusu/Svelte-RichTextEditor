/**
 * Role markers for a participant (FRW-074 criterion 4, FRW-077 criteria 1 to 3 and 5) and the icon
 * derived from a role's order (FRW-074). These are the rules the fill pane draws and the fill counts
 * use; the drawn markers are tested in the browser (e2e/regions.spec.ts). The insert palette
 * (FRW-072) is tested through the command registry in field-commands.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { FieldRoleInfo, FillField, FillSummary } from '../src/core-api.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { sourceTranslator } from '../src/i18n/strings.ts';
import { ROLE_ICONS, fieldMarker, ownFields, ownership, roleIcon } from '../src/shell/fields.ts';

const tr = sourceTranslator();

describe('the icon of a role follows its order (FRW-074)', () => {
  it('gives the first roles distinct icons', () => {
    const icons = Array.from({ length: ROLE_ICONS.length }, (_, i) => roleIcon(i));
    expect(new Set(icons).size).toBe(ROLE_ICONS.length);
  });

  it('repeats the icons only after a full cycle, and always gives a known icon (property)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000 }), (order) => {
        expect(ROLE_ICONS).toContain(roleIcon(order));
        expect(roleIcon(order)).toBe(roleIcon(order + ROLE_ICONS.length));
      }),
    );
  });
});

const roleArb = fc
  .record({
    name: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,11}$/),
    color: fc.constantFrom('#1b5e20', '#0d47a1', '#b71c1c'),
    order: fc.nat({ max: 20 }),
  })
  .map((r): FieldRoleInfo => r);

const fieldArb = fc
  .record({
    label: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,15}$/),
    assignee: fc.option(fc.constantFrom('role_a', 'role_b', 'role_c'), { nil: null }),
    role: fc.option(roleArb, { nil: null }),
  })
  .map((f) => f as Pick<FillField, 'label' | 'assignee' | 'role'>);

describe('role markers for a participant (FRW-077)', () => {
  it('marks a field of a role the participant holds as theirs, editable while active (criterion 2)', () => {
    const marker = fieldMarker(
      { label: 'Income', assignee: 'role_a', role: { name: 'Tenant', color: '#0d47a1', order: 0 } },
      ['role_a'],
      true,
      tr,
    );
    expect(marker).toMatchObject({
      ownership: 'mine',
      readOnly: false,
      text: 'Yours',
      roleName: 'Tenant',
      color: '#0d47a1',
      icon: 'circle',
      name: 'Income, Tenant, yours to fill in',
    });
  });

  it('names a field of their own role as theirs even when the role is not known to the shell', () => {
    const marker = fieldMarker(
      { label: 'Income', assignee: 'role_a', role: null },
      ['role_a'],
      true,
      tr,
    );
    expect(marker.name).toBe('Income, yours to fill in');
    expect(marker.name).not.toContain(tr.t('field.role.hidden'));
    // A core that lists only the participant's own fields gives no assignee: they are theirs.
    expect(fieldMarker({ label: 'Income' }, [], true, tr).ownership).toBe('mine');
  });

  it('keeps a field of their role read-only while the participant is not active', () => {
    const marker = fieldMarker(
      { label: 'Income', assignee: 'role_a', role: null },
      ['role_a'],
      false,
      tr,
    );
    expect(marker.ownership).toBe('mine');
    expect(marker.readOnly).toBe(true);
  });

  it('shows a field of another role read-only, with the role name and the label in its accessible name (criterion 1)', () => {
    fc.assert(
      fc.property(fieldArb, fc.boolean(), (field, active) => {
        const marker = fieldMarker(field, ['role_c'], active, tr);
        if (field.assignee === null || field.assignee === undefined) return;
        if (field.assignee === 'role_c') return;
        expect(marker.ownership).toBe('other');
        expect(marker.readOnly).toBe(true);
        expect(marker.name).toContain(field.label);
        const roleText = field.role?.name ?? tr.t('field.role.hidden');
        expect(marker.text).toBe(roleText);
        expect(marker.name).toContain(roleText);
        expect(marker.roleName).toBe(field.role?.name ?? null);
      }),
    );
  });

  it('gives every marker that names a role the role colour and an icon, and the role name as text (FRW-074 criterion 4)', () => {
    fc.assert(
      fc.property(fieldArb, (field) => {
        const marker = fieldMarker(field, ['role_a', 'role_b', 'role_c'], true, tr);
        if (!field.role || field.assignee === null) {
          expect(marker.icon).toBeNull();
          expect(marker.color).toBeNull();
          return;
        }
        expect(marker.color).toBe(field.role.color);
        expect(marker.icon).toBe(roleIcon(field.role.order));
        expect(marker.name).toContain(field.role.name);
      }),
    );
  });

  it('shows a field with no assignee read-only and without a role, whatever the core sent (criterion 3)', () => {
    const marker = fieldMarker(
      { label: 'Notes', assignee: null, role: { name: 'Tenant', color: '#0d47a1', order: 0 } },
      ['role_a'],
      true,
      tr,
    );
    expect(marker).toMatchObject({
      ownership: 'none',
      readOnly: true,
      text: 'No role',
      roleName: null,
      icon: null,
      color: null,
      name: 'Notes, not assigned to a role, not yours to fill in',
    });
  });

  it('is decided by the assignee alone: mine exactly when the assignee is one of the participant’s roles (property)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom('role_a', 'role_b', 'role_c'), { nil: null }),
        fc.subarray(['role_a', 'role_b', 'role_c'] as const),
        (assignee, mine) => {
          const expected = assignee === null ? 'none' : mine.includes(assignee) ? 'mine' : 'other';
          expect(ownership(assignee, mine)).toBe(expected);
        },
      ),
    );
  });

  it('counts only the participant’s own fields, in document order', () => {
    const summary: FillSummary = {
      active: true,
      roles: ['role_a'],
      fields: [
        { id: 'f1', label: 'A', required: true, filled: false, invalid: null, assignee: 'role_b' },
        { id: 'f2', label: 'B', required: true, filled: false, invalid: null, assignee: 'role_a' },
        { id: 'f3', label: 'C', required: true, filled: false, invalid: null, assignee: null },
        { id: 'f4', label: 'D', required: false, filled: false, invalid: null, assignee: 'role_a' },
      ],
    };
    expect(ownFields(summary).map((f) => f.id)).toEqual(['f2', 'f4']);
  });

  it('uses only external strings: every key the marker needs exists in the source table (criterion 5)', () => {
    for (const key of [
      'field.name.mine',
      'field.name.mineUnnamed',
      'field.name.other',
      'field.name.none',
      'field.role.hidden',
      'field.role.none',
      'field.mine',
      'field.readOnly',
      'fill.fields',
    ] as const)
      expect(EN_GB[key]).toBeDefined();
  });
});
