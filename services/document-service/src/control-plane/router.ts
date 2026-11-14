/**
 * Routes of the control plane, taken from the protocol definition itself (`DEP1.operations`), so
 * that the credentials, the If-Match rule and the body shape of every route are the published ones
 * (05 §6.2; PRO-002). Paths are relative to the `rest` base; discovery is at the endpoint.
 */
import { DEP1 } from '@docedit/protocol';
import type { definition } from '@docedit/protocol';

export type OperationDef = definition.OperationDef;

export interface RouteMatch {
  op: OperationDef;
  params: Record<string, string>;
}

interface Compiled {
  op: OperationDef;
  re: RegExp;
  names: string[];
  /** Fewer parameters first, so that `/documents/{id}/assets/resolve` is not taken for less. */
  weight: number;
}

function compile(op: OperationDef): Compiled {
  const names: string[] = [];
  const pattern = op.path
    .split('/')
    .map((seg) => {
      const m = /^\{(\w+)\}$/.exec(seg);
      if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(m[1]!);
      return '([^/]+)';
    })
    .join('/');
  return { op, re: new RegExp(`^${pattern}$`), names, weight: names.length };
}

export class Router {
  readonly #rest: Compiled[];
  readonly #endpoint: Compiled[];

  constructor(operations: readonly OperationDef[] = DEP1.operations) {
    const all = operations.map(compile).sort((a, b) => a.weight - b.weight);
    this.#rest = all.filter((c) => c.op.base !== 'endpoint');
    this.#endpoint = all.filter((c) => c.op.base === 'endpoint');
  }

  /** The operation for a method and a path relative to the `rest` base (or the endpoint). */
  match(method: string, path: string, base: 'rest' | 'endpoint'): RouteMatch | 'method' | null {
    let pathMatched = false;
    for (const c of base === 'rest' ? this.#rest : this.#endpoint) {
      const m = c.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (c.op.method !== method) continue;
      const params: Record<string, string> = {};
      c.names.forEach((n, i) => {
        params[n] = decodeURIComponent(m[i + 1]!);
      });
      return { op: c.op, params };
    }
    return pathMatched ? 'method' : null;
  }

  /** The methods defined for a path, for preflights. */
  methods(path: string, base: 'rest' | 'endpoint'): string[] {
    return (base === 'rest' ? this.#rest : this.#endpoint)
      .filter((c) => c.re.test(path))
      .map((c) => c.op.method);
  }
}
