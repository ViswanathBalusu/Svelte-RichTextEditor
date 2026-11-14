/**
 * Fixtures for the permission stories of phase 1b (PRM, FRW-007 to FRW-010, FRW-088): the base
 * document of `fixtures.ts` with a paragraph of fields of every kind, two sensitive values (one in
 * the body, one in the inherit region Terms) and a second role, plus helpers that run the outcome
 * check and the room.
 */
import type { Node } from 'prosemirror-model';
import type { Step } from 'prosemirror-transform';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import {
  type OutcomeInput,
  type OutcomeVerdict,
  outcomeCheck,
} from '../src/permissions/outcome.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { applySteps } from '../src/rebase.ts';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, schema } from './fixtures.ts';

type J = Record<string, unknown>;

export const FIELDS = {
  number: 'fNumber000000001',
  date: 'fDate00000000001',
  choice: 'fChoice000000001',
  landlord: 'fLandlord0000001',
  authorOnly: 'fAuthorOnly00001',
  signature: 'fSignature000001',
  initials: 'fInitials0000001',
  dateSigned: 'fDateSigned00001',
  formula: 'fFormula00000001',
  secret: 'fSecret000000001',
  readOnly: 'fReadOnly0000001',
  termsSecret: 'fTermsSecret0001',
  tenantName: 'fTenantName00001',
} as const;

const field = (id: string, key: string, kind: string, assignee: string | null, extra: J = {}) => ({
  type: 'form_field',
  attrs: { id, key, kind, label: key, assignee, ...extra },
});

/** The base document plus fields of every kind, a second role and two sensitive values. */
export function fieldsJson(): J {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const defs = json.content[0]!.content;
  defs.push({
    type: 'role_def',
    attrs: { id: 'role_landlord', name: 'Landlord', color: '#FF7F0E' },
  });
  const body = json.content[1]!.content;
  const fields = [
    field(FIELDS.number, 'tenant.amount', 'number', 'role_tenant'),
    field(FIELDS.date, 'tenant.moveIn', 'date', 'role_tenant'),
    field(FIELDS.choice, 'tenant.pets', 'choice', 'role_tenant', {
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    }),
    field(FIELDS.landlord, 'landlord.name', 'text', 'role_landlord'),
    field(FIELDS.authorOnly, 'author.note', 'text', null),
    field(FIELDS.signature, 'tenant.signature', 'signature', 'role_tenant'),
    field(FIELDS.initials, 'tenant.initials', 'initials', 'role_tenant'),
    field(FIELDS.dateSigned, 'tenant.signedOn', 'dateSigned', 'role_tenant'),
    field(FIELDS.formula, 'lease.total', 'formula', null),
    field(FIELDS.secret, 'landlord.income', 'text', 'role_landlord', {
      sensitive: true,
      value: 'SECRET-INCOME',
    }),
    field(FIELDS.readOnly, 'tenant.fixed', 'text', 'role_tenant', { readOnly: true }),
  ];
  const content: J[] = [{ type: 'text', text: 'Fields: ' }];
  for (const f of fields) content.push(f, { type: 'text', text: ' ' });
  body.splice(2, 0, { type: 'paragraph', attrs: { id: 'pFields00000001X' }, content });
  // A sensitive value in the inherit region Terms, readable through a grant on the region.
  const terms = body.find((b) => (b['attrs'] as J | undefined)?.['id'] === 'rTerms000000000A')!;
  const para = (terms['content'] as J[])[0]!;
  (para['content'] as J[]).push(
    { type: 'text', text: ' Rent: ' },
    field(FIELDS.termsSecret, 'terms.rent', 'text', 'role_landlord', {
      sensitive: true,
      value: 'SECRET-RENT',
    }),
  );
  return json as unknown as J;
}

export function fieldsDoc(): Node {
  const doc = schema.nodeFromJSON(fieldsJson());
  doc.check();
  return doc;
}

/** More of the cast: a landlord participant, a region-only editor and a commenter. */
export const MORE = {
  lena: {
    sub: 'lena',
    session: 's-lena',
    role: 'filler',
    groups: [],
    participantRoles: ['role_landlord'],
    participantActive: true,
  },
  rita: {
    sub: 'rita',
    session: 's-rita',
    role: 'viewer',
    groups: [],
    participantRoles: [],
    participantActive: false,
  },
  cora: {
    sub: 'cora',
    session: 's-cora',
    role: 'commenter',
    groups: [],
    participantRoles: [],
    participantActive: false,
  },
} as const satisfies Record<string, Connection>;

/** Grants of the base fixtures plus an editor grant for Rita on Terms (a region-only editor). */
export function morePermissions(extra: Partial<PermissionState> = {}): PermissionState {
  const p = basePermissions();
  return {
    ...p,
    grants: [
      ...p.grants,
      { region: 'rTerms000000000A', principal: 'user:rita', role: 'editor', expiresAt: null },
    ],
    ...extra,
  };
}

export interface CheckOptions {
  perms?: PermissionState;
  extra?: Partial<OutcomeInput>;
  now?: number;
}

/** Applies `make(doc)` to `doc` and runs the outcome check for `user`. */
export function verdictOf(
  user: Connection,
  doc: Node,
  make: (doc: Node) => Step[],
  opts: CheckOptions = {},
): OutcomeVerdict {
  const steps = make(doc);
  const r = applySteps(doc, steps);
  if (!r.ok) throw new Error(`steps do not apply: ${r.reason}`);
  return verdictBetween(user, doc, r.value.doc, opts);
}

export function verdictBetween(
  user: Connection,
  before: Node,
  after: Node,
  opts: CheckOptions = {},
): OutcomeVerdict {
  const perms = opts.perms ?? morePermissions();
  return outcomeCheck({
    before,
    after,
    user: user.sub,
    access: computeAccess(user, regionInfos(before), perms, opts.now ?? 0),
    perms,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set(),
    serverAuthored: false,
    origin: 'input',
    ...opts.extra,
  });
}

export const ok = (v: OutcomeVerdict): boolean => v.ok;

/** The scopes of a refusal, or null when the commit was accepted. */
export const refused = (v: OutcomeVerdict): string[] | null => (v.ok ? null : v.scopes);

// -- the room ------------------------------------------------------------------------------------

let clock = 1_760_000_000_000;
let counter = 0;
export const commitId = (): string =>
  `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

export function roomWith(
  initial: Node,
  perms: PermissionState = morePermissions(),
  now?: () => number,
): Room {
  return new Room({
    schema,
    initial,
    requires: REQUIRES,
    log: [],
    perms,
    initialRevision: perms.revision,
    epoch: 1,
    incarnation: 'inc-1',
    now: now ?? (() => ++clock),
  });
}

export function messages(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}

export function rejection(
  fx: Effects,
  channel: string,
): Extract<ToClient, { t: 'sync.reject' }> | null {
  const m = messages(fx, channel).find((x) => x.t === 'sync.reject');
  return m && m.t === 'sync.reject' ? m : null;
}

export { USERS, schema };
