/**
 * Mentions in a comment body (13 §5; PRO-060 criterion 4). The body of a comment is opaque to the
 * service (gap G71); a mention is a node `{ "type": "mention", "principal": "user:<sub>" }` or
 * `group:<id>`, the node the editor's mention picker inserts (packages/ui, UX-031). The service
 * reads those nodes wherever they lie in the body and raises `dep.comment.mentioned` once for each
 * distinct principal, so that the host sends the notification (decision in
 * docs/adr/0375-w5-PRO-060-comment-mentions.md, proposed).
 */

/** A principal as the mention picker writes it: `user:<sub>` or `group:<id>`, no whitespace. */
const PRINCIPAL = /^(user|group):\S+$/;

/** The distinct principals mentioned in a comment body, in order of first appearance. */
export function mentionsOf(body: unknown): string[] {
  const found = new Set<string>();
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      // Pushed in reverse, so that the first item is read first.
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    const o = node as Record<string, unknown>;
    const principal = o['principal'];
    if (o['type'] === 'mention' && typeof principal === 'string' && PRINCIPAL.test(principal))
      found.add(principal);
    const values = Object.values(o);
    for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
  }
  return [...found];
}
