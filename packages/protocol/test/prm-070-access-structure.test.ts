// PRM-070 criteria 1 and 2: the access object a grant with a `structure` list produces. The scope
// `region:<id>` holds `structure` for `region.retitle`, the scope `defs` holds `structure.add` for
// `defs.add`, and the object still passes the published schema (ADR 0424; decision 279).
import {
  type Connection,
  type PermissionState,
  type RegionGrant,
  computeAccess,
} from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import { toAccess } from '../src/bridge/translate.ts';
import { ajv2020, readJson, readText } from './support.ts';

const NOW = 1_760_000_000_000;
const TERMS = 'rTerms000000000A';
const NOTES = 'rNotes000000000C';
const REGIONS = [
  { id: TERMS, policy: 'inherit' as const },
  { id: NOTES, policy: 'inherit' as const },
];
const rita: Connection = {
  sub: 'rita',
  session: 's',
  role: 'viewer',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

const grant = (region: string, structure?: RegionGrant['structure']): RegionGrant => ({
  region,
  principal: 'user:rita',
  role: 'editor',
  expiresAt: null,
  ...(structure ? { structure } : {}),
});
const perms = (grants: RegionGrant[], extra: Partial<PermissionState> = {}): PermissionState => ({
  revision: 1,
  grants,
  regionStates: new Map(),
  leases: [],
  documentState: 'active',
  workflowActive: false,
  ...extra,
});
const accessOf = (p: PermissionState, conn: Connection = rita) =>
  toAccess(computeAccess(conn, REGIONS, p, NOW), conn, p, [], p.revision, 0);

const standalone = readJson('spec/dep/dep-1.schema.json');
const ajv = ajv2020();
ajv.addSchema(standalone);
const validate = ajv.getSchema(`${standalone['$id'] as string}#/$defs/Access`)!;

describe('the access object of a grant that lists region.retitle (PRM-070, criterion 1)', () => {
  it('puts `structure` in the scope of that region and nowhere else', () => {
    const a = accessOf(perms([grant(TERMS, ['region.retitle'])]));
    expect(a.scopes[`region:${TERMS}`]).toEqual([
      'view',
      'comment',
      'suggest',
      'edit',
      'structure',
    ]);
    expect(a.scopes[`region:${NOTES}`]).toEqual(['view']);
    // Not a document-level capability: the person still cannot create or move regions.
    expect(a.caps).toEqual(['view']);
    expect(a.scopes['doc']).toEqual(['view']);
    expect(a.scopes['defs']).toEqual(['view']);
    expect(validate(a), JSON.stringify(validate.errors)).toBe(true);
  });

  it('leaves it out without the listing, with another listing, after expiry and on a locked document', () => {
    const none = accessOf(perms([grant(TERMS)]));
    expect(none.scopes[`region:${TERMS}`]).not.toContain('structure');
    const other = accessOf(perms([grant(TERMS, ['defs.add'])]));
    expect(other.scopes[`region:${TERMS}`]).not.toContain('structure');
    const expired = accessOf(perms([{ ...grant(TERMS, ['region.retitle']), expiresAt: NOW }]));
    expect(expired.scopes[`region:${TERMS}`]).not.toContain('structure');
    const locked = accessOf(perms([grant(TERMS, ['region.retitle'])], { documentState: 'locked' }));
    expect(locked.scopes[`region:${TERMS}`]).not.toContain('structure');
  });

  it('is not offered to an agent', () => {
    const a = accessOf(perms([grant(TERMS, ['region.retitle', 'defs.add'])]), {
      ...rita,
      agent: 'assistant',
    });
    expect(a.scopes[`region:${TERMS}`]).not.toContain('structure');
    expect(a.scopes['defs']).not.toContain('structure.add');
  });
});

describe('the access object of a grant that lists defs.add (PRM-070, criterion 2)', () => {
  it('carries `structure.add` in the scope `defs`, whichever region lists it', () => {
    for (const region of [TERMS, NOTES]) {
      const a = accessOf(perms([grant(region, ['defs.add'])]));
      expect(a.scopes['defs']).toEqual(['view', 'structure.add']);
      expect(a.scopes[`region:${region}`]).not.toContain('structure');
      expect(validate(a), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('is absent without the listing', () => {
    const a = accessOf(perms([grant(TERMS, ['region.retitle'])]));
    expect(a.scopes['defs']).toEqual(['view']);
  });

  it('is carried next to document-level rights without replacing them', () => {
    const owner: Connection = { ...rita, sub: 'alice', role: 'owner' };
    const a = accessOf(perms([{ ...grant(TERMS, ['defs.add']), principal: 'user:alice' }]), owner);
    expect(a.scopes['defs']).toContain('edit');
    expect(a.caps).toContain('structure');
  });
});

describe('the integration guide on region-only editors (PRM-070, criterion 4)', () => {
  const guide = readText('apps/reference-host/docs/integration-guide.md');
  const section =
    guide.split('### People who may edit only one region')[1]?.split('\n### ')[0] ?? '';

  it('has the section', () => {
    expect(section).not.toBe('');
  });

  it('says what they can do: apply styles, rename and add styles when granted', () => {
    const can = section.split('**can** do:')[1]?.split('**cannot**')[0] ?? '';
    expect(can).toMatch(/apply/i);
    expect(can).toMatch(/Rename the region.*region\.retitle/s);
    expect(can).toMatch(/Add a style.*defs\.add/s);
  });

  it('says what they cannot: page setup, changing or removing a style, creating or removing regions', () => {
    const cannot = section.split('**cannot** do')[1] ?? '';
    expect(cannot).toMatch(/page setup/i);
    expect(cannot).toMatch(/Change or delete a style/);
    expect(cannot).toMatch(/Create, remove, split, merge or move a region/);
  });
});
