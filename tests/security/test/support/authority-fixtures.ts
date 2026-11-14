/**
 * Fixtures for the field-permission proofs (SEC-022). A small CDM document with form fields of every
 * server-set and participant-set kind, one restricted region, and the cast of connections. The
 * document and the connections are built here, not imported from the authority's own test folder,
 * so these proofs depend only on the authority's public exports.
 */
import { cdmSchema } from '@docedit/model/prosemirror';
import {
  computeAccess,
  regionPolicyOf,
  type Access,
  type Connection,
  type PermissionState,
  type RegionInfo,
} from '@docedit/authority';
import type { Node } from 'prosemirror-model';

export const schema = cdmSchema();

type J = Record<string, unknown>;

const p = (id: string, text: string, style: string | null = null): J => ({
  type: 'paragraph',
  attrs: { id, ...(style ? { style } : {}) },
  content: text ? [{ type: 'text', text }] : [],
});

const field = (
  id: string,
  key: string,
  kind: string,
  assignee: string | null,
  extra: J = {},
): J => ({
  type: 'form_field',
  attrs: { id, key, kind, label: key, assignee, ...extra },
});

export const FIELDS = {
  number: 'fNumber000000001',
  signature: 'fSignature000001',
  initials: 'fInitials0000001',
  dateSigned: 'fDateSigned00001',
  formula: 'fFormula00000001',
  readOnly: 'fReadOnly0000001',
  landlord: 'fLandlord0000001',
  legal: 'fTenantName00001',
} as const;

export const BASE_JSON: J = {
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
        { type: 'page_setup', attrs: { id: 'ps1' } },
        { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
        { type: 'role_def', attrs: { id: 'role_landlord', name: 'Landlord', color: '#FF7F0E' } },
      ],
    },
    {
      type: 'body',
      attrs: { pageSetup: 'ps1' },
      content: [
        p('pTitle0000000001', 'Lease agreement'),
        {
          type: 'paragraph',
          attrs: { id: 'pFields00000001X' },
          content: [
            { type: 'text', text: 'Fields: ' },
            field(FIELDS.number, 'tenant.amount', 'number', 'role_tenant'),
            { type: 'text', text: ' ' },
            field(FIELDS.signature, 'tenant.signature', 'signature', 'role_tenant'),
            { type: 'text', text: ' ' },
            field(FIELDS.initials, 'tenant.initials', 'initials', 'role_tenant'),
            { type: 'text', text: ' ' },
            field(FIELDS.dateSigned, 'tenant.signedOn', 'dateSigned', 'role_tenant'),
            { type: 'text', text: ' ' },
            field(FIELDS.formula, 'lease.total', 'formula', null),
            { type: 'text', text: ' ' },
            field(FIELDS.readOnly, 'tenant.fixed', 'text', 'role_tenant', { readOnly: true }),
            { type: 'text', text: ' ' },
            field(FIELDS.landlord, 'landlord.name', 'text', 'role_landlord'),
          ],
        },
        p('pIntro0000000001', 'This agreement is made between the parties.'),
        {
          type: 'region',
          attrs: { id: 'rLegal000000000B', title: 'Legal', policy: 'restricted' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'pLegal000000001B' },
              content: [
                { type: 'text', text: 'Liability is limited. Tenant: ' },
                field(FIELDS.legal, 'tenant.name', 'text', 'role_tenant'),
              ],
            },
          ],
        },
        p('pEnd00000000001Z', ''),
      ],
    },
  ],
};

export function fieldsDoc(): Node {
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

/** Erin is a filler who holds the tenant role and is an active participant (12 §7). */
export const ERIN = conn('erin', 'filler', {
  participantRoles: ['role_tenant'],
  participantActive: true,
});
/** Lena is a filler who holds the landlord role only. */
export const LENA = conn('lena', 'filler', {
  participantRoles: ['role_landlord'],
  participantActive: true,
});
/** Frank is a viewer: he may not submit anything. */
export const FRANK = conn('frank', 'viewer');
/** Carol is an editor: she may change the body, so she is not a fill-only user. */
export const CAROL = conn('carol', 'editor');

export function permissions(): PermissionState {
  return {
    revision: 1,
    grants: [],
    regionStates: new Map(),
    leases: [],
    documentState: 'active',
    workflowActive: false,
  };
}

/** The region list the authority reads from a document (its last child is the body). */
export function regionsOf(doc: Node): RegionInfo[] {
  const out: RegionInfo[] = [];
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name === 'region')
      out.push({ id: String(c.attrs['id']), policy: regionPolicyOf(c.attrs['policy']) });
  });
  return out;
}

export function accessOf(user: Connection, doc: Node): Access {
  return computeAccess(user, regionsOf(doc), permissions(), 0);
}
