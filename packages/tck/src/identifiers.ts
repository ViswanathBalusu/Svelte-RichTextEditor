/**
 * Routes addressed by a bare identifier (05 §6.1; 10 §3.2; PRO-045): a job, an asset, a thread or
 * a comment is named without its document, so the server must resolve the identifier to its
 * document and check the caller's token against that document. This is the kit's table of those
 * routes: for each, the feature whose announcement offers it and the scenario that calls it with a
 * token of another document. A route is added here when its feature lands.
 */
import { DEP1 } from '@docedit/protocol';

export interface BareRoute {
  /** The operation, as `METHOD /path` with the path of 05 §6.2. */
  readonly operation: string;
  /** The feature a server announces to offer the route; null when DEP names none. */
  readonly feature: string | null;
  /** The scenario with the cross-document call; null when the kit has none yet. */
  readonly scenario: string | null;
  /** Why there is no scenario yet. */
  readonly pending?: string;
}

/** By the first path segment: the feature that offers the routes and the scenario that tests them. */
const BY_RESOURCE: Readonly<Record<string, Omit<BareRoute, 'operation'>>> = {
  exports: { feature: 'exports', scenario: 'exports.identifiers' },
  assets: { feature: 'assets', scenario: 'assets.other-document' },
  threads: { feature: 'comments', scenario: 'comments.identifiers' },
  comments: { feature: 'comments', scenario: 'comments.identifiers' },
  imports: {
    feature: null,
    scenario: null,
    pending:
      'imports are a later phase (05 §6.2): DEP names no feature for them, so no server can announce the route',
  },
};

/**
 * Whether an operation is addressed by a bare identifier of a document's resource: its path has a
 * parameter, does not start at `/documents/{id}`, and a user token may call it. A route for the
 * service credential alone (a webhook) is a resource of the tenant, not of a document, so no token
 * of another document can reach it; PRO-045 criterion 3 covers it.
 */
export function isBareIdentifierOperation(o: {
  readonly path: string;
  readonly security: readonly string[];
}): boolean {
  return o.path.includes('{') && !o.path.startsWith('/documents/') && o.security.includes('user');
}

/** Every bare-identifier route of the protocol definition, with its feature and its scenario. */
export function bareRoutes(): BareRoute[] {
  return DEP1.operations.filter(isBareIdentifierOperation).map((o) => {
    const resource = o.path.split('/')[1] ?? '';
    const known = BY_RESOURCE[resource];
    return {
      operation: `${o.method} ${o.path}`,
      ...(known ?? {
        feature: null,
        scenario: null,
        pending: `the kit's table has no entry for /${resource} (PRO-045)`,
      }),
    };
  });
}

/**
 * The bare-identifier routes a server with these features offers for which the kit has no
 * cross-document scenario. A run against such a server must fail (PRO-045 criterion 4).
 */
export function untestedBareRoutes(
  features: ReadonlySet<string>,
  routes: readonly BareRoute[] = bareRoutes(),
): BareRoute[] {
  return routes.filter((r) => r.feature !== null && features.has(r.feature) && r.scenario === null);
}
