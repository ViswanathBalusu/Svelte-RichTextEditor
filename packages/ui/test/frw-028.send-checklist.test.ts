// The pre-send checklist model of the send dialog (FRW-028 criteria 1 to 4 and 6, as data; lane
// V-FRW-019-036). Node.js only: the dialog component and its keyboard and axe checks are not built
// here, so criteria 1, 2, 3, 5 stay open in the story. Plain functions, no DOM.
import { describe, expect, it } from 'vitest';
import {
  checklistAnnouncement,
  checklistRows,
  sendControl,
  serverVerdictRows,
  type SendFailure,
} from '../src/shell/send-checklist.ts';

const ALL_PASS = checklistRows([]);

describe('the checklist lists the four checks in order, each passed or failed in words and with an icon (FRW-028 criterion 1)', () => {
  it('lists four rows when nothing fails, every one passed with a word and an icon', () => {
    expect(ALL_PASS.map((r) => r.check)).toEqual([
      'required_fields',
      'roles',
      'rules',
      'suggestions',
    ]);
    for (const r of ALL_PASS) {
      expect(r.passed).toBe(true);
      expect(r.statusKey).toBe('send.check.passed');
      expect(r.icon).toBe('pass');
      expect(r.target).toBeNull();
      expect(r.count).toBe(0);
    }
  });

  it('marks a failed check failed in words and with the fail icon, and counts what it lists', () => {
    const rows = checklistRows([
      { code: 'required_field_unassigned', keys: ['tenant.name', 'tenant.date'] },
    ]);
    expect(rows[0]).toMatchObject({
      check: 'required_fields',
      passed: false,
      statusKey: 'send.check.failed',
      icon: 'fail',
      count: 2,
      items: ['tenant.name', 'tenant.date'],
    });
    expect(rows.slice(1).every((r) => r.passed)).toBe(true);
  });

  it('gives every row a label key of its own (external strings)', () => {
    expect(ALL_PASS.map((r) => r.labelKey)).toEqual([
      'send.check.required_fields',
      'send.check.roles',
      'send.check.rules',
      'send.check.suggestions',
    ]);
  });
});

describe('a failed row links to the place that fixes it (FRW-028 criterion 2)', () => {
  it('links a field failure to its keys, a role failure to the participants view, and a suggestion to its identifiers', () => {
    const rows = checklistRows([
      { code: 'required_field_unassigned', keys: ['k1'] },
      { code: 'role_without_participant', roles: ['role_landlord'] },
      { code: 'pending_suggestions', suggestionIds: ['s1', null] },
    ]);
    expect(rows[0]?.target).toEqual({ kind: 'field', keys: ['k1'] });
    expect(rows[1]?.target).toEqual({ kind: 'participants', roles: ['role_landlord'] });
    expect(rows[3]?.target).toEqual({ kind: 'suggestion', ids: ['s1'] });
    // A suggestion with no identifier is still counted, so the row is not reported as passed.
    expect(rows[3]?.count).toBe(2);
    expect(rows[3]?.passed).toBe(false);
  });

  it('links a rule failure to the rules panel and counts its problems', () => {
    const rows = checklistRows([{ code: 'rules_invalid', problems: [{ a: 1 }, { b: 2 }] }]);
    expect(rows[2]).toMatchObject({ passed: false, count: 2, target: { kind: 'rules' } });
  });
});

describe('the send control (FRW-028 criteria 3 and 6)', () => {
  it('is on, with a confirmation, only for a manager of a draft whose checks all pass', () => {
    expect(sendControl({ manage: true }, 'draft', ALL_PASS)).toEqual({
      enabled: true,
      reasonKey: null,
      confirm: true,
    });
  });

  it('is off with a stated reason for a user without manage, whatever the checks say', () => {
    expect(sendControl({ manage: false }, 'draft', ALL_PASS)).toEqual({
      enabled: false,
      reasonKey: 'send.control.forbidden',
      confirm: false,
    });
  });

  it('is off while any check fails, and off once the workflow is no longer a draft', () => {
    const failing = checklistRows([{ code: 'role_without_participant', roles: ['r'] }]);
    expect(sendControl({ manage: true }, 'draft', failing).reasonKey).toBe(
      'send.control.checks_failed',
    );
    expect(sendControl({ manage: true }, 'sent', ALL_PASS).reasonKey).toBe(
      'send.control.not_draft',
    );
  });
});

describe("the server's verdict replaces the editor's list when the server refuses (FRW-028 criterion 4)", () => {
  it('shows the failure the server names even when the editor thought every check passed', () => {
    const serverFailures: SendFailure[] = [{ code: 'required_field_unassigned', keys: ['late'] }];
    const rows = serverVerdictRows(serverFailures);
    expect(rows[0]).toMatchObject({ passed: false, items: ['late'] });
    expect(sendControl({ manage: true }, 'draft', rows).enabled).toBe(false);
  });
});

describe('the live region announces a change in the result (FRW-028 criterion 5, as data)', () => {
  it('announces the number of failed checks when the result first appears or changes', () => {
    const failing = checklistRows([{ code: 'role_without_participant', roles: ['r'] }]);
    expect(checklistAnnouncement(null, failing)).toEqual({
      key: 'send.check.announce',
      failed: 1,
    });
    expect(checklistAnnouncement(ALL_PASS, failing)?.failed).toBe(1);
  });

  it('announces nothing when the failing checks are the same as before', () => {
    const failing = checklistRows([{ code: 'role_without_participant', roles: ['r'] }]);
    const again = checklistRows([{ code: 'role_without_participant', roles: ['other'] }]);
    expect(checklistAnnouncement(failing, again)).toBeNull();
  });
});
