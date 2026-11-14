/** Named shapes reachable from a set of root shapes, in definition order. */
import type { DepDefinition } from '../definition/extension.ts';
import { walkShape } from '../definition/index.ts';
import type { NamedShape, Shape } from '../definition/shapes.ts';

export function reachable(def: DepDefinition, roots: readonly Shape[]): NamedShape[] {
  const byName = new Map(def.shapes.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    walkShape(queue.pop()!, (s) => {
      if (s.kind === 'ref' && !seen.has(s.name)) {
        seen.add(s.name);
        const target = byName.get(s.name);
        if (target) queue.push(target.shape);
      }
    });
  }
  return def.shapes.filter((s) => seen.has(s.name));
}
