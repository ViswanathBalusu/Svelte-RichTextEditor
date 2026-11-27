// PRM-068 criterion 4: the schema of a region grant carries the optional `structure` member, the
// generated artifacts say so, and its list is the one the authority's table marks `perRegion`.
import { REGION_STRUCTURE_OPERATIONS } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import { GRANT_STRUCTURE_OPERATIONS } from '../src/definition/common.ts';
import { readJson } from './support.ts';

interface Schema {
  $defs: Record<
    string,
    {
      enum?: string[];
      required?: string[];
      additionalProperties?: boolean;
      properties?: Record<
        string,
        { type?: string; uniqueItems?: boolean; items?: { $ref: string } }
      >;
    }
  >;
}

describe('the schema of a region grant (PRM-068, criterion 4)', () => {
  const schema = readJson('spec/dep/dep-1.schema.json') as Schema;

  it('carries `structure` as an optional list of unique operation identifiers', () => {
    const grant = schema.$defs['RegionGrant']!;
    expect(grant.properties?.['structure']).toMatchObject({
      type: 'array',
      uniqueItems: true,
      items: { $ref: '#/$defs/GrantStructureOperation' },
    });
    expect(grant.required ?? []).not.toContain('structure');
    expect(schema.$defs['GrantStructureOperation']!.enum).toEqual(['region.retitle', 'defs.add']);
  });

  it('lists the operations that the authority marks `perRegion`', () => {
    expect([...GRANT_STRUCTURE_OPERATIONS].sort()).toEqual([...REGION_STRUCTURE_OPERATIONS].sort());
  });

  it('is in the OpenAPI document and the generated types', () => {
    const openapi = readJson('spec/dep/dep-1.openapi.json') as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    expect(openapi.components.schemas['RegionGrant']!.properties).toHaveProperty('structure');
    expect(openapi.components.schemas['GrantStructureOperation']).toBeDefined();
  });
});
