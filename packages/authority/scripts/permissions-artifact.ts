/**
 * The machine-readable definition of permissions (PRM-001, PRM-056), written to
 * `spec/permissions/permissions-1.json` by `pnpm --filter @docedit/authority generate` from the
 * definitions the authority enforces: capabilities, roles, region roles and policies, the scope and
 * principal forms, the operations of `structure` and `manage`, and the authorisation matrix of
 * 07 §12 with the routes it has no row for. A test fails when the file is not a fresh generation,
 * and CI checks `spec/` against `pnpm generate`.
 */
import { NODE_ID_PATTERN } from '@docedit/model';
import { DEFINITION_ID_PATTERN } from '@docedit/model/definition';
import { MATRIX, UNMATRIXED_ROUTES } from '../src/permissions/matrix.ts';
import {
  CAPABILITIES,
  DOC_ROLES,
  OPERATIONS,
  REGION_CAPABILITIES,
  REGION_POLICIES,
  REGION_ROLES,
  ROLE_CAPABILITIES,
} from '../src/permissions/model.ts';

export const PERMISSIONS_ARTIFACT = 'spec/permissions/permissions-1.json';

export function buildPermissionsArtifact(): unknown {
  return {
    artifact: 'permissions',
    version: 1,
    status: 'draft',
    spec: '07 §1, §2, §4, §12; 12 §4.1; ADR 0019 (proposed); ADR 0033 (proposed)',
    generator: 'packages/authority/scripts/generate.ts',
    description:
      'Capabilities, roles, scopes, principals, the operations that need `structure` or `manage`, and the authorisation matrix, as the authority enforces them. `structure` for an editor is document level only: region grants never convey it.',
    capabilities: CAPABILITIES,
    roles: Object.fromEntries(DOC_ROLES.map((r) => [r, ROLE_CAPABILITIES[r]])),
    regionRoles: REGION_ROLES,
    regionCapabilities: REGION_CAPABILITIES,
    regionPolicies: REGION_POLICIES,
    scopes: {
      forms: [
        'doc',
        'body',
        'defs',
        'defs:settings',
        'defs:<type>/<definitionId>',
        'story:<nodeId>',
        'region:<nodeId>',
        'field:<nodeId>',
      ],
      nodeId: NODE_ID_PATTERN,
      definitionId: DEFINITION_ID_PATTERN,
      definitionType: '^[a-z_]+$',
    },
    principals: {
      forms: ['user:<sub>', 'group:<id>', 'everyone', 'role:<definitionId>'],
      opaque:
        'sub and group identifiers: 1 to 255 characters without whitespace or control characters',
    },
    operations: OPERATIONS,
    matrix: MATRIX,
    unmatrixedRoutes: UNMATRIXED_ROUTES,
  };
}
