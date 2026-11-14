// The share dialog's rules (UX-095 criteria 1 and 2, the parts the dialog shows): the role choices,
// when a change takes effect and the message after a save. Pure functions, no service.
import { describe, expect, it } from 'vitest';
import {
  SHARE_ROLES,
  effectSentence,
  groupRows,
  parseRoleChoice,
  roleEffect,
  roleLabel,
  roleSavedMessage,
} from '../src/lib/share/share-model.ts';

describe('the role choices of the share dialog (UX-095 criterion 1)', () => {
  it('offers the six document-level roles of 13 section 5, filler included', () => {
    expect([...SHARE_ROLES]).toEqual([
      'viewer',
      'commenter',
      'suggester',
      'editor',
      'owner',
      'filler',
    ]);
    expect(SHARE_ROLES.map((r) => roleLabel(r))).toEqual([
      'Viewer',
      'Commenter',
      'Suggester',
      'Editor',
      'Owner',
      'Filler',
    ]);
  });

  it('accepts each role and none, and refuses anything else', () => {
    for (const r of SHARE_ROLES) expect(parseRoleChoice(r)).toBe(r);
    expect(parseRoleChoice('none')).toBe('none');
    expect(parseRoleChoice('admin')).toBeUndefined();
    expect(parseRoleChoice('')).toBeUndefined();
    expect(parseRoleChoice('Owner')).toBeUndefined();
  });

  it('labels a missing role as no access', () => {
    expect(roleLabel(null)).toBe('No access');
  });
});

describe('when a role change takes effect (UX-095 criterion 2)', () => {
  it('ends the sessions now when an existing role is taken away', () => {
    expect(roleEffect('editor', null)).toBe('now');
    expect(roleEffect('viewer', null)).toBe('now');
  });

  it('ends the sessions now when an existing role changes to another, in either direction', () => {
    expect(roleEffect('viewer', 'editor')).toBe('now');
    expect(roleEffect('owner', 'filler')).toBe('now');
  });

  it('applies at the next token when a role is given to someone with none', () => {
    expect(roleEffect(null, 'viewer')).toBe('next-token');
  });

  it('applies at the next token when the role is kept as it is', () => {
    expect(roleEffect('editor', 'editor')).toBe('next-token');
  });

  it('says so in the message after a save, with the time it takes', () => {
    expect(roleSavedMessage('Bob Mensah', null, 'now')).toBe(
      'Bob Mensah is now without access. Their sessions on this document have ended, so the change applies now.',
    );
    expect(roleSavedMessage('Ada Lindqvist', 'filler', 'next-token')).toBe(
      'Ada Lindqvist is now filler. The change applies from their next token, at most 15 minutes later.',
    );
    expect(effectSentence('next-token')).toContain('at most 15 minutes later');
  });
});

describe('groups in the share dialog (UX-095 criterion 1)', () => {
  const users = [
    { sub: 'u-olivia', name: 'Olivia Okafor', groups: ['g-owners'] },
    { sub: 'u-ada', name: 'Ada Lindqvist', groups: ['g-finance'] },
    { sub: 'u-bob', name: 'Bob Mensah', groups: ['g-logistics'] },
    { sub: 'u-vic', name: 'Vic Moreau', groups: [] },
  ];
  const roles: Record<string, 'owner' | 'editor' | 'viewer'> = {
    'u-olivia': 'owner',
    'u-ada': 'editor',
    'u-bob': 'editor',
    'u-vic': 'viewer',
  };
  const groups = [
    { id: 'g-owners', name: 'Document owners' },
    { id: 'g-finance', name: 'Finance' },
    { id: 'g-empty', name: 'No one' },
  ];

  it('lists each group with its members and their own roles, in seed order', () => {
    const rows = groupRows(groups, users, (sub) => roles[sub] ?? null);
    expect(rows).toEqual([
      {
        id: 'g-owners',
        name: 'Document owners',
        members: [{ sub: 'u-olivia', name: 'Olivia Okafor', role: 'owner' }],
      },
      {
        id: 'g-finance',
        name: 'Finance',
        members: [{ sub: 'u-ada', name: 'Ada Lindqvist', role: 'editor' }],
      },
      { id: 'g-empty', name: 'No one', members: [] },
    ]);
  });

  it('gives a group no role of its own: only its members carry roles', () => {
    const rows = groupRows(groups, users, () => null);
    for (const row of rows) {
      expect(row).not.toHaveProperty('role');
      for (const m of row.members) expect(m.role).toBeNull();
    }
  });
});
