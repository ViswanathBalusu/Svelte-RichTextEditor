// PRM-002 criterion 3 (07 §3): "Permission data is never stored in the document content other than
// the region's `policy`." Content is whatever the CDM schema lets a document hold, so this test
// enumerates every attribute of every node, mark and projection node type of the schema (with the
// members nested in object and array attributes) and classifies each one. The storage round trip,
// which searches what the stores keep, is prm-002.content.test.ts.
import { REGION_POLICIES as AUTHORITY_POLICIES } from '@docedit/authority';
import { CDM1, REGION_POLICIES, type CdmDefinition, type NodeDef } from '@docedit/model/definition';
import { projectionSchema } from '@docedit/model/prosemirror';
import { checkGrammar } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_VALUES,
  PRINCIPAL_SAMPLES,
  isPermissionName,
  permissionRelated,
  schemaAttributes,
} from './prm-002.permission-vocabulary.ts';

/** The one attribute that is permission data and lives in the content (07 §3). */
const PERMISSION_DATA = ['region.policy'];

/**
 * Attributes that the permission rules read but that are not permission data in the sense of 07 §3:
 * they name no principal, capability, grant, region state, lease or participant. Each entry says
 * why; the test below proves from the grammar that none of them can hold a principal.
 */
const READ_BY_RULES_NOT_PERMISSION_DATA: Readonly<Record<string, string>> = {
  // 07 §5.2: with `everyone`, rule P4 applies to every user. A mode of the document, not a grant.
  'settings.trackChanges': 'track-changes mode (07 §5.2); `everyone` is a mode, not a principal',
  // 12 §2, §3.1, §5.4: fields are assigned to role placeholders defined in `defs`, never to people;
  // who plays a role (the participants) lives in the workflow resource (07 §3; 12 §5.4).
  'form_field.assignee': 'a role placeholder (`role_def` identifier), never a person (12 §3.1)',
};

describe('PRM-002 criterion 3: what the CDM schema lets a document hold', () => {
  const attributes = schemaAttributes(CDM1);
  const found = permissionRelated(CDM1);

  it('enumerates every attribute of the live ProseMirror schema, projection nodes included', () => {
    // The enumeration reads the CDM definition; the editor and the authority run the ProseMirror
    // schema built from it. Every top-level attribute of that schema must be in the enumeration.
    const schema = projectionSchema();
    const live: string[] = [];
    for (const [name, type] of Object.entries(schema.nodes))
      for (const attr of Object.keys(type.spec.attrs ?? {})) live.push(`${name}.${attr}`);
    for (const [name, type] of Object.entries(schema.marks))
      for (const attr of Object.keys(type.spec.attrs ?? {})) live.push(`${name}.${attr}`);
    const enumerated = attributes.filter((a) => !a.path.includes('.') && !a.path.includes('[]'));
    expect(new Set(enumerated.map((a) => `${a.type}.${a.path}`))).toEqual(new Set(live));
    expect(live.length).toBeGreaterThan(100);
    expect(attributes.length).toBeGreaterThan(live.length);
  });

  it('finds region.policy as the only attribute that is permission data', () => {
    const expected = new Set([
      ...PERMISSION_DATA,
      ...Object.keys(READ_BY_RULES_NOT_PERMISSION_DATA),
    ]);
    expect(new Set(found.keys())).toEqual(expected);
    expect([...found.keys()].filter((k) => !(k in READ_BY_RULES_NOT_PERMISSION_DATA))).toEqual(
      PERMISSION_DATA,
    );
  });

  it('gives region.policy exactly the policies the authority knows', () => {
    const policy = CDM1.nodes.find((n) => n.name === 'region')?.attrs['policy'];
    expect(policy?.grammar).toEqual({ kind: 'enum', values: [...REGION_POLICIES] });
    expect([...REGION_POLICIES]).toEqual([...AUTHORITY_POLICIES]);
  });

  it('lets no other flagged attribute hold a principal, capability, role or state', () => {
    for (const key of Object.keys(READ_BY_RULES_NOT_PERMISSION_DATA)) {
      const [type, path] = key.split('.') as [string, string];
      const attr = attributes.find((a) => a.type === type && a.path === path);
      expect(attr, key).toBeDefined();
      const g = attr!.grammar;
      for (const p of PRINCIPAL_SAMPLES.filter((s) => s.includes(':')))
        expect(checkGrammar(g, p, ''), `${key} refuses ${p}`).not.toEqual([]);
      if (g.kind === 'enum') {
        // trackChanges: `off` or `everyone`, and of the permission vocabulary only `everyone`.
        expect(g.values).toEqual(['off', 'everyone']);
        const accepted = [...PERMISSION_VALUES].filter((v) => checkGrammar(g, v, '').length === 0);
        expect(accepted).toEqual(['everyone']);
      } else {
        // assignee: a `role_def` identifier, which cannot take the `kind:id` form of a principal.
        expect(g).toEqual({ kind: 'ref', to: 'role', nullable: true });
      }
    }
  });

  it('names no free JSON or element-tree attribute with a permission word', () => {
    // Free JSON (`ext`, `payload`, `value`, rules) and preserved element trees are opaque values:
    // the authority never reads permissions from them (criterion 4), and their names say nothing
    // of permissions either.
    const opaque = attributes.filter(
      (a) => a.grammar.kind === 'json' || a.grammar.kind === 'elementTree',
    );
    expect(opaque.length).toBeGreaterThan(0);
    expect(opaque.filter((a) => isPermissionName(a.name))).toEqual([]);
  });

  it('would catch a permission attribute added to the schema (negative control)', () => {
    const region = CDM1.nodes.find((n) => n.name === 'region')!;
    const paragraph = CDM1.nodes.find((n) => n.name === 'paragraph')!;
    const policy = region.attrs['policy']!;
    const widened: NodeDef[] = CDM1.nodes.map((n) => {
      if (n === region)
        return {
          ...n,
          attrs: {
            ...n.attrs,
            grants: { ...policy, grammar: { kind: 'json', maxBytes: 1024, maxDepth: 4 } },
            leaseHolder: { ...policy, grammar: { kind: 'string', maxLength: 64 } },
          },
        };
      if (n === paragraph)
        return {
          ...n,
          attrs: {
            ...n.attrs,
            lock: { ...policy, grammar: { kind: 'enum', values: ['view', 'edit'] } },
            reviewer: { ...policy, grammar: { kind: 'ref', to: 'role' } },
          },
        };
      return n;
    });
    const def: CdmDefinition = { ...CDM1, nodes: widened };
    const extra = [...permissionRelated(def).keys()].filter((k) => !found.has(k));
    expect(new Set(extra)).toEqual(
      new Set(['region.grants', 'region.leaseHolder', 'paragraph.lock', 'paragraph.reviewer']),
    );
    // The name check works on whole words: `placeholder` is not `holder`.
    expect(isPermissionName('placeholder')).toBe(false);
    expect(isPermissionName('expiresAt')).toBe(true);
  });
});
