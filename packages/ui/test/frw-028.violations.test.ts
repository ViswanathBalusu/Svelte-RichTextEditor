// The server's verdict on a refused send, read into the failures of the checklist (FRW-028 criterion
// 4). Node.js only; the dialog that shows them is run in the browser (e2e/frw-028-send-dialog.spec.ts).
import { describe, expect, it } from 'vitest';
import { checklistRows, failuresFromViolations } from '../src/shell/send-checklist.ts';

describe('failuresFromViolations reads the paths the service writes (FRW-027 route)', () => {
  it('groups fields, roles and suggestions, and any other path is a rules problem', () => {
    const failures = failuresFromViolations([
      { path: '/fields/tenant.email' },
      { path: '/fields/tenant.phone' },
      { path: '/roles/landlord' },
      { path: '/suggestions/s1' },
      { path: '/rules/r_hide/then' },
    ]);
    expect(failures).toEqual([
      { code: 'required_field_unassigned', keys: ['tenant.email', 'tenant.phone'] },
      { code: 'role_without_participant', roles: ['landlord'] },
      { code: 'rules_invalid', problems: ['/rules/r_hide/then'] },
      { code: 'pending_suggestions', suggestionIds: ['s1'] },
    ]);
  });

  it('keeps a key that holds a slash, and counts a suggestion with no identifier', () => {
    expect(failuresFromViolations([{ path: '/fields/a/b' }, { path: '/suggestions/' }])).toEqual([
      { code: 'required_field_unassigned', keys: ['a/b'] },
      { code: 'pending_suggestions', suggestionIds: [null] },
    ]);
  });

  it('gives no failure for no violation, and the rows then all pass', () => {
    expect(failuresFromViolations([])).toEqual([]);
    expect(checklistRows([]).every((r) => r.passed)).toBe(true);
  });

  it('turns into rows that fail the checks the server named, in the dialog order', () => {
    const rows = checklistRows(
      failuresFromViolations([{ path: '/suggestions/s1' }, { path: '/roles/landlord' }]),
    );
    expect(rows.map((r) => [r.check, r.passed])).toEqual([
      ['required_fields', true],
      ['roles', false],
      ['rules', true],
      ['suggestions', false],
    ]);
  });
});
