/**
 * The deterministic commit identifier of a server-authored commit (SYN-030 criterion 3; 04 §10;
 * 06 §3; ADR 0377, proposed). The control plane writes a request to the outbox with this identifier,
 * so a retry of the same request carries the same one: the outbox keeps one item for it, and the
 * room applies the commit once, however often the item is delivered.
 *
 * The identifier is the first 16 bytes of SHA-256 over the length-prefixed parts, with the version
 * (7) and variant bits of RFC 9562 set, so that it passes the identifier check of a commit (UUID
 * version 7). Its first 48 bits are hash bits, not a time: nothing reads the time of a server-authored
 * commit's identifier (the log's order is `seq`).
 *
 * The caller chooses the parts. They must name the operation and what it relied on (the tenant,
 * the document, the requesting user and the head it was authorised against, with the values or the
 * content hash), so that the same request gives the same identifier and a later request, made after
 * the document moved, gives another.
 */
import { createHash } from 'node:crypto';

export function derivedCommitId(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update('docedit/commit-id/v1');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  const b = hash.digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** JSON with the keys of every object in order, so that equal values give equal text. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
