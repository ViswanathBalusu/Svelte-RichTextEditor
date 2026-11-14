/**
 * The divergence check's message (04 §13; SYN-043). The room is synchronous and this package reads
 * no clock, so a hash is computed by the caller with these functions, which are async because
 * SHA-256 is WebCrypto's (FND-005). The room's part is the `sync.check` message type in `types.ts`.
 *
 * "Canonical form of the durable document" is taken as the CDM canonical form of the document node
 * (`canonicalNode`, 03 §2) serialised by RFC 8785 and hashed with SHA-256, as the engine fixtures
 * and the room's own tests hash a document. That choice is recorded in SYN-043's Notes.
 */
import { canonicalize, canonicalNode, sha256Hex, type JsonNode } from '@docedit/model';
import type { Node } from 'prosemirror-model';
import type { ToClient } from './types.ts';

export type SyncCheck = Extract<ToClient, { t: 'sync.check' }>;

/** SHA-256 (lower-case hex) of the canonical form of a document, as the divergence check hashes it. */
export function documentCanonicalHash(doc: Node): Promise<string> {
  return sha256Hex(canonicalize(canonicalNode(doc.toJSON() as JsonNode)));
}

/** The `sync.check` message for the durable document at `seq` (04 §13). */
export async function syncCheck(seq: number, doc: Node): Promise<SyncCheck> {
  return { t: 'sync.check', seq, hash: await documentCanonicalHash(doc) };
}
