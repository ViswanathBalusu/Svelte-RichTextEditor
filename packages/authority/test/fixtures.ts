/**
 * Test fixtures for the authority: a base document with three regions, one of them restricted and
 * holding a fillable field, and a cast of users covering every role (07 §2).
 */
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Node } from 'prosemirror-model';
import type { Connection, PermissionState, RegionGrant } from '../src/permissions/model.ts';

export const schema = cdmSchema();

const p = (id: string, text: string, style: string | null = null) => ({
  type: 'paragraph',
  attrs: { id, ...(style ? { style } : {}) },
  content: text ? [{ type: 'text', text }] : [],
});

export const BASE_JSON = {
  type: 'doc',
  content: [
    {
      type: 'defs',
      content: [
        { type: 'settings', attrs: { lang: 'en-GB' } },
        {
          type: 'style_def',
          attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
        },
        {
          type: 'style_def',
          attrs: {
            id: 'Heading1',
            kind: 'paragraph',
            name: 'Heading 1',
            builtIn: true,
            basedOn: 'Normal',
            outlineLevel: 1,
          },
        },
        {
          type: 'style_def',
          attrs: { id: 'LegalBody', kind: 'paragraph', name: 'Legal body', basedOn: 'Normal' },
        },
        { type: 'page_setup', attrs: { id: 'ps1' } },
        { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
      ],
    },
    {
      type: 'body',
      attrs: { pageSetup: 'ps1' },
      content: [
        p('pTitle0000000001', 'Lease agreement', 'Heading1'),
        p('pIntro0000000001', 'This agreement is made between the parties.'),
        {
          type: 'region',
          attrs: { id: 'rTerms000000000A', title: 'Terms', policy: 'inherit' },
          content: [
            p('pTerms000000001A', 'Rent is due monthly.'),
            p('pTerms000000002A', 'Deposit is one month.'),
          ],
        },
        p('pMiddle000000001', 'Between the regions.'),
        {
          type: 'region',
          attrs: { id: 'rLegal000000000B', title: 'Legal', policy: 'restricted' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'pLegal000000001B', style: 'LegalBody' },
              content: [
                { type: 'text', text: 'Liability is limited. Tenant: ' },
                {
                  type: 'form_field',
                  attrs: {
                    id: 'fTenantName00001',
                    key: 'tenant.name',
                    kind: 'text',
                    label: 'Tenant name',
                    assignee: 'role_tenant',
                  },
                },
              ],
            },
          ],
        },
        p('pAfter0000000001', 'After the legal part.'),
        {
          type: 'region',
          attrs: { id: 'rNotes000000000C', title: 'Notes', policy: 'inherit' },
          content: [p('pNotes000000001C', 'Notes go here.')],
        },
        p('pEnd00000000001Z', ''),
      ],
    },
  ],
};

export const REQUIRES = ['fields'];

export function baseDoc(): Node {
  const doc = schema.nodeFromJSON(BASE_JSON);
  doc.check();
  return doc;
}

const conn = (
  sub: string,
  role: Connection['role'],
  extra: Partial<Connection> = {},
): Connection => ({
  sub,
  session: `s-${sub}`,
  role,
  groups: [],
  participantRoles: [],
  participantActive: false,
  ...extra,
});

/** The cast. Bob may edit the restricted region through a grant; Dave suggests there. */
export const USERS = {
  alice: conn('alice', 'owner'),
  bob: conn('bob', 'editor', { groups: ['legal'] }),
  carol: conn('carol', 'editor'),
  dave: conn('dave', 'suggester'),
  erin: conn('erin', 'filler', { participantRoles: ['role_tenant'], participantActive: true }),
  frank: conn('frank', 'viewer'),
  mallory: conn('mallory', 'editor'),
} as const;

export type UserName = keyof typeof USERS;

export const GRANTS: RegionGrant[] = [
  { region: 'rLegal000000000B', principal: 'group:legal', role: 'editor', expiresAt: null },
  { region: 'rLegal000000000B', principal: 'user:dave', role: 'suggester', expiresAt: null },
];

export function basePermissions(): PermissionState {
  return {
    revision: 1,
    grants: GRANTS,
    regionStates: new Map(),
    leases: [],
    documentState: 'active',
    workflowActive: false,
  };
}

/** Position just inside the start of the first textblock whose id is `id`. */
export function posInside(doc: Node, id: string, offset = 0): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.attrs['id'] === id) {
      found = pos + 1 + offset;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/** Position of the node itself (before it). */
export function posOf(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.attrs['id'] === id) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}
